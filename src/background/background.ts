import { createMIMETransform, toEmail, withTransform, hashString, withTimeout } from './../utils'

const DEFAULT_ENCRYPT_ON = false
const WIN_TYPE_COMPOSE = 'messageCompose'
const PKG_URL = 'https://stable.irmaseal-pkg.ihub.ru.nl'
const EMAIL_ATTRIBUTE_TYPE = 'pbdf.sidn-pbdf.email.email'
const SENT_COPY_FOLDER = 'PostGuard Sent'
const RECEIVED_COPY_FOLDER = 'PostGuard Received'
const PK_KEY = 'pg-pk'
const POSTGUARD_SUBJECT = 'PostGuard Encrypted Email'

const i18n = (key: string) => browser.i18n.getMessage(key)

console.log('[background]: postguard-tb-addon started.')
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
        details?: any
        policies?: any
        readable?: ReadableStream<Uint8Array>
        writable?: WritableStream<string>
        allWritten?: Promise<void>
        copyFolder?: Promise<string>
    }
} = await (
    await browser.tabs.query({ type: WIN_TYPE_COMPOSE })
).reduce(async (tabs, tab) => {
    const barId = await addBar(tab)
    return { ...tabs, [tab.id]: { encrypt: DEFAULT_ENCRYPT_ON, tab, barId } }
}, {})

// Keeps track of decryptions state (per message).
const decryptState: {
    [messageId: number]: {
        unsealer?: any
        recipientId?: string
        usk?: string
        readable?: ReadableStream<Uint8Array>
        writable?: WritableStream<Uint8Array>
        allWritten?: Promise<void>
    }
} = {}

// Keeps track of currently selected messages.
let currSelectedMessages: number[] = await (
    await browser.tabs.query({ mailTab: true })
).reduce((currIds, nextTab) => {
    return browser.mailTabs
        .getSelectedMessages(nextTab.id)
        .then((messages) => messages.map((s) => s.id))
        .then((selIds) => [...currIds, ...selIds])
        .catch(() => [])
}, [])

// Previous selection time of folders and messages.
// We track this because sometimes opening a folder automatically selects a message.
let lastSelectFolder = 0
let lastSelectMessage = Number.MAX_SAFE_INTEGER

console.log('[background]: startup composeTabs: ', Object.keys(composeTabs))
console.log('[background]: startup currSelectedMessages: ', currSelectedMessages)

// Run the cleanup every 10 minutes.
setInterval(cleanUp, 600000)

messenger.NotifyTools.onNotifyBackground.addListener(async (msg) => {
    console.log('[background]: received command: ', msg.command)
    if (msg.data) console.log('[background]: data len: ', msg.data.length)
    switch (msg.command) {
        case 'enc_start':
            await enc_start_handler(msg)
            break
        case 'dec_init':
            await dec_init_handler(msg)
            break
        case 'dec_metadata':
            await dec_metadata_handler(msg)
            break
        case 'dec_start':
            await dec_start_handler(msg)
            break
        case 'dec_copy_complete':
            await dec_copy_complete_handler(msg)
            break
    }
    return
})

