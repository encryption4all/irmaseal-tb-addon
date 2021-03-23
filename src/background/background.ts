// TODO: find a way to use these
import { faToggleOn, faToggleOff } from '@fortawesome/free-solid-svg-icons'

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
console.log(faToggleOn, faToggleOff)

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
    if (composeTabs[tab.id]) {
        console.log('[background]: setting SecurityInfo')
        await browser.irmaseal4tb.setSecurityInfo(tab.windowId, 42)
        console.log('[background]: securityInfo set')
    }
})
