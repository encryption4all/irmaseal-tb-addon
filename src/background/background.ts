//import { toDataURL } from 'qrcode'
//import { ComposeMail, ReadMail } from '@e4a/irmaseal-mail-utils'
//import * as IrmaCore from '@privacybydesign/irma-core'
//import * as IrmaClient from '@privacybydesign/irma-client'
//import * as IrmaConsole from '@privacybydesign/irma-console'

import { createMIMETransform, toEmail, withTransform } from './utils'

declare const browser, messenger

const WIN_TYPE_COMPOSE = 'messageCompose'
//const HOSTNAME = 'https://main.irmaseal-pkg.ihub.ru.nl'
const HOSTNAME = 'http://localhost:8087'
const EMAIL_ATTRIBUTE_TYPE = 'pbdf.sidn-pbdf.email.email'

const i18n = (key: string) => browser.i18n.getMessage(key)

console.log('[background]: irmaseal-tb started.')
console.log('[background]: loading wasm module and retrieving master public key.')

const pk_promise: Promise<string> = fetch(`${HOSTNAME}/v2/parameters`)
    .then((resp) => resp.json().then((o) => o.public_key))
    .catch((e) => console.log(`failed to retrieve public key: ${e.toString()}`))

const mod_promise = import('@e4a/irmaseal-wasm-bindings')

const [pk, mod] = await Promise.all([pk_promise, mod_promise])

// Keeps track of which tabs (messageCompose type) should use encryption.
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
} = {}

// Keeps track of decryptions state (per message).
const decryptState: {
    [messageId: number]: {
        guess: any
        timestamp: number
        unsealer: any
        recipientId?: string
        usk?: string
        readable?: ReadableStream<Uint8Array>
        writable?: WritableStream<Uint8Array>
        allWritten?: Promise<void>
    }
} = {}