// Watch for outgoing mails. The encryption process starts here and is further handled by `enc_start_handler`.
browser.compose.onBeforeSend.addListener(async (tab, details) => {
    console.log('[background]: onBeforeSend: ', tab, details)
    if (!composeTabs[tab.id].encrypt) return

    const originalSubject = details.subject
    details.subject = POSTGUARD_SUBJECT

    if (!details.isPlainText) details.plainTextBody = null
    else details.body = null

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

    const mailId = await browser.identities.get(details.identityId)
    const copyFolder = getCopyFolder(mailId.accountId, SENT_COPY_FOLDER)

    const timestamp = Math.round(Date.now() / 1000)
    const policies = [...details.to, ...details.cc].reduce((total, recipient) => {
        const recipient_id = toEmail(recipient)
        total[recipient_id] = {
            ts: timestamp,
            con: [{ t: EMAIL_ATTRIBUTE_TYPE, v: recipient_id }],
        }
        return total
    }, {})

    let listener
    let readable: ReadableStream<Uint8Array> | undefined

    const closed = new Promise<void>((resolve) => {
        readable = new ReadableStream<Uint8Array>({
            start: (controller) => {
                listener = async (msg2) => {
                    switch (msg2.command) {
                        case 'enc_plain': {
                            const encoded: Uint8Array = new TextEncoder().encode(msg2.data)
                            controller.enqueue(encoded)
                            break
                        }
                        case 'enc_finalize': {
                            controller.close()
                            resolve()
                            break
                        }
                    }
                }
                messenger.NotifyTools.onNotifyBackground.addListener(listener)
            },
        })
    })

    closed.then(() => {
        console.log('[background]: removing listener for plaintext chunks')
        messenger.NotifyTools.onNotifyBackground.removeListener(listener)
    })

    let writable: WritableStream<string> | undefined
    const allWritten: Promise<void> = new Promise((resolve) => {
        writable = new WritableStream<string>({
            write: async (chunk: string) => {
                await messenger.NotifyTools.notifyExperiment({
                    command: 'enc_ct',
                    data: chunk,
                })
            },
            close: resolve,
        })
    })

    const currComposeTabs = composeTabs[tab.id]
    composeTabs[tab.id] = Object.assign({}, currComposeTabs, {
        details,
        policies,
        readable,
        writable,
        allWritten,
        copyFolder,
    })

    // Set the setSecurityInfo (triggering our custom MIME encoder)
    console.log('[background]: setting SecurityInfo')
    await browser.pg4tb.setSecurityInfo(tab.windowId, tab.id, originalSubject)

    return { cancel: false, details }
})

async function enc_start_handler(msg) {
    try {
        const { policies, readable, writable, allWritten, details, copyFolder } =
            composeTabs[msg.tabId]
        if (!policies || !readable || !writable || !allWritten || !details || !copyFolder)
            throw new Error('unexpected')

        copyFolder
            .then((folder) => {
                messenger.NotifyTools.notifyExperiment({
                    command: 'enc_copy_folder',
                    folder,
                })
            })
            .catch((e) => {
                console.log(
                    `[background]: unable to create folder for copy of unencrypted messages: ${e.message}`
                )
            })

        const mimeTransform: TransformStream<Uint8Array, string> = createMIMETransform(
            toEmail(details.from)
        )

        await mod.seal(pk, policies, readable, withTransform(writable, mimeTransform))
        await allWritten
        await messenger.NotifyTools.notifyExperiment({ command: 'enc_finished' })
    } catch (e) {
        console.log('something went wrong during sealing: ', e)
        await messenger.NotifyTools.notifyExperiment({
            command: 'enc_aborted',
            error: e.message,
        })
    }

    // cleanup is performed by browser.tabs.onRemoved
}

async function dec_init_handler(msg) {
    try {
        if (Object.keys(decryptState).length > 0) throw new Error('already decrypting a message')
        if (currSelectedMessages.length > 1) throw new Error('more than one message selected')
        if (!currSelectedMessages.includes(msg.msgId))
            throw new Error('only decrypting selected messages')
        if (lastSelectMessage - lastSelectFolder < 50)
            throw new Error('automatic message selection')

        const mail = await browser.messages.get(msg.msgId)
        const folder = mail.folder
        if (folder['type'] !== 'inbox')
            throw Error('only decrypting messages in inbox type folders')

        let listener
        let readable: ReadableStream<Uint8Array> | undefined
        const closed = new Promise<void>((resolve) => {
            readable = new ReadableStream<Uint8Array>({
                start: (controller) => {
                    listener = async (msg2: { command: string; msgId: number; data: string }) => {
                        if (msg.msgId !== msg2.msgId) return
                        switch (msg2.command) {
                            case 'dec_ct': {
                                const array = Buffer.from(msg2.data, 'base64')
                                controller.enqueue(array)
                                return
                            }
                            case 'dec_finalize': {
                                controller.close()
                                resolve()
                                return
                            }
                        }
                    }
                    messenger.NotifyTools.onNotifyBackground.addListener(listener)
                },
            })
        })

        closed.then(() => {
            console.log('[background]: readable closed, removing listener')
            messenger.NotifyTools.onNotifyBackground.removeListener(listener)
        })

        decryptState[msg.msgId] = {
            readable,
        }
    } catch (e) {
        // Do not notify the user as this 'dec_init' can be triggered in the background.
        // Also, do not reset for the same resason.
        await failDecryption(msg.msgId, e, false, false)
    }
}

