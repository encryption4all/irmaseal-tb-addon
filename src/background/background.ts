import 'web-streams-polyfill'

import { Attribute, Client, symcrypt, MetadataCreateResult } from '@e4a/irmaseal-client'
import { Buffer } from 'buffer'

// TODO: find a way to use these
// import { faToggleOn, faToggleOff } from '@fortawesome/free-solid-svg-icons'
// console.log(faToggleOn, faToggleOff)

const client: Client = await Client.build('https://qrona.info/pkg', browser.storage.local)

declare const browser: any
const WIN_TYPE_COMPOSE = 'messageCompose'

// Keeps track of which tabs (messageCompose type) should use encryption
// TODO: maybe use some fancier state library
const composeTabs: { [id: number]: boolean } = {}

async function setIcon(tabId: number) {
    await browser.composeAction.setIcon({
        tabId: tabId,
        path: composeTabs[tabId] ? 'icons/toggle-on.png' : 'icons/toggle-off.png',
    })
}

console.log('[background]: irmaseal-tb started.')

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
    if (composeTabs[tab.id]) {
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
        const cipherbytes: Uint8Array = await symcrypt(
            res.keys,
            metadata.iv,
            res.header,
            plainBytes
        )

        console.log('ciphertext bytes: ', cipherbytes)
        const b64encoded = Buffer.from(cipherbytes).toString('base64')
        console.log('ciphertext b64: ', b64encoded)

        console.log('[background]: setting SecurityInfo')
        await browser.irmaseal4tb.setSecurityInfo(tab.windowId, b64encoded)
        console.log('[background]: securityInfo set')
    }
})
