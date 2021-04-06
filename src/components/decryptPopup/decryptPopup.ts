import { Client } from '@e4a/irmaseal-client'
import { Buffer } from 'buffer'

type Attribute = { attributeType: string; attributeValue: string }

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

const client: Client = await Client.build('https://qrona.info/pkg')

async function getCachedToken(attr: Attribute): Promise<string> {
    let token
    const serializedAttr: string = JSON.stringify(attr)
    const cached = (await browser.storage.local.get(serializedAttr))[serializedAttr]
    console.log(cached)

    if (
        Object.keys(cached).length === 0 ||
        (cached.validUntil && Date.now() >= cached.validUntil)
    ) {
        console.log(
            'Cache miss or token not valid anymore.\nRequesting fresh token for: ',
            identity.email
        )
        token = await client.requestToken(attribute)
        const t: Date = new Date(Date.now())
        const validUntil = t.setSeconds(t.getSeconds() + JSON.parse(client.params).max_age)
        await browser.storage.local.set({
            [serializedAttr]: { token: token, validUntil: validUntil },
        })
    } else {
        console.log('Cache hit: ', cached)
        console.log(Date.now(), cached.validUntil)
        token = cached.token
    }
    return token
}

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

const ts = client.extractTimestamp(bytes)
if (ts === -1) throw new Error('NO_TIMESTAMP')

const attribute: Attribute = {
    attributeType: 'pbdf.sidn-pbdf.email.email',
    attributeValue: identity.email,
}

const token = await getCachedToken(attribute)

client
    .requestKey(token, ts)
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
