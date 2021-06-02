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

// TODO: find a way to use these
// import { faToggleOn, faToggleOff } from '@fortawesome/free-solid-svg-icons'
// console.log(faToggleOn, faToggleOff)

const client: Client = await Client.build('https://irmacrypt.nl/pkg')

declare const browser: any
const WIN_TYPE_COMPOSE = 'messageCompose'

console.log('[background]: irmaseal-tb started.')

// Keeps track of which tabs (messageCompose type) should use encryption
const composeTabs: { [id: number]: boolean } = {}

async function setIcon(tabId: number) {
    await browser.composeAction.setIcon({
        tabId: tabId,
        path: composeTabs[tabId] ? 'icons/toggle-on.png' : 'icons/toggle-off.png',
    })
}

// Keep track of all the compose tabs created
browser.tabs.onCreated.addListener(async (tab: any) => {
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

browser.composeAction.onClicked.addListener(async (tab: any) => {
    const id = tab.id
    console.log(
        `[background]: toggleEncryption for tab ${id}: ${composeTabs[id]} => ${!composeTabs[id]}`
    )
    composeTabs[id] = !composeTabs[id]
    console.log('composeTabs: ', composeTabs)
    await setIcon(id)
})

browser.compose.onBeforeSend.addListener(async (tab: any, details: any) => {
    console.log('[background]: onBeforeSend: ', tab, details)
    if (!composeTabs[tab.id]) return

    const plaintext = details.plainTextBody.replace('\n', '')
    console.log(plaintext)

    const identity: Attribute = {
        type: 'pbdf.sidn-pbdf.email.email',
        value: details.to[0],
    }
    console.log('encrypting for identity: ', identity)

    const res: MetadataCreateResult = client.createMetadata(identity)
    const metadata = res.metadata.to_json()
    const plainBytes: Uint8Array = new TextEncoder().encode(plaintext)
    const cipherbytes: Uint8Array = await symcrypt(res.keys, metadata.iv, res.header, plainBytes)

    console.log('ciphertext bytes: ', cipherbytes)
    const b64encoded = Buffer.from(cipherbytes).toString('base64')
    console.log('ciphertext b64: ', b64encoded)

    console.log('[background]: setting SecurityInfo')
    await browser.irmaseal4tb.setSecurityInfo(tab.windowId, b64encoded)
    console.log('[background]: securityInfo set')
})

// Register a message display script
await browser.messageDisplayScripts.register({
    js: [{ file: 'message-content-script.js' }],
    css: [{ file: 'message-content-styles.css' }],
})

const store: {
    [id: number]: {
        bytes: Uint8Array
        res: MetadataReaderResult
        identity: Attribute
        timestamp: number
        token?: string
    }
} = {}

async function handleMessage(message: any, sender: any, sendResponse: any) {
    console.log('[background]: received message: ', message, sender, sendResponse)
    if (message && 'command' in message) {
        const {
            tab: { id: tabId },
        } = sender
        switch (message.command) {
            case 'queryMailDetails': {
                console.log('Got queryMailDetails command')

                const currentMsg = await browser.messageDisplay.getDisplayedMessage(tabId)
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

                return {
                    sealed: true,
                    messageId: currentMsg.id,
                    sender: currentMsg.author,
                    identity: metadata_json.identity.attribute,
                }
            }
            case 'startSession': {
                console.log('Got startSession command with args: ', message.args)
                const { identity } = store[message.args.messageId]

                const resp = await fetch(client.url + '/v1/request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        attribute: identity,
                    }),
                })
                const response = await resp.json()
                const dataURL = await toDataURL(response.qr)

                store[message.args.messageId].token = response.token

                return { token: response.token, qrData: dataURL }
            }
            case 'waitForSessionFinishedAndDecrypt': {
                console.log('Got waitForSessionFinishedAndDecrypt with args: ', message.args)

                const {
                    res: { metadata, header },
                    bytes,
                    token,
                    timestamp,
                } = store[message.args.messageId]

                let retval = undefined
                while (!retval) {
                    const rawResp = await fetch(
                        `${client.url}/v1/request/${token}/${timestamp?.toString()}`
                    )
                    const resp = await rawResp.json()
                    console.log('Polling got: ', resp)
                    await new Promise((r) => setTimeout(r, 500))
                    switch (resp.status) {
                        case 'INITIALIZED':
                        case 'CONNECTED':
                            continue
                        case 'TIMEDOUT':
                        case 'CANCELLED':
                            break
                        case 'DONE_VALID': {
                            const usk = resp.key
                            const keys: KeySet = metadata.derive_keys(usk)
                            const plainBytes: Uint8Array = await symcrypt(
                                keys,
                                metadata.to_json().iv,
                                header,
                                bytes,
                                true
                            )
                            const mail: string = new TextDecoder().decode(plainBytes)
                            retval = mail
                            break
                        }
                    }
                }

                return retval
            }
        }
    }
    return null
}

browser.runtime.onMessage.addListener(handleMessage)