async function dec_metadata_handler(msg) {
    try {
        const { readable } = decryptState[msg.msgId]
        if (!readable) throw new Error('not initialized')

        const unsealer = await mod.Unsealer.new(readable)

        await messenger.NotifyTools.notifyExperiment({
            command: 'dec_session_start',
            msgId: msg.msgId,
        })

        const currMsg = await browser.messages.get(msg.msgId)
        const accountId = currMsg.folder.accountId
        const defaultIdentity = await browser.identities.getDefault(accountId)
        const recipientId = toEmail(defaultIdentity.email)
        const hiddenPolicy = unsealer.get_hidden_policies()
        const sender = currMsg.author

        console.log(`[background]: accountId: ${accountId}, recipientId: ${recipientId}\n`)

        getCopyFolder(accountId, RECEIVED_COPY_FOLDER)
            .then((folder) => {
                messenger.NotifyTools.notifyExperiment({
                    command: 'dec_copy_folder',
                    folder,
                    msgId: msg.msgId,
                })
            })
            .catch((e) => {
                console.log(
                    `[background]: unable to create folder for decrypted messages: ${e.message}. Falling back to decrypting in INBOX`
                )
            })

        const myPolicy = hiddenPolicy[recipientId]
        if (!myPolicy) throw new Error('recipient identifier not found in header')
        myPolicy.con = myPolicy.con.map(({ t, v }) => {
            if (t === EMAIL_ATTRIBUTE_TYPE) return { t, v: recipientId }
            return { t, v }
        })

        const usk = await checkLocalStorage(myPolicy, PKG_URL).catch((e) =>
            createSessionPopup(myPolicy, toEmail(sender), recipientId)
        )

        let writable: WritableStream<Uint8Array> | undefined
        const allWritten = new Promise<void>((resolve, reject) => {
            writable = new WritableStream<Uint8Array>({
                write: async (chunk: Uint8Array) => {
                    const decoded = new TextDecoder().decode(chunk)
                    await messenger.NotifyTools.notifyExperiment({
                        command: 'dec_plain',
                        msgId: msg.msgId,
                        data: decoded,
                    })
                },
                close: resolve,
                abort: reject,
            })
        })

        const currState = decryptState[msg.msgId]
        decryptState[msg.msgId] = Object.assign({}, currState, {
            unsealer,
            recipientId,
            usk,
            writable,
            allWritten,
        })

        // make sure a folder for the plaintext exists
        await messenger.NotifyTools.notifyExperiment({
            command: 'dec_session_complete',
            msgId: msg.msgId,
        })
    } catch (e) {
        failDecryption(msg.msgId, e, !e.message.includes('tab closed'))
    }
}

async function dec_start_handler(msg) {
    try {
        const { unsealer, recipientId, writable, allWritten, usk } = decryptState[msg.msgId]
        if (!unsealer || !recipientId || !writable || !allWritten || !usk)
            throw new Error('unexpected')

        await unsealer.unseal(recipientId, usk, writable)
        await allWritten
        await messenger.NotifyTools.notifyExperiment({
            command: 'dec_finished',
            msgId: msg.msgId,
        })
    } catch (e) {
        console.log('[background]: something went wrong during unsealing: ', e.message)
        await failDecryption(msg.msgId, e)
    }
}

async function dec_copy_complete_handler(msg) {
    try {
        if (!msg.success) throw new Error('copying of the message failed')

        // block until the message is rendered (or already is rendered)
        let listener
        const displayedPromise = new Promise<void>((resolve, reject) => {
            listener = async (tab, message) => {
                console.log('[background]: onMessageDisplayed', tab, message)
                if (message.id in decryptState) resolve()
            }
            browser.messageDisplay.onMessageDisplayed.addListener(listener)
            browser.mailTabs
                .getCurrent()
                .then((tab) => browser.messageDisplay.getDisplayedMessage(tab.id))
                .then((displayed) => {
                    if (displayed && decryptState[msg.msgId] && msg.msgId === displayed.id)
                        resolve()
                })
        })

        await withTimeout(displayedPromise, 500)
            .then(() => console.log('[background]: message is being displayed'))
            .catch((e) => console.log('[background]: message not displayed: ', e.message))

        browser.messageDisplay.onMessageDisplayed.removeListener(listener)

        await browser.messages.delete([msg.msgId], true)
        await browser.pg4tb.displayMessage(msg.newMsgId)
        console.log(`[background]: message deleted, showing new message (id = ${msg.newMsgId})`)

        delete decryptState[msg.msgId]
    } catch (e) {
        console.log('[background]: something went wrong during unsealing: ', e.message)
        await failDecryption(msg.msgId, e)
    }
}

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
    console.log('[background]: tab opened: ', tab)
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

