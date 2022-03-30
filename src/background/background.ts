import { createMIMETransform, toEmail, withTransform, hashString } from './../utils'

const DEFAULT_ENCRYPT_ON = false
const WIN_TYPE_COMPOSE = 'messageCompose'
const PKG_URL = 'https://main.irmaseal-pkg.ihub.ru.nl'
const EMAIL_ATTRIBUTE_TYPE = 'pbdf.sidn-pbdf.email.email'
const SENT_COPY_FOLDER = 'Cryptify Sent'
const RECEIVED_COPY_FOLDER = 'Cryptify Received'

const i18n = (key: string) => browser.i18n.getMessage(key)

console.log('[background]: irmaseal-tb started.')
console.log('[background]: loading wasm module and retrieving master public key.')

const pk_promise: Promise<string> = fetch(`${PKG_URL}/v2/parameters`)
    .then((resp) => resp.json().then((o) => o.publicKey))
    .catch((e) => console.log(`failed to retrieve public key: ${e.toString()}`))

const mod_promise = import('@e4a/irmaseal-wasm-bindings')

const [pk, mod] = await Promise.all([pk_promise, mod_promise])

// Keeps track of which tabs (messageCompose type) should use encryption.
// Also, add a bar to any existing compose windows.
const composeTabs: {
    [tabId: number]: {
        tab: any
        encrypt: boolean
        notificationId: number
        details?: any
        policies?: any
        readable?: ReadableStream<Uint8Array>
        writable?: WritableStream<string>
        allWritten?: Promise<void>
    }
} = await (
    await browser.tabs.query({ type: WIN_TYPE_COMPOSE })
).reduce(async (tabs, tab) => {
    const notificationId = await addBar(tab)
    return { ...tabs, [tab.id]: { encrypt: true, tab, notificationId } }
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
).reduce(async (currIds, nextTab) => {
    const sel = (await browser.mailTabs.getSelectedMessages(nextTab.id)).messages.map((s) => s.id)
    return currIds.concat(sel)
}, [])

console.log('[background]: startup composeTabs: ', Object.keys(composeTabs))
console.log('[background]: startup currSelectedMessages: ', currSelectedMessages)

// Cleans up the local storage.
async function cleanUp(): Promise<void> {
    const all = await browser.storage.local.get(null)
    console.log('storage', all)
    const now = Date.now() / 1000
    for (const [hash, val] of Object.entries(all)) {
        if (val) {
            const { encoded, exp } = val as { encoded: string; exp: number }
            if (now > exp) await browser.storage.local.remove(hash)
        }
    }
}

// Run the cleanup every 10 minutes.
setInterval(cleanUp, 20000 /* * 60 * 1000*/)

messenger.NotifyTools.onNotifyBackground.addListener(async (msg) => {
    console.log('[background]: received command: ', msg.command)
    if (msg.data) console.log('[background]: data len: ', msg.data.length)
    switch (msg.command) {
        case 'enc_start': {
            try {
                const { policies, readable, writable, allWritten, details } = composeTabs[msg.tabId]
                if (!policies || !readable || !writable || !allWritten || !details)
                    throw new Error('unexpected')

                const mimeTransform: TransformStream<Uint8Array, string> = createMIMETransform()

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
            return
        }
        case 'dec_init': {
            if (Object.keys(decryptState).length > 0) {
                console.log('currently decrypting: ', Object.keys(decryptState))
                await failDecryption(msg.msgId, new Error('already decrypting a message'))
                return
            }

            if (!currSelectedMessages.includes(msg.msgId)) {
                await failDecryption(msg.msgId, new Error('only decrypting selected messages'))
                return
            }

            let listener
            let readable: ReadableStream<Uint8Array> | undefined
            const closed = new Promise<void>((resolve) => {
                readable = new ReadableStream<Uint8Array>({
                    start: (controller) => {
                        listener = async (msg2: {
                            command: string
                            msgId: number
                            data: string
                        }) => {
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

            return
        }
        case 'dec_metadata': {
            const { readable } = decryptState[msg.msgId]
            if (!readable) {
                await failDecryption(msg.msgId, new Error('not initialized'))
                return
            }

            const unsealer = await mod.Unsealer.new(readable)

            await messenger.NotifyTools.notifyExperiment({
                command: 'dec_session_start',
            })

            const currMsg = await browser.messages.get(msg.msgId)
            const accountId = currMsg.folder.accountId
            const defaultIdentity = await browser.identities.getDefault(accountId)
            const recipientId = toEmail(defaultIdentity.email)
            const hiddenPolicy = unsealer.get_hidden_policies()
            const sender = currMsg.author

            console.log(
                `[background]: accountId: ${accountId}\nrecipientId: ${recipientId}\nhiddenPolicy: ${hiddenPolicy}`
            )

            const ts = hiddenPolicy[recipientId].ts
            const myPolicy = hiddenPolicy[recipientId]
            myPolicy.con = myPolicy.con.map(({ t, v }) => {
                if (t === EMAIL_ATTRIBUTE_TYPE) return { t, v: recipientId }
                return { t, v }
            })

            try {
                const usk = await checkLocalStorage(myPolicy, PKG_URL).catch((e) =>
                    createSessionPopup(myPolicy, sender, recipientId)
                )

                let writable: WritableStream<Uint8Array> | undefined
                const allWritten = new Promise<void>((resolve, reject) => {
                    writable = new WritableStream<Uint8Array>({
                        write: async (chunk: Uint8Array) => {
                            const decoded = new TextDecoder().decode(chunk)
                            await messenger.NotifyTools.notifyExperiment({
                                command: 'dec_plain',
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
                await getCopyFolder(accountId, RECEIVED_COPY_FOLDER).catch(() => {})
                await messenger.NotifyTools.notifyExperiment({
                    command: 'dec_session_complete',
                })
            } catch (e) {
                failDecryption(msg.msgId, e)
                return
            }

            return
        }

        case 'dec_start': {
            try {
                const { unsealer, recipientId, writable, allWritten, usk } = decryptState[msg.msgId]
                if (!unsealer || !recipientId || !writable || !allWritten || !usk)
                    throw new Error('unexpected')

                await unsealer.unseal(recipientId, usk, writable)
                await allWritten
                await messenger.NotifyTools.notifyExperiment({
                    command: 'dec_finished',
                })

                if (msg.msgId in decryptState) delete decryptState[msg.msgId]
            } catch (e) {
                console.log('[background]: something went wrong during unsealing: ', e.message)
                await failDecryption(msg.msgId, e)
            }

            return
        }
    }
})

// Listen for notificationbar switch button clicks.
messenger.switchbar.onButtonClicked.addListener(
    async (windowId: number, notificationId: number, buttonId: string, enabled: boolean) => {
        if (['btn-switch'].includes(buttonId)) {
            const tabId = Object.keys(composeTabs).find(
                (key) => composeTabs[key]?.notificationId === notificationId
            )
            if (tabId) {
                composeTabs[tabId].encrypt = enabled
            }
            return { close: false }
        }
    }
)

async function addBar(tab): Promise<number> {
    const notificationId = await messenger.switchbar.create({
        windowId: tab.windowId,
        buttonId: 'btn-switch',
        placement: 'top',
        icon: 'chrome://messenger/skin/icons/privacy-security.svg',
        labels: {
            enabled: i18n('composeNotificationEnabled'),
            disabled: i18n('composeNotificationDisabled'),
        },
        style: {
            'color-enabled': 'white',
            'color-disabled': 'black',
            'background-color-enabled': '#5DCCAB',
            'background-color-disabled': '#EED202',
        },
    })

    return notificationId
}

// Keep track of all the compose tabs created.
browser.tabs.onCreated.addListener(async (tab) => {
    console.log('[background]: tab opened: ', tab)
    const win = await browser.windows.get(tab.windowId)

    // Check the windowType of the tab.
    if (win.type === WIN_TYPE_COMPOSE) {
        const notificationId = await addBar(tab)

        // Register the tab.
        composeTabs[tab.id] = {
            encrypt: DEFAULT_ENCRYPT_ON,
            notificationId,
            tab,
        }
    }
})

browser.mailTabs.onSelectedMessagesChanged.addListener((tab, selectedMessages) => {
    currSelectedMessages = selectedMessages.messages.map((m) => m.id)
    console.log('[background]: currSelectedMessages: ', currSelectedMessages)
})

async function failDecryption(msgId: number, e: Error) {
    await messenger.NotifyTools.notifyExperiment({
        command: 'dec_aborted',
        error: e.message,
    })

    if (msgId in decryptState) delete decryptState[msgId]
}

// Remove tab if it was closed.
browser.tabs.onRemoved.addListener((tabId: number) => {
    console.log(`[background]: tab with id ${tabId} removed`)
    if (tabId in composeTabs) {
        delete composeTabs[tabId]
    }
})

// Retrieve folder to keep a seperate plaintext copy of emails.
// If it does not exist, create one.
async function getCopyFolder(accountId: string, folderName: string): Promise<any> {
    const acc = await browser.accounts.get(accountId)
    for (const f of acc.folders) {
        if (f.name === folderName) return f
    }
    const newFolderPromise = browser.folders.create(acc, folderName)
    const timeout = new Promise(function (resolve, reject) {
        setTimeout(() => reject(new Error('creating folder took too long')), 3000)
    })

    // Since newFolderPromise can stall indefinitely, we give up after a timeout seconds
    return Promise.race([newFolderPromise, timeout])
}

// Watch for outgoing mails.
browser.compose.onBeforeSend.addListener(async (tab, details) => {
    console.log('[background]: onBeforeSend: ', tab, details)
    if (!composeTabs[tab.id].encrypt) return

    const mailId = await browser.identities.get(details.identityId)
    const copySentFolder = await getCopyFolder(mailId.accountId, SENT_COPY_FOLDER)

    const timestamp = Math.round(Date.now() / 1000)
    const policies = details.to.reduce((total, recipient) => {
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
    })

    // Set the setSecurityInfo (triggering our custom MIME encoder)
    console.log('[background]: setting SecurityInfo')
    const { accountId, path } = copySentFolder
    await browser.irmaseal4tb.setSecurityInfo(tab.windowId, tab.id, accountId, path)
})

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
        height: 480,
        width: 420,
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
