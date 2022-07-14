import { ComposeMail } from '@e4a/irmaseal-mail-utils'
import { toEmail, withTimeout, hashCon, generateBoundary } from './../utils'
import jwtDecode, { JwtPayload } from 'jwt-decode'

const DEFAULT_ENCRYPT_ON = false
const WIN_TYPE_COMPOSE = 'messageCompose'
const PKG_URL = 'https://stable.irmaseal-pkg.ihub.ru.nl'
const EMAIL_ATTRIBUTE_TYPE = 'pbdf.sidn-pbdf.email.email'
const SENT_COPY_FOLDER = 'PostGuard Sent'
const RECEIVED_COPY_FOLDER = 'PostGuard Received'
const PK_KEY = 'pg-pk'
const POSTGUARD_SUBJECT = 'PostGuard Encrypted Email'
const MSG_VIEW_THRESHOLD = 250

const i18n = (key: string) => browser.i18n.getMessage(key)

const version: Version = await browser.runtime.getBrowserInfo().then(({ version }) => {
    const parts = version.split('.')
    return {
        raw: version,
        major: parseInt(parts[0]),
        minor: parseInt(parts[1]),
        revision: parts.length > 2 ? parseInt(parts[2]) : 0,
    }
})
const extVersion = await browser.runtime.getManifest()['version']
const headerValue = `Thunderbird,${version.raw},pg4tb,${extVersion}`

console.log(
    `[background]: postguard-tb-addon v${extVersion} started (Thunderbird v${version.raw}).`
)
console.log('[background]: loading wasm module and retrieving master public key.')

const pk_promise: Promise<string> = retrievePublicKey()
const mod_promise = import('@e4a/irmaseal-wasm-bindings')

const [pk, mod] = await Promise.all([pk_promise, mod_promise])

// Keeps track of which tabs (messageCompose type) should use encryption.
// Also, add a bar to any existing compose windows.
const composeTabs: {
    [tabId: number]: {
        tab: any
        encrypt: boolean
        barId: number
        notificationId?: number
    }
} = await (
    await browser.tabs.query({ type: WIN_TYPE_COMPOSE })
).reduce(async (tabs, tab) => {
    const barId = await addBar(tab)
    return { ...tabs, [tab.id]: { encrypt: DEFAULT_ENCRYPT_ON, tab, barId } }
}, {})

// Previous selection time of folders and messages.
// We track this because sometimes opening a folder automatically renders a message.
let lastSelectFolder = 0
let lastTabDeleted = 0
let lastWindowFocused = 0
let lastSelectMessage = 0

console.log('[background]: startup composeTabs: ', Object.keys(composeTabs))

// Run the cleanup every 10 minutes.
setInterval(cleanUp, 600000)

