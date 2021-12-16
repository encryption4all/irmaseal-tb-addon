import 'web-streams-polyfill'

import { Client } from '@e4a/irmaseal-client'
import { toDataURL } from 'qrcode'

import { ComposeMail, ReadMail } from '@e4a/irmaseal-mail-utils'

import * as IrmaCore from '@privacybydesign/irma-core'
import * as IrmaClient from '@privacybydesign/irma-client'
import { TAGSIZE } from '../../../irmaseal-client/src/stream'

declare const browser

const WIN_TYPE_COMPOSE = 'messageCompose'

console.log('[background]: irmaseal-tb started.')
const client: Client = await Client.build('http://localhost:8087')

// Keeps track of which tabs (messageCompose type) should use encryption
const composeTabs: { [tabId: number]: boolean } = {}

// Keeps track of encryption data and session details per message
const store: {
    [messageId: number]: {
        guess: any
        timestamp: number
        unsealer: any
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
    const plaintext = details.plainTextBody

    console.log('[background]: onBeforeSend: plaintext: ', plaintext)

    const timestamp = Math.round(Date.now() / 1000)
    const policies = details.to.reduce((total, recipient) => {
        const recipient_id = toEmail(recipient)
        total[recipient] = {
            t: timestamp,
            c: [{ t: 'pbdf.sidn-pbdf.email.email', v: recipient_id }],
        }
        return total
    }, {})

    console.log('policies', policies)

    const plainBytes: Uint8Array = new TextEncoder().encode(plaintext)
    const readable = client.createUint8ArrayReadable(plainBytes)

    let ct = new Uint8Array(0)
    const writable = new WritableStream({
        write(chunk, controller) {
            const merged = new Uint8Array(ct.byteLength + chunk.byteLength)
            merged.set(ct)
            merged.set(chunk, ct.byteLength)
            ct = merged
        },
    })

    await client.module.seal(client.params.public_key, policies, readable, writable)

    const compose = new ComposeMail()
    compose.setCiphertext(ct)
    compose.setVersion('1')
    const mime: string = compose.getMimeMail(false)

    console.log('[background]: setting SecurityInfo')
    await browser.irmaseal4tb.setSecurityInfo(tab.windowId, mime)
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
                console.log(currentMsg)
                // TODO: somehow this is null sometimes when it shouldn't
                // if (!currentMsg) return { sealed: false }

                // Check if the message is irmaseal encrypted
                const parsedParts = await browser.messages.getFull(currentMsg.id)

                console.log(parsedParts)
                const sealed =
                    parsedParts?.headers['content-type']?.[0]?.includes('application/irmaseal') ??
                    false

                if (!sealed) return { sealed: false }

                const mime = await browser.messages.getRaw(currentMsg.id)
                const readMail = new ReadMail()
                readMail.parseMail(mime)
                const ct = readMail.getCiphertext()

                console.log('ct: ', ct)
                // const version = readMail.getVersion()
                //
                const accountId = currentMsg.folder.accountId
                console.log('accountId: ', accountId)
                const defaultIdentity = await browser.identities.getDefault(accountId)
                const recipient_id = toEmail(defaultIdentity.email)
                console.log('recipient_id: ', recipient_id)

                const readable: ReadableStream = client.createUint8ArrayReadable(ct)

                const unsealer = await new client.module.Unsealer(readable, recipient_id)

                const hidden = unsealer.get_hidden_policy()
                console.log('hidden: ', hidden)
                const attribute = { type: hidden.c[0].t, value: hidden.c[0].v }

                const guess = {
                    con: [{ t: 'pbdf.sidn-pbdf.email.email', v: recipient_id }],
                }

                store[currentMsg.id] = {
                    guess,
                    timestamp: hidden.t,
                    unsealer,
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
                const { guess, timestamp, unsealer } = store[message.args.messageId]

                const irma = new IrmaCore({
                    debugging: true,
                    session: {
                        url: client.url,
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
                            write(chunk, controller) {
                                const merged = new Uint8Array(plain.byteLength + chunk.byteLength)
                                merged.set(plain)
                                merged.set(chunk, plain.byteLength)
                                plain = merged
                            },
                        })
                        await unsealer.unseal(usk, client.params.public_key, writable)
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
                // TODO: Either cancel the session or store it for later
                break
            }
        }
        return null
    })
})