browser.mailTabs.onSelectedMessagesChanged.addListener((tab, selectedMessages) => {
    lastSelectMessage = Date.now()
    currSelectedMessages = selectedMessages.messages.map((m) => m.id)
})

browser.mailTabs.onDisplayedFolderChanged.addListener(() => {
    lastSelectFolder = Date.now()
})

// Remove tab if it was closed.
browser.tabs.onRemoved.addListener((tabId: number) => {
    console.log(`[background]: tab with id ${tabId} removed`)
    if (tabId in composeTabs) {
        delete composeTabs[tabId]
    }
})

// Cleans up the local storage.
async function cleanUp(): Promise<void> {
    const all = await browser.storage.local.get(null)
    const now = Date.now() / 1000
    for (const [hash, val] of Object.entries(all)) {
        if (val) {
            const { encoded, exp } = val as { encoded: string; exp: number }
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

async function failDecryption(
    msgId: number,
    e: Error,
    notifyUser = true,
    resetDecryptState = true
) {
    await messenger.NotifyTools.notifyExperiment({
        command: 'dec_aborted',
        error: e.message,
        msgId,
    })
    if (resetDecryptState && msgId in decryptState) delete decryptState[msgId]
    if (notifyUser) await notifyDecryptionFailed(e)
}

async function notifyDecryptionFailed(e: Error) {
    const activeMailTabs = await browser.tabs.query({ mailTab: true, active: true })
    if (activeMailTabs.length === 1)
        await messenger.notificationbar.create({
            windowId: activeMailTabs[0].windowId,
            label: `Decryption failed: ${e.message}.`,
            placement: 'message',
            style: { margin: '0px' },
            priority: messenger.notificationbar.PRIORITY_CRITICAL_HIGH,
        })
}

// Retrieve folder to keep a seperate plaintext copy of emails.
// If it does not exist, create one.
async function getCopyFolder(accountId: string, folderName: string): Promise<any> {
    const acc = await browser.accounts.get(accountId)
    for (const f of acc.folders) {
        if (f.name === folderName) return f
    }
    const newFolderPromise = browser.folders.create(acc, folderName)

    // Since newFolderPromise can stall indefinitely, we give up after a timeout seconds
    return withTimeout(newFolderPromise, 3000)
}

async function checkLocalStorage(pol: Policy, pkg: string): Promise<string> {
    const serializedCon = JSON.stringify(pol.con)
    const hash = await hashString(serializedCon)

    return browser.storage.local
        .get(hash)
        .then((cached) => {
            if (Object.keys(cached).length === 0) throw new Error('not found in localStorage')
            const jwt = cached[hash]
            if (Date.now() / 1000 > jwt.exp) throw new Error('jwt has expired')

            return fetch(`${pkg}/v2/request/key/${pol.ts.toString()}`, {
                headers: {
                    Authorization: `Bearer ${jwt.encoded}`,
                },
            })
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
        height: 650,
        width: 620,
    })

    const popupId = popupWindow.id

    let popupListener, tabClosedListener
    const uskPromise = new Promise<string>((resolve, reject) => {
        popupListener = (req, sender, sendResponse) => {
            if (sender.tab.windowId == popupId && req && req.command === 'popup_init') {
                return Promise.resolve({
                    hostname: PKG_URL,
                    policy: pol,
                    senderId,
                    recipientId,
                })
            } else if (sender.tab.windowId == popupId && req && req.command === 'popup_done') {
                if (req.usk) resolve(req.usk)
                else reject(new Error('no usk'))
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

    return uskPromise.finally(() => {
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

    return fetch(`${PKG_URL}/v2/parameters`)
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