// Watch for outgoing mails. The encryption process starts here.
browser.compose.onBeforeSend.addListener(async (tab, details) => {
    if (!composeTabs[tab.id].encrypt) return

    if (details.bcc.length) {
        if (!composeTabs[tab.id].notificationId) {
            const notificationId = await messenger.notificationbar.create({
                windowId: tab.windowId,
                label: i18n('composeBccWarning'),
                placement: 'top',
                style: { margin: '0px' },
                priority: messenger.notificationbar.PRIORITY_WARNING_HIGH,
            })
            composeTabs[tab.id].notificationId = notificationId
        }
        return { cancel: true }
    }

    const originalSubject = details.subject
    details.subject = POSTGUARD_SUBJECT

    const attachments = await browser.compose.listAttachments(tab.id)
    const date = new Date()

    // Create the inner mime from the details.

    let innerContenType = ''
    let boundary = ''
    let contentType = `${details.isPlainText ? 'text/plain' : 'text/html'}; charset=utf-8`
    const attachmentLen = attachments.length

    if (attachmentLen > 0) {
        innerContenType = contentType
        boundary = generateBoundary()
        contentType = `multipart/mixed; boundary="${boundary}"`
    }

    let innerMime = ''
    innerMime += `Date: ${date.toUTCString()}\r\n`
    innerMime += 'MIME-Version: 1.0\r\n'
    innerMime += `To: ${String(details.to)}\r\n`
    innerMime += `From: ${String(details.from)}\r\n`
    innerMime += `Subject: ${originalSubject}\r\n`
    if (details.cc.length > 0) innerMime += `Cc: ${String(details.cc)}\r\n`
    innerMime += `Content-Type: ${contentType}\r\n`
    innerMime += '\r\n'

    let innerBody = details.isPlainText ? details.plainTextBody : details.body
    if (attachmentLen > 0)
        innerBody = `--${boundary}\r\nContent-Type: ${innerContenType}\r\n\r\n${innerBody}\r\n`
    innerMime += innerBody

    const tempFile = await browser.pg4tb.createTempFile()
    const encoder = new TextEncoder()
    const readable = new ReadableStream<Uint8Array>({
        start: async (controller: ReadableStreamController<Uint8Array>) => {
            controller.enqueue(encoder.encode(innerMime))

            await browser.pg4tb.writeToFile(tempFile, innerMime)

            for (const att of attachments) {
                const isLast = att.id === attachments[attachmentLen - 1].id
                const file: File = await browser.compose.getAttachmentFile(att.id)
                const buf = await file.arrayBuffer()
                const b64 = Buffer.from(buf).toString('base64')
                const formatted = b64.replace(/(.{76})/g, '$1\r\n')

                let attMime = ''
                attMime += `--${boundary}\r\nContent-Type: ${file.type}; name="${file.name}"\r\n`
                attMime += `Content-Disposition: attachment; filename="${file.name}"\r\n`
                attMime += `Content-Transfer-Encoding: base64\r\n\r\n`
                attMime += formatted
                attMime += isLast ? `\r\n--${boundary}--\r\n` : '\r\n'

                controller.enqueue(encoder.encode(attMime))
                await browser.pg4tb.writeToFile(tempFile, attMime)
                await browser.compose.removeAttachment(tab.id, att.id)
            }

            controller.close()
        },
    })

    let encrypted = new Uint8Array(0)
    const writable = new WritableStream<Uint8Array>({
        write: (chunk: Uint8Array) => {
            encrypted = new Uint8Array([...encrypted, ...chunk])
        },
    })

    const timestamp = Math.round(date.getTime() / 1000)

    const policies = [...details.to, ...details.cc].reduce((total, recipient) => {
        const recipient_id = toEmail(recipient)
        total[recipient_id] = {
            ts: timestamp,
            con: [{ t: EMAIL_ATTRIBUTE_TYPE, v: recipient_id }],
        }
        return total
    }, {})

    const tEncStart = performance.now()
    await mod.seal(pk, policies, readable, writable)
    console.log(`Encryption took ${performance.now() - tEncStart} ms`)

    // Create the attachment
    const encryptedFile = new File([encrypted], `postguard.encrypted`, {
        type: 'application/postguard; charset=utf-8',
    })

    // Add the encrypted file attachment
    await browser.compose.addAttachment(tab.id, { file: encryptedFile })

    const compose = new ComposeMail()
    compose.setSender(details.from)
    details.deliveryFormat = 'both'
    details.plainTextBody = compose.getPlainText()
    details.body = compose.getHtmlText()

    // Save a copy of the message in the sent folder.
    browser.identities
        .get(details.identityId)
        .then((mailId) => getCopyFolder(mailId.accountId, SENT_COPY_FOLDER))
        .then((copyFolder) => browser.pg4tb.copyFileMessage(tempFile, copyFolder, undefined))
        .catch(() => console.log('failed to create copy in sent folder'))

    return { cancel: false, details }
})

