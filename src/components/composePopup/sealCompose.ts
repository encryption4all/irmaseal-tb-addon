import { Client } from '@e4a/irmaseal-client'

console.log('hello from sealCompose')

const client = await Client.build('https://qrona.info/pkg')

console.log('client started: ', client)

// TODO: get mail content
// TODO: use the form to encrypt mail using those identities
// TODO: send mail, including header with encrypted mime

const bytestream = client.encrypt(
    {
        attributeType: 'pbdf.sidn-pbdf.email.email',
        attributeValue: 'l.botros@cs.ru.nl',
    },
    { some: 'object' }
)

console.log('bytestream: ', bytestream)
