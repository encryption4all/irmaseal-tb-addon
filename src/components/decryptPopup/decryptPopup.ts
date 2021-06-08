import 'web-streams-polyfill'
import {
    Client,
    MetadataReaderResult,
    createUint8ArrayReadable,
    symcrypt,
    KeySet,
    Metadata,
} from '@e4a/irmaseal-client'
import { Buffer } from 'buffer'
import { getCiphertextFromMime } from './../../util'

// TODO: currently this is not very efficient.
// We are using two clients and we load the WASM twice.
// Instead, we could do all WASM module operations in the background.
// I.e.,
// The background retrieves the identity and sends this back to the popup.
// The popup uses his client/irma-frontend-packages to ask for a token/key.
// The key is sent to the background for decryption.

// TODO: get all types from comm-central or something..
declare const browser

const client: Client = await Client.build('https://irmacrypt.nl/pkg')

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
const sealBytes: Uint8Array = new Uint8Array(Buffer.from(b64encoded, 'base64'))

console.log('seal bytes: ', sealBytes)

const readable: ReadableStream = createUint8ArrayReadable(sealBytes)
const res: MetadataReaderResult = await client.extractMetadata(readable)

const metadata: Metadata = res.metadata
const metadata_json = metadata.to_json()
console.log('metadata_json: ', metadata_json)

client
    .requestToken(metadata_json.identity.attribute)
    .then((token: string) => client.requestKey(token, metadata_json.identity.timestamp))
    .then(async (usk: string) => {
        const keys: KeySet = metadata.derive_keys(usk)
        const plainBytes: Uint8Array = await symcrypt(keys, metadata_json.iv, res.header, sealBytes)
        const mail: string = new TextDecoder().decode(plainBytes)
        await browser.messageDisplayScripts.register({
            js: [{ code: `document.body.textContent = "${mail}";` }, { file: 'display.js' }],
        })
    })
    .catch((err: Error) => {
        console.log('error: ', err)
    })
    .finally(() => window.close())