// Listen for notificationbar switch button clicks.
messenger.switchbar.onButtonClicked.addListener(
    async (windowId: number, barId: number, buttonId: string, enabled: boolean) => {
        if (['btn-switch'].includes(buttonId)) {
            const tabId = Object.keys(composeTabs).find((key) => composeTabs[key]?.barId === barId)
            if (tabId) {
                composeTabs[tabId].encrypt = enabled
                // Remove the notification if PostGuard is turned off.
                if (composeTabs[tabId].notificationId && !enabled) {
                    await messenger.notificationbar.clear(composeTabs[tabId].notificationId)
                    composeTabs[tabId].notificationId = undefined
                }
            }
            return { close: false }
        }
    }
)

// Remove the notification on dismiss.
messenger.notificationbar.onDismissed.addListener((windowId, notificationId) => {
    const tabId = Object.keys(composeTabs).find(
        (key) => composeTabs[key]?.notificationId === notificationId
    )
    if (tabId) composeTabs[tabId].notificationId = undefined
})

// Keep track of all the compose tabs created.
browser.tabs.onCreated.addListener(async (tab) => {
    const win = await browser.windows.get(tab.windowId)

    // Check the windowType of the tab.
    if (win.type === WIN_TYPE_COMPOSE) {
        const barId = await addBar(tab)

        // Register the tab.
        composeTabs[tab.id] = {
            encrypt: DEFAULT_ENCRYPT_ON,
            barId,
            tab,
        }
    }
})

// Main decryption code.
browser.messageDisplay.onMessageDisplayed.addListener(async (tab, msg) => {
    const now = Date.now()

    const attachments = await browser.messages.listAttachments(msg.id)
    const filtered = attachments.filter((att) => att.name === 'postguard.encrypted')
    if (filtered.length !== 1) return

    const pgPartName = filtered[0].partName

    if (msg.folder['type'] !== 'inbox') {
        console.log('only decrypting inbox messages')
        return
    }

    // Generally, when a message is displayed too fast after a user action, it is probably
    // not the intention to trigger the decryption.
    // Adjust accordingly.
    if (
        Math.abs(now - lastSelectFolder) < MSG_VIEW_THRESHOLD ||
        Math.abs(now - lastTabDeleted) < MSG_VIEW_THRESHOLD ||
        Math.abs(now - lastWindowFocused) < MSG_VIEW_THRESHOLD ||
        Math.abs(now - lastSelectMessage) > MSG_VIEW_THRESHOLD
    ) {
        console.log('message might not deliberately be selected')
        return
    }

    const file = await browser.messages.getAttachmentFile(msg.id, pgPartName)
    const readable = file.stream()
    const unsealer = await mod.Unsealer.new(readable)
    const accountId = msg.folder.accountId
    const defaultIdentity = await browser.identities.getDefault(accountId)
    const recipientId = toEmail(defaultIdentity.email)
    const hiddenPolicy = unsealer.get_hidden_policies()
    const sender = msg.author

    const myPolicy = hiddenPolicy[recipientId]
    if (!myPolicy) throw new Error('recipient identifier not found in header')

    myPolicy.con = myPolicy.con.map(({ t, v }) => {
        if (t === EMAIL_ATTRIBUTE_TYPE) return { t, v: recipientId }
        return { t, v }
    })

    // Check localStorage, otherwise create a popup to retrieve a JWT.
    const jwt = await checkLocalStorage(myPolicy.con).catch(() =>
        createSessionPopup(myPolicy, toEmail(sender), recipientId).then((encoded) => {
            // Store the fresh JWT.
            const decoded = jwtDecode<JwtPayload>(encoded)
            hashCon(myPolicy.con).then((hash) => {
                browser.storage.local.set({
                    [hash]: { encoded, exp: decoded.exp },
                })
            })
            return encoded
        })
    )

    /// Use the JWT to retrieve a USK.
    const usk = await getUSK(jwt, myPolicy.ts)

    const tempFile = await browser.pg4tb.createTempFile()
    const decoder = new TextDecoder()
    const writable = new WritableStream({
        write: async (chunk: Uint8Array) => {
            const decoded = decoder.decode(chunk, { stream: true })
            await browser.pg4tb.writeToFile(tempFile, decoded)
        },
    })
    const finalDecoded = decoder.decode()
    await browser.pg4tb.writeToFile(tempFile, finalDecoded)

    await unsealer.unseal(recipientId, usk, writable)

    let copyFolder = undefined
    try {
        copyFolder = await getCopyFolder(accountId, RECEIVED_COPY_FOLDER)
    } catch {
        // if no folder is found, just copy in the same folder as the original message.
    }

    const newId = await browser.pg4tb.copyFileMessage(tempFile, copyFolder, msg.id)
    await browser.messageDisplay.open({ messageId: newId })
    await browser.messages.delete([msg.id], true)
})

