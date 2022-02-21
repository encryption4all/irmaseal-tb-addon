import { toDataURL } from 'qrcode'
import { ComposeMail, ReadMail } from '@e4a/irmaseal-mail-utils'
import * as IrmaCore from '@privacybydesign/irma-core'
import * as IrmaClient from '@privacybydesign/irma-client'

import { createMIMETransform, new_readable_stream_from_array } from './utils'

declare const browser, messenger

const WIN_TYPE_COMPOSE = 'messageCompose'
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
        details: any | undefined
        policies: any | undefined
        readable: ReadableStream<Uint8Array> | undefined
        writable: WritableStream<string> | undefined
        allReceived: Promise<void> | undefined
    }
} = {}

// Keeps track of decryptions state (per message).
const decryptState: {
    [messageId: number]: {
        guess: any
        timestamp: number
        unsealer: any
        id: string
    }
} = {}

// Applies a transform in front of a WritableStream.
function withTransform(writable: WritableStream, transform: TransformStream): WritableStream {
    transform.readable.pipeTo(writable)
    return transform.writable
}

messenger.NotifyTools.onNotifyBackground.addListener(async (msg) => {
    console.log('[background]: received command: ', msg)
    switch (msg.command) {
        case 'init': {
            const details = composeTabs[msg.tabId].details

            const timestamp = Math.round(Date.now() / 1000)
            const policies = details.to.reduce((total, recipient) => {
                const recipient_id = toEmail(recipient)
                total[recipient_id] = {
                    ts: timestamp,
                    c: [{ t: EMAIL_ATTRIBUTE_TYPE, v: recipient_id }],
                }
                return total
            }, {})

            // Listen for plaintext chunks.
            console.log('[background]: adding listener for plaintext chunks')
            let listener, readable, writable

            const allReceived: Promise<void> = new Promise((resolve) => {
                readable = new ReadableStream<Uint8Array>({
                    start: (controller) => {
                        listener = messenger.NotifyTools.onNotifyBackground.addListener(
                            async (msg2) => {
                                switch (msg2.command) {
                                    case 'chunk': {
                                        //console.log('[background]: received plaintext chunk: ', msg2)
                                        const encoded: Uint8Array = new TextEncoder().encode(
                                            msg2.data
                                        )
                                        controller.enqueue(encoded)
                                        break
                                    }
                                    case 'finalize': {
                                        console.log('[background]: received finalize')
                                        controller.close()
                                        break
                                    }
                                }
                            }
                        )
                    },
                    cancel: () => {
                        console.log('[background]: removing listener for plaintext chunks')
                        messenger.NotifyTools.onNotifyBackground.removeListener(listener)
                    },
                })

                // Writer that responds with ciphertext chunks.
                writable = new WritableStream<string>({
                    write: async (chunk: string) => {
                        //                        console.log('[background]: responding to chunk with: \n', chunk)
                        await messenger.NotifyTools.notifyExperiment({
                            command: 'ct',
                            data: chunk,
                        })
                    },
                    close: resolve,
                })
            })

            composeTabs[msg.tabId] = {
                ...composeTabs[msg.tabId],
                policies,
                readable,
                writable,
                allReceived,
            }

            return
        }
        case 'start': {
            const { policies, readable, writable, allReceived } = composeTabs[msg.tabId]

            if (!policies || !readable || !writable) return

            try {
                const transform: TransformStream<Uint8Array, string> = createMIMETransform()

                const sealPromise = mod.seal(
                    pk,
                    policies,
                    readable,
                    withTransform(writable, transform)
                )
                await sealPromise
                await allReceived
                await messenger.NotifyTools.notifyExperiment({ command: 'finished' })
            } catch (e) {
                console.log('something went wrong during sealing: ', e)
                await messenger.NotifyTools.notifyExperiment({ command: 'aborted', error: e })
            }

            // cleanup is performed by onRemoved
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
            allReceived: undefined,
        }
    }
})

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

    // Store the details
    composeTabs[tab.id].details = details

    // Set the setSecurityInfo (triggering our custom MIME encoder)
    console.log('[background]: setting SecurityInfo')
    await browser.irmaseal4tb.setSecurityInfo(tab.windowId, tab.id)
    console.log('[background]: securityInfo set')
})

