import { Client, Attribute } from '@e4a/irmaseal-client'
import { Buffer } from 'buffer'

// TODO: currently this is not very efficient.
// We are using two clients and we load the WASM twice.
// Instead, we could do all WASM module operations in the background.
// I.e.,
// The background retrieves the identity and sends this back to the popup.
// The popup uses his client/irma-frontend-packages to ask for a token/key.
// The key is sent to the background for decryption.

// TODO: get all types from comm-central or something..
declare const browser: any

function getCiphertextFromMime(mime: any): string | undefined {
    console.log('mime :', mime)
    try {
        const mimeparts = mime.parts
        const multiparts = mimeparts.find((part: any) => part.contentType === 'multipart/encrypted')
            .parts
        const fakeparts = multiparts.find(
            (part2: any) => part2.contentType === 'multipart/fake-container'
        ).parts
        const b64encoded = fakeparts
            .find((part3: any) => part3.contentType === 'text/plain')
            .body.replace('\n', '')
        return b64encoded
    } catch (e) {
        console.log('failed to get ciphertext from mime parts')
        return
    }
}

const client: Client = await Client.build('https://qrona.info/pkg', true, browser.storage.local)

const mailTabs = await browser.tabs.query({
    lastFocusedWindow: true,
    active: true,
    mailTab: true,
    currentWindow: true,
})

if (mailTabs.length != 1) {
    throw new Error('more than one email tab')
}

const mailTab = mailTabs[0]
console.log('current mail tab: ', mailTab)

const currentMsg = await browser.messageDisplay.getDisplayedMessage(mailTab.id)

console.log('current msg: ', currentMsg)

const accountId = currentMsg.folder.accountId

const identity = await browser.accounts.getDefaultIdentity(accountId)

console.log('current identity: ', identity)

const mime = await browser.messages.getFull(currentMsg.id)
const b64encoded: string | undefined = getCiphertextFromMime(mime)
if (!b64encoded) throw new Error('MIME part not found')

console.log('b64 encoded: ', b64encoded)
const bytes = Buffer.from(b64encoded, 'base64')

console.log('ct bytes: ', bytes)

const id = client.extractIdentity(bytes)
console.log('identity in bytestream:', id)

const attribute: Attribute = {
    type: 'pbdf.sidn-pbdf.email.email',
    value: identity.email,
}

client
    .requestToken(attribute)
    .then((token) => client.requestKey(token, id.timestamp))
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
    .finally(() => window.close())