browser.mailTabs.onSelectedMessagesChanged.addListener(() => {
    lastSelectMessage = Date.now()
})

browser.mailTabs.onDisplayedFolderChanged.addListener(() => {
    lastSelectFolder = Date.now()
})

browser.windows.onFocusChanged.addListener(() => {
    lastWindowFocused = Date.now()
})

// Remove tab if it was closed.
browser.tabs.onRemoved.addListener((tabId: number) => {
    lastTabDeleted = Date.now()
    if (tabId in composeTabs) delete composeTabs[tabId]
})

// Cleans up the local storage.
async function cleanUp(): Promise<void> {
    const all = await browser.storage.local.get(null)
    const now = Date.now() / 1000
    for (const [hash, val] of Object.entries(all)) {
        if (val) {
            const { exp } = val as { encoded: string; exp: number }
            if (now > exp) await browser.storage.local.remove(hash)
        }
    }
}

// Best-effort attempt to detect if darkMode is enabled.
async function detectMode(): Promise<boolean> {
    let darkMode = false
    try {
        const currentTheme = await browser.theme.getCurrent()
        const toolbarHSL = currentTheme.colors.toolbar
        const hslRegExp = /hsl\((\d+),\s*([\d.]+)%,\s*([\d.]+)%\)/gm
        const found = hslRegExp.exec(toolbarHSL)
        if (found && found[3]) {
            darkMode = parseInt(found[3]) < 50
        }
    } catch (e) {
        // fallback to false
    }
    return darkMode
}

async function addBar(tab): Promise<number> {
    const darkMode = await detectMode()

    const lightGreen = '#54D6A7'
    const darkGreen = '#022E3D'
    const white = '#FFFFFF'

    const notificationId = await messenger.switchbar.create({
        enabled: DEFAULT_ENCRYPT_ON,
        windowId: tab.windowId,
        buttonId: 'btn-switch',
        placement: 'top',
        iconEnabled: 'icons/pg_logo.svg',
        iconDisabled: `icons/pg_logo${darkMode ? '' : '_white'}.svg`,
        labels: {
            enabled: i18n('composeSwitchBarEnabledHtml'),
            disabled: i18n('composeSwitchBarDisabledHtml'),
        },
        style: {
            'color-enabled': darkGreen, // text color
            'color-disabled': darkMode ? darkGreen : white,
            'background-color-enabled': lightGreen, // background of bar
            'background-color-disabled': darkMode ? white : darkGreen,
            'slider-background-color-enabled': darkGreen, // background of slider
            'slider-background-color-disabled': darkMode ? darkGreen : white,
            'slider-color-enabled': white, // slider itself
            'slider-color-disabled': darkMode ? white : darkGreen,
        },
    })

    return notificationId
}

//async function notifyDecryptionFailed(e: Error) {
//    const activeMailTabs = await browser.tabs.query({ mailTab: true, active: true })
//    if (activeMailTabs.length === 1)
//        await messenger.notificationbar.create({
//            windowId: activeMailTabs[0].windowId,
//            label: `Decryption failed: ${e.message}.`,
//            placement: 'message',
//            style: { margin: '0px' },
//            priority: messenger.notificationbar.PRIORITY_CRITICAL_HIGH,
//        })
//}