// Register a message display script
await browser.messageDisplayScripts.register({
    js: [{ file: 'message-content-script.js' }],
    css: [{ file: 'message-content-styles.css' }],
})

function toEmail(identity: string): string {
    const regex = /^(.*)<(.*)>$/
    const match = identity.match(regex)
    return match ? match[2] : identity
}

// communicate with message display script
await browser.runtime.onConnect.addListener((port) => {
    console.log('[background]: got connection: ', port)
    port.onMessage.addListener(async (message, sender) => {
        console.log('[background]: received message: ', message, sender)
        if (!message || !('command' in message)) return
        const {
            sender: {
                tab: { id: tabId },
            },
        } = sender
        switch (message.command) {
            case 'queryMailDetails': {
                const currentMsg = await browser.messageDisplay.getDisplayedMessage(tabId)

                // Check if the message is irmaseal encrypted
                const parsedParts = await browser.messages.getFull(currentMsg.id)

                const sealed =
                    parsedParts?.headers['content-type']?.[0]?.includes('application/irmaseal') ??
                    false

                if (!sealed) return { sealed: false }

                const mime = await browser.messages.getRaw(currentMsg.id)
                const readMail = new ReadMail()
                readMail.parseMail(mime)
                const ct = readMail.getCiphertext()

                const accountId = currentMsg.folder.accountId
                console.log('accountId: ', accountId)
                const defaultIdentity = await browser.identities.getDefault(accountId)
                const recipient_id = toEmail(defaultIdentity.email)
                console.log('recipient_id: ', recipient_id)

                const readable: ReadableStream = new_readable_stream_from_array(ct)
                const unsealer = await new mod.Unsealer(readable)

                const hidden = unsealer.get_hidden_policies()
                console.log('hidden policies: ', hidden)

                const attribute = {
                    type: hidden[recipient_id].c[0].t,
                    value: hidden[recipient_id].c[0].v,
                }

                const guess = {
                    con: [{ t: EMAIL_ATTRIBUTE_TYPE, v: recipient_id }],
                }

                decryptState[currentMsg.id] = {
                    guess,
                    timestamp: hidden[recipient_id].t,
                    unsealer,
                    id: recipient_id,
                }

                port.postMessage({
                    command: 'mailDetails',
                    args: {
                        sealed: true,
                        messageId: currentMsg.id,
                        sender: currentMsg.author,
                        identity: attribute,
                    },
                })
                break
            }
            case 'startSession': {
                const { guess, timestamp, unsealer, id } = decryptState[message.args.messageId]

                const irma = new IrmaCore({
                    debugging: true,
                    session: {
                        url: HOSTNAME,
                        start: {
                            url: (o) => `${o.url}/v2/request`,
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(guess),
                        },
                        mapping: {
                            sessionPtr: (r) => {
                                toDataURL(JSON.stringify(r.sessionPtr)).then((dataURL) => {
                                    port.postMessage({
                                        command: 'showQr',
                                        args: { qrData: dataURL },
                                    })
                                })

                                return r.sessionPtr
                            },
                        },
                        result: {
                            url: (o, { sessionToken: token }) =>
                                `${o.url}/v2/request/${token}/${timestamp?.toString()}`,
                        },
                    },
                })

                irma.use(IrmaClient)
                irma.start()
                    .then(async (r) => {
                        const usk = r.key

                        let plain = new Uint8Array(0)
                        const writable = new WritableStream({
                            write(chunk) {
                                plain = new Uint8Array([...plain, ...chunk])
                            },
                        })

                        await unsealer.unseal(id, usk, writable)
                        const mail: string = new TextDecoder().decode(plain)

                        port.postMessage({
                            command: 'showDecryption',
                            args: { mail: mail },
                        })
                    })
                    .catch((err) => {
                        console.log('Error during decryption: ', err)
                    })

                break
            }
            case 'cancelSession': {
                console.log('[background]: received cancel command')
                // TODO: Either cancel the session or decryptState it for later
                break
            }
        }
        return null
    })
})
