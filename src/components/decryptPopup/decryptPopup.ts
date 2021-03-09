import { Client } from '@e4a/irmaseal-client'

// TODO: get all types from comm-central or something..
declare const browser: any

const client: Client = await Client.build('https://qrona.info/pkg')

const mailTabs = await browser.tabs.query({
    lastFocusedWindow: true,
    active: true,
    mailTab: true,
    currentWindow: true,
})

if (mailTabs.length != 1) {
    console.log('more than one email tab')
}

const mailTab = mailTabs[0]
console.log('current mail tab: ', mailTab)

const currentMsg = await browser.messageDisplay.getDisplayedMessage(mailTab.id)

console.log('current msg: ', currentMsg)

const accountId = currentMsg.folder.accountId

const identity = await browser.accounts.getDefaultIdentity(accountId)

console.log('current identity: ', identity)

// TODO: get raw IRMAseal bytestream from mime encrypted MIME
// const ts = client.extractTimestamp(irmasealBytestream)

// Request token for the indentity to which this email was sent
console.log('requesting token for: ', identity.email)
client
    .requestToken({
        attributeType: 'pbdf.sidn-pbdf.email.email',
        attributeValue: identity.email,
    })
    .then((token) => {
        console.log('token: ', token)
    })
    .catch((err) => {
        console.log('error: ', err)
    })
    .finally(() => window.close())

// TODO: send mail body to background such that the background can alter the mailcontent currenty displaying
