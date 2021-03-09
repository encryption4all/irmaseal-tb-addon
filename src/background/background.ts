console.log('irmaseal-tb started.')

//import { Client } from '@e4a/irmaseal-client'
//const registeredScripts = await browser.messageDisplayScripts.register({
//    js: [{ code: 'console.log("hey u just got an email")' }],
//})

//const client = await Client.build('https://qrona.info/pkg')
//
//console.log('client started: ', client)
//
//const bytestream = client.encrypt(
//    {
//        attributeType: 'pbdf.sidn-pbdf.email.email',
//        attributeValue: 'l.botros@cs.ru.nl',
//    },
//    { some: 'object' }
//)
//
//console.log('bytestream: ', bytestream)
//
//const ts = client.extractTimestamp(bytestream)
//
//// TODO: irma-frontend-packages do not work in background
//const token = await client.requestToken({
//    attributeValue: 'l.botros@cs.ru.nl',
//    attributeType: 'pbdf.sidn-pbdf.email.email',
//})
//
//const usk = await client.requestKey(token, ts)
//
//const plain = client.decrypt(usk, bytestream)
//
//console.log('plain: ', plain)
