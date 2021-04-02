import { Client } from '@e4a/irmaseal-client'
import { Buffer } from 'buffer'

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

const mime = await browser.messages.getFull(currentMsg.id)

console.log('mime :', mime)

const mimeparts = mime.parts
console.log(mimeparts)

const multiparts = mimeparts.find((part: any) => part.contentType === 'multipart/encrypted').parts
console.log(multiparts)

const fakeparts = multiparts.find((part2: any) => part2.contentType === 'multipart/fake-container')
    .parts
console.log(fakeparts)

const b64encoded = fakeparts
    .find((part3: any) => part3.contentType === 'text/plain')
    .body.replace('\n', '')

console.log('b64 encoded:Buffer ', b64encoded)
const bytes = Buffer.from(b64encoded, 'base64')

console.log('ct bytes: ', bytes)

const ts = client.extractTimestamp(bytes)
if (ts === -1) throw new Error('NO_TIMESTAMP')

// Request token for the indentity to which this email was sent
console.log('requesting token for: ', identity.email)
client
    .requestToken({
        attributeType: 'pbdf.sidn-pbdf.email.email',
        attributeValue: identity.email,
    })
    .then((token) => client.requestKey(token, ts))
    .then(async (usk) => {
        const mail = client.decrypt(usk, bytes)
        console.log(mail)
        await browser.messageDisplayScripts.register({
            js: [{ code: `document.body.textContent = "${mail.body}";` }, { file: 'display.js' }],
        })
    })
    .catch((err) => {
        console.log('error: ', err)
    })
    .finally(() => setTimeout(() => window.close(), 2000)) // maybe wait some seconds?
