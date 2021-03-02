import { Client } from '@e4a/irmaseal-client'

console.log('irmaseal-tb started.')

let client = await Client.build('https://qrona.info/pkg')

console.log('client started: ', client)

let bytestream = client.encrypt(
    {
        attributeType: 'pbdf.sidn-pbdf.email.email',
        attributeValue: 'l.botros@cs.ru.nl',
    },
    { some: 'object' }
)

console.log('bytestream: ', bytestream)
