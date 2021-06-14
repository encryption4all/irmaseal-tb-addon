import 'web-streams-polyfill'

import {
    KeySet,
    Attribute,
    Client,
    symcrypt,
    Metadata,
    MetadataCreateResult,
    MetadataReaderResult,
    createUint8ArrayReadable,
} from '@e4a/irmaseal-client'
import { Buffer } from 'buffer'
import { getCiphertextFromMime } from './../util'
import { toDataURL } from 'qrcode'

import * as IrmaCore from '@privacybydesign/irma-core'
import * as IrmaClient from '@privacybydesign/irma-client'

declare const browser
const WIN_TYPE_COMPOSE = 'messageCompose'

console.log('[background]: irmaseal-tb started.')
const client: Client = await Client.build('https://irmacrypt.nl/pkg')

// Keeps track of which tabs (messageCompose type) should use encryption
const composeTabs: { [tabId: number]: boolean } = {}

// Keeps track of encryption data and session details per message
const store: {
    [messageId: number]: {
        bytes: Uint8Array
        res: MetadataReaderResult
        identity: Attribute
        timestamp: number
        token?: string
    }
} = {}

async function setIcon(tabId: number) {
    await browser.composeAction.setIcon({
        tabId: tabId,
        path: composeTabs[tabId] ? 'icons/toggle-on.png' : 'icons/toggle-off.png',
    })

    await browser.composeAction.setTitle({
        title: `Encryption ${composeTabs[tabId] ? 'ON' : 'OFF'}`,
    })
}

// Keep track of all the compose tabs created
browser.tabs.onCreated.addListener(async (tab) => {
    console.log('[background]: tab opened: ', tab)

    // Check the windowType of the tab
    const win = await browser.windows.get(tab.windowId)
    if (win.type === WIN_TYPE_COMPOSE) {
        composeTabs[tab.id] = true
    }

    console.log('composeTabs: ', composeTabs)

    await setIcon(tab.id)
})

browser.tabs.onRemoved.addListener((tabId: number) => {
    console.log(`[background]: tab with id ${tabId} removed`)
    if (tabId in composeTabs) {
        delete composeTabs[tabId]
    }
    console.log('composeTabs: ', composeTabs)
})

browser.composeAction.onClicked.addListener(async (tab) => {
    const id = tab.id
    console.log(
        `[background]: toggleEncryption for tab ${id}: ${composeTabs[id]} => ${!composeTabs[id]}`
    )
    composeTabs[id] = !composeTabs[id]
    console.log('composeTabs: ', composeTabs)

    await setIcon(id)
})

browser.compose.onBeforeSend.addListener(async (tab, details) => {
    console.log('[background]: onBeforeSend: ', tab, details)
    if (!composeTabs[tab.id]) return

    // details.plainTextBody = mail in plaintext
    // details.body = mail in html format
    const plaintext = details.body

    console.log('[background]: onBeforeSend: plaintext: ', plaintext)

    const identity: Attribute = {
        type: 'pbdf.sidn-pbdf.email.email',
        value: details.to[0],
    }

    const res: MetadataCreateResult = client.createMetadata(identity)
    const metadata = res.metadata.to_json()
    const plainBytes: Uint8Array = new TextEncoder().encode(plaintext)
    const cipherbytes: Uint8Array = await symcrypt(res.keys, metadata.iv, res.header, plainBytes)
    const b64encoded = Buffer.from(cipherbytes).toString('base64')

    console.log('[background]: setting SecurityInfo')
    await browser.irmaseal4tb.setSecurityInfo(tab.windowId, b64encoded)
    console.log('[background]: securityInfo set')
})

// Register a message display script
await browser.messageDisplayScripts.register({
    js: [{ file: 'message-content-script.js' }],
    css: [{ file: 'message-content-styles.css' }],
})

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
                console.log('tabId: ', tabId)
                const currentMsg = await browser.messageDisplay.getDisplayedMessage(tabId)
                // TODO: somehow this is null sometimes when it shouldn't
                //                if (!currentMsg) return { sealed: false }

                const sealed = await browser.irmaseal4tb.getMsgHdr(currentMsg.id, 'sealed')
                if (sealed !== 'true') return { sealed: false }

                const mime = await browser.messages.getFull(currentMsg.id)
                const b64encoded: string | undefined = getCiphertextFromMime(mime)
                if (!b64encoded) return { sealed: false }

                const sealBytes: Uint8Array = new Uint8Array(Buffer.from(b64encoded, 'base64'))
                const readable: ReadableStream = createUint8ArrayReadable(sealBytes)
                const res: MetadataReaderResult = await client.extractMetadata(readable)
                const metadata: Metadata = res.metadata
                const metadata_json = metadata.to_json()

                store[currentMsg.id] = {
                    bytes: sealBytes,
                    res: res,
                    identity: metadata_json.identity.attribute,
                    timestamp: metadata_json.identity.timestamp,
                }

                port.postMessage({
                    command: 'mailDetails',
                    args: {
                        sealed: true,
                        messageId: currentMsg.id,
                        sender: currentMsg.author,
                        identity: metadata_json.identity.attribute,
                    },
                })
                break
            }
            case 'startSession': {
                const {
                    identity,
                    res: { metadata, header },
                    bytes,
                    timestamp,
                } = store[message.args.messageId]

                const irma = new IrmaCore({
                    debugging: true,
                    session: {
                        url: client.url,
                        start: {
                            url: (o) => `${o.url}/v1/request`,
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                attribute: identity,
                            }),
                        },
                        mapping: {
                            sessionPtr: (r) => {
                                toDataURL(r.qr).then((dataURL) => {
                                    port.postMessage({
                                        command: 'showQr',
                                        args: { qrData: dataURL },
                                    })
                                })

                                return JSON.parse(r.qr)
                            },
                        },
                        result: {
                            url: (o, { sessionToken: token }) =>
                                `${o.url}/v1/request/${token}/${timestamp?.toString()}`,
                        },
                    },
                })

                irma.use(IrmaClient)
                irma.start()
                    .then((r) => {
                        const usk = r.key
                        const keys: KeySet = metadata.derive_keys(usk)
                        symcrypt(keys, metadata.to_json().iv, header, bytes, true).then(
                            (plainBytes) => {
                                const mail: string = new TextDecoder().decode(plainBytes)
                                port.postMessage({
                                    command: 'showDecryption',
                                    args: { mail: mail },
                                })
                            }
                        )
                    })
                    .catch((err) => {
                        console.log('Error during decryption: ', err)
                    })

                break
            }
            case 'cancelSession': {
                console.log('[background]: received cancel command')
                // TODO: Either cancel the session or store it for later
                break
            }
        }
        return null
    })
})
