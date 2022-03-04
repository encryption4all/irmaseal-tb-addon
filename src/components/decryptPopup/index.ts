import * as IrmaCore from '@privacybydesign/irma-core'
import * as IrmaClient from '@privacybydesign/irma-client'
import * as IrmaWeb from '@privacybydesign/irma-web'

//import '@privacybydesign/irma-css'

window.addEventListener('load', onLoad)

declare const browser, messenger

interface popupData {
    hostname: string
    guess: any
    timestamp: number
}

async function onLoad() {
    console.log('[popUp]: onLoad')

    const data: popupData = await browser.runtime.sendMessage({
        command: 'popup_init',
    })

    const irma = new IrmaCore({
        element: '#irma-web-form',
        debugging: true,
        session: {
            url: data.hostname,
            start: {
                url: (o) => `${o.url}/v2/request`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data.guess),
            },
            result: {
                url: (o, { sessionToken: token }) =>
                    `${o.url}/v2/request/${token}/${data.timestamp.toString()}`,
                parseResponse: (r) => {
                    return new Promise((resolve, reject) => {
                        if (r.status != '200') reject('not ok')
                        r.json().then((json) => {
                            if (json.status !== 'DONE_VALID') reject('not done and valid')
                            resolve(json.key)
                        })
                    })
                },
            },
        },
    })

    irma.use(IrmaClient)
    irma.use(IrmaWeb)

    irma.start()
        .then((usk: string) => {
            browser.runtime.sendMessage({
                command: 'popup_done',
                usk: usk,
            })
        })
        .catch((e) => {
            console.log('error: ', e.msg)
        })
        .finally(async () => {
            const win = await messenger.windows.getCurrent()
            messenger.windows.remove(win.id)
        })
}

window.addEventListener('load', onLoad)