// Retrieve folder to keep a seperate plaintext copy of emails.
// If it does not exist, create one.
async function getCopyFolder(accountId: string, folderName: string): Promise<any> {
    const acc = await browser.accounts.get(accountId)
    for (const f of acc.folders) {
        if (f.name === folderName) return f
    }
    const newFolderPromise = browser.folders.create(acc, folderName)

    // Since newFolderPromise can stall indefinitely, we give up after a timeout.
    return withTimeout(newFolderPromise, 300)
}

// Check localStorage for a conjunction.
async function checkLocalStorage(con: AttributeCon): Promise<string> {
    const hash = await hashCon(con)

    return browser.storage.local.get(hash).then((cached) => {
        if (Object.keys(cached).length === 0) throw new Error('not found in localStorage')
        const jwt = cached[hash]
        if (Date.now() / 1000 > jwt.exp) throw new Error('jwt has expired')
        return jwt.encoded
    })
}

// Retrieve a USK using a JWT and timestamp.
async function getUSK(jwt: string, ts: number): Promise<string> {
    return fetch(`${PKG_URL}/v2/request/key/${ts.toString()}`, {
        headers: {
            Authorization: `Bearer ${jwt}`,
            'X-PostGuard-Client-Version': headerValue,
        },
    })
        .then((r) => r.json())
        .then((json) => {
            if (json.status !== 'DONE' || json.proofStatus !== 'VALID')
                throw new Error('session not DONE and VALId')
            return json.key
        })
}

async function createSessionPopup(
    pol: Policy,
    senderId: string,
    recipientId: string
): Promise<string> {
    const popupWindow = await messenger.windows.create({
        url: 'decryptPopup.html',
        type: 'popup',
        height: 660,
        width: 620,
    })

    const popupId = popupWindow.id
    await messenger.windows.update(popupId, { drawAttention: true, focused: true })

    let popupListener, tabClosedListener
    const jwtPromise = new Promise<string>((resolve, reject) => {
        popupListener = (req, sender) => {
            if (sender.tab.windowId == popupId && req && req.command === 'popup_init') {
                return Promise.resolve({
                    hostname: PKG_URL,
                    policy: pol,
                    senderId,
                    recipientId,
                })
            } else if (sender.tab.windowId == popupId && req && req.command === 'popup_done') {
                if (req.jwt) resolve(req.jwt)
                else reject(new Error('no jwt'))
                return Promise.resolve()
            }
            return false
        }

        tabClosedListener = (windowId: number) => {
            if (windowId === popupId) reject(new Error('tab closed'))
        }
        browser.runtime.onMessage.addListener(popupListener)
        browser.windows.get(popupId).catch((e) => reject(e))
        browser.windows.onRemoved.addListener(tabClosedListener)
    })

    return jwtPromise.finally(() => {
        browser.windows.onRemoved.removeListener(tabClosedListener)
        browser.runtime.onMessage.removeListener(popupListener)
    })
}

// First tries to download the public key from the PKG.
// If this fails, it falls back to a public key in localStorage.
// The public key is stored iff there was no public key or it was different.
// If no public key is found, either through the PKG or localStorage, the promise rejects.
async function retrievePublicKey(): Promise<string> {
    const stored = await browser.storage.local.get(PK_KEY)
    const storedPublicKey = stored[PK_KEY]

    return fetch(`${PKG_URL}/v2/parameters`, {
        headers: { 'X-PostGuard-Client-Version': headerValue },
    })
        .then((resp) =>
            resp.json().then(async ({ publicKey }) => {
                if (storedPublicKey !== publicKey)
                    await browser.storage.local.set({ [PK_KEY]: publicKey })
                return publicKey
            })
        )
        .catch((e) => {
            console.log(
                `[background]: failed to retrieve public key from PKG: ${e.toString()}, falling back to localStorage`
            )
            if (storedPublicKey) return storedPublicKey
            throw new Error('no public key')
        })
}