messenger.NotifyTools.onNotifyBackground.addListener(async (msg) => {
    console.log('[background]: received command: ', msg.command)
    if (msg.data) console.log('[background]: data len: ', msg.data.length)
    switch (msg.command) {
        case 'enc_start': {
            try {
                const { policies, readable, writable, allWritten, details } = composeTabs[msg.tabId]
                if (!policies || !readable || !writable || !allWritten || !details)
                    throw Error('unexpected')

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
            console.log('current decryptState: ', decryptState)
            const msgId = msg.msgId

            let listener: EventListener
            console.log('setup listener')
            const readable = new ReadableStream<Uint8Array>({
                start: (controller) => {
                    listener = messenger.NotifyTools.onNotifyBackground.addListener(
                        async (msg2: { command: string; data: string }) => {
                            switch (msg2.command) {
                                case 'dec_ct': {
                                    const array = Buffer.from(msg2.data, 'base64')
                                    controller.enqueue(array)
                                    return
                                }
                                case 'dec_finalize': {
                                    controller.close()
                                    return
                                }
                            }
                        }
                    )
                },
                cancel: () => {
                    console.log('removing listener')
                    messenger.NotifyTools.onNotifyBackground.removeListener(listener)
                },
            })

            decryptState[msgId] = {
                ...decryptState[msgId],
                readable,
            }

            return
        }
        case 'dec_metadata': {
            console.log('current decryptState: ', decryptState)
            const msgId = msg.msgId
            const { readable } = decryptState[msg.msgId]
            if (!readable) return

            console.log('starting to read from readable')
            const unsealer = await new mod.Unsealer(readable)
            console.log('got metadata')

            await messenger.NotifyTools.notifyExperiment({
                command: 'dec_session_start',
            })

            const currMsg = await browser.messages.get(msg.msgId)
            const accountId = currMsg.folder.accountId
            const defaultIdentity = await browser.identities.getDefault(accountId)
            const recipientId = toEmail(defaultIdentity.email)
            const hiddenPolicy = unsealer.get_hidden_policies()

            console.log(
                `accountId: ${accountId}\nrecepientId: ${recipientId}\nhiddenPolicy: ${hiddenPolicy}`
            )

            const guess = {
                con: [{ t: EMAIL_ATTRIBUTE_TYPE, v: recipientId }],
            }
            const ts = hiddenPolicy[recipientId].ts

            const window = await messenger.windows.create({
                url: 'decryptPopup.html',
                type: 'popup',
                height: 400,
                width: 400,
            })

            let popupListener, tabClosedListener
            const uskPromise = new Promise<string>((resolve, reject) => {
                popupListener = browser.runtime.onMessage.addListener((msg, sender) => {
                    if (msg.command === 'popup_init') {
                        return Promise.resolve({ guess, timestamp: ts, hostname: HOSTNAME })
                    } else if (msg.command === 'popup_done') {
                        if (msg.usk) resolve(msg.usk)
                        else reject(msg.error)
                        return Promise.resolve()
                    }
                    return false
                })
                tabClosedListener = browser.windows.onRemoved.addListener((windowId: number) => {
                    if (windowId === window.id) reject('window closed')
                })
            })

            try {
                const usk = await uskPromise
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

                decryptState[msg.msgId] = {
                    ...decryptState[msg.msgId],
                    unsealer,
                    recipientId,
                    usk,
                    writable,
                    allWritten,
                }

                console.log(decryptState[msg.msgId])

                await messenger.NotifyTools.notifyExperiment({
                    command: 'dec_session_complete',
                })
            } catch (e) {
                console.log('error during dec_metadata')
                await cleanupDecryptState(msg.msgId)
                await messenger.NotifyTools.notifyExperiment({
                    command: 'dec_aborted',
                    error: e.message,
                })
            } finally {
                await browser.runtime.onMessage.removeListener(popupListener)
                await browser.windows.onRemoved.removeListener(tabClosedListener)
            }

            return
        }

        case 'dec_start': {
            console.log('current decryptState: ', decryptState)
            const msgId = msg.msgId
            try {
                const { unsealer, recipientId, writable, allWritten, usk } = decryptState[msg.msgId]
                if (!unsealer || !recipientId || !writable || !allWritten || !usk)
                    throw Error('unexpected')

                await unsealer.unseal(recipientId, usk, writable)
                await allWritten
                await messenger.NotifyTools.notifyExperiment({
                    command: 'dec_finished',
                })
            } catch (e) {
                console.log('something went wrong during unsealing: ', e.message)
                await messenger.NotifyTools.notifyExperiment({
                    command: 'dec_aborted',
                    error: e.message,
                })
            } finally {
                await cleanupDecryptState(msg.msgId)
            }

            console.log('decryption completed: ', decryptState)

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

// Keep track of all the compose tabs created.
browser.tabs.onCreated.addListener(async (tab) => {
    console.log('[background]: tab opened: ', tab)
    const win = await browser.windows.get(tab.windowId)

    // Check the windowType of the tab.
    if (win.type === WIN_TYPE_COMPOSE) {
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

        // Register the tab
        composeTabs[tab.id] = {
            encrypt: true,
            notificationId,
            tab,
            details: undefined,
            readable: undefined,
            writable: undefined,
            policies: undefined,
            allWritten: undefined,
        }
    }
})

async function cleanupDecryptState(msgId: number) {
    if (msgId in decryptState) {
        delete decryptState[msgId]
    }
}

// Remove tab if it was closed.
browser.tabs.onRemoved.addListener((tabId: number) => {
    console.log(`[background]: tab with id ${tabId} removed`)
    if (tabId in composeTabs) {
        delete composeTabs[tabId]
    }
})

// Watch for outgoing mails.
browser.compose.onBeforeSend.addListener(async (tab, details) => {
    console.log('[background]: onBeforeSend: ', tab, details)
    if (!composeTabs[tab.id].encrypt) return

    const timestamp = Math.round(Date.now() / 1000)
    const policies = details.to.reduce((total, recipient) => {
        const recipient_id = toEmail(recipient)
        total[recipient_id] = {
            ts: timestamp,
            c: [{ t: EMAIL_ATTRIBUTE_TYPE, v: recipient_id }],
        }
        return total
    }, {})

    let listener: EventListener
    const readable = new ReadableStream<Uint8Array>({
        start: (controller) => {
            listener = messenger.NotifyTools.onNotifyBackground.addListener(async (msg2) => {
                switch (msg2.command) {
                    case 'enc_plain': {
                        const encoded: Uint8Array = new TextEncoder().encode(msg2.data)
                        controller.enqueue(encoded)
                        break
                    }
                    case 'enc_finalize': {
                        controller.close()
                        break
                    }
                }
            })
        },
        cancel: () => {
            console.log('[background]: removing listener for plaintext chunks')
            messenger.NotifyTools.onNotifyBackground.removeListener(listener)
        },
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

    composeTabs[tab.id] = {
        ...composeTabs[tab.id],
        details,
        policies,
        readable,
        writable,
        allWritten,
    }

    // Set the setSecurityInfo (triggering our custom MIME encoder)
    console.log('[background]: setting SecurityInfo')
    await browser.irmaseal4tb.setSecurityInfo(tab.windowId, tab.id)
})

//// Register a message display script
//await browser.messageDisplayScripts.register({
//    js: [{ file: 'message-content-script.js' }],
//    css: [{ file: 'message-content-styles.css' }],
//})
//
//// communicate with message display script
//await browser.runtime.onConnect.addListener((port) => {
//    console.log('[background]: got connection: ', port)
//    port.onMessage.addListener(async (message, sender) => {
//        console.log('[background]: received message: ', message, sender)
//        if (!message || !('command' in message)) return
//        const {
//            sender: {
//                tab: { id: tabId },
//            },
//        } = sender
//        switch (message.command) {
//            case 'queryMailDetails': {
//                const currentMsg = await browser.messageDisplay.getDisplayedMessage(tabId)
//                const fullParts = await browser.messages.getFull(currentMsg.id)
//
//                if (!isIRMASeal(fullParts)) {
//                    return { sealed: false }
//                }
//
//                console.log('message was encrypted with irmaseal')
//
//                const mime = await browser.messages.getRaw(currentMsg.id)
//                const readMail = new ReadMail()
//                readMail.parseMail(mime)
//                const ct = readMail.getCiphertext()
//
//                const accountId = currentMsg.folder.accountId
//                console.log('accountId: ', accountId)
//                const defaultIdentity = await browser.identities.getDefault(accountId)
//                const recipient_id = toEmail(defaultIdentity.email)
//                console.log('recipient_id: ', recipient_id)
//
//                const readable: ReadableStream = readableStreamFromArray(ct)
//                const unsealer = await new mod.Unsealer(readable)
//
//                const hidden = unsealer.get_hidden_policies()
//                console.log('hidden policies: ', hidden)
//
//                const attribute = {
//                    type: hidden[recipient_id].c[0].t,
//                    value: hidden[recipient_id].c[0].v,
//                }
//
//                const guess = {
//                    con: [{ t: EMAIL_ATTRIBUTE_TYPE, v: recipient_id }],
//                }
//
//                decryptState[currentMsg.id] = {
//                    guess,
//                    timestamp: hidden[recipient_id].t,
//                    unsealer,
//                    id: recipient_id,
//                }
//
//                port.postMessage({
//                    command: 'mailDetails',
//                    args: {
//                        sealed: true,
//                        messageId: currentMsg.id,
//                        sender: currentMsg.author,
//                        identity: attribute,
//                    },
//                })
//                break
//            }
//            case 'startSession': {
//                const { guess, timestamp, unsealer, id } = decryptState[message.args.messageId]
//
//                const irma = new IrmaCore({
//                    debugging: true,
//                    session: {
//                        url: HOSTNAME,
//                        start: {
//                            url: (o) => `${o.url}/v2/request`,
//                            method: 'POST',
//                            headers: { 'Content-Type': 'application/json' },
//                            body: JSON.stringify(guess),
//                        },
//                        mapping: {
//                            sessionPtr: (r) => {
//                                toDataURL(JSON.stringify(r.sessionPtr)).then((dataURL) => {
//                                    port.postMessage({
//                                        command: 'showQr',
//                                        args: { qrData: dataURL },
//                                    })
//                                })
//
//                                return r.sessionPtr
//                            },
//                        },
//                        result: {
//                            url: (o, { sessionToken: token }) =>
//                                `${o.url}/v2/request/${token}/${timestamp?.toString()}`,
//                        },
//                    },
//                })
//
//                irma.use(IrmaClient)
//                irma.start()
//                    .then(async (r) => {
//                        const usk = r.key
//
//                        let plain = new Uint8Array(0)
//                        const writable = new WritableStream({
//                            write(chunk) {
//                                plain = new Uint8Array([...plain, ...chunk])
//                            },
//                        })
//
//                        await unsealer.unseal(id, usk, writable)
//                        const mail: string = new TextDecoder().decode(plain)
//
//                        port.postMessage({
//                            command: 'showDecryption',
//                            args: { mail: mail },
//                        })
//                    })
//                    .catch((err) => {
//                        console.log('Error during decryption: ', err)
//                    })
//
//                break
//            }
//            case 'cancelSession': {
//                console.log('[background]: received cancel command')
//                // TODO: Either cancel the session or decryptState it for later
//                break
//            }
//        }
//        return null
//    })
//})
