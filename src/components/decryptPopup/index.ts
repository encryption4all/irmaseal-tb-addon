import * as IrmaCore from '@privacybydesign/irma-core'
import * as IrmaClient from '@privacybydesign/irma-client'
import * as IrmaWeb from '@privacybydesign/irma-web'

//import '@privacybydesign/irma-css'

window.addEventListener('load', onLoad)

declare const browser, messenger

interface PopupData {
    hostname: string
    guess: any
    timestamp: number
    sender: string
    policy: Policy
}

interface Policy {
    c: { t: string; v: string }[]
    ts: number
}

function fillTable(table: HTMLElement, policy: Policy) {
    for (const { t, v } of policy.c) {
        const row = document.createElement('tr')
        const tdtype = document.createElement('td')
        const tdvalue = document.createElement('td')
        tdtype.innerText = browser.i18n.getMessage(t) ?? t
        tdvalue.innerText = v
        row.appendChild(tdtype)
        row.appendChild(tdvalue)
        table.appendChild(row)
    }
}

async function onLoad() {
    const data: PopupData = await browser.runtime.sendMessage({
        command: 'popup_init',
    })

    const title = browser.i18n.getMessage('displayMessageTitle')
    const appName = browser.i18n.getMessage('appName')
    const header = browser.i18n.getMessage('displayMessageHeading')
    const qrPrefix = browser.i18n.getMessage('displayMessageQrPrefix')
    const helper = browser.i18n.getMessage('displayMessageIrmaHelp')

    document.getElementById('idlock_txt')!.innerText = appName
    document.getElementById('sender')!.innerText = data.sender
    document.getElementById('msg_header')!.innerText = header
    document.getElementById('irma_help')!.innerText = helper
    document.getElementById('display_message_title')!.innerText = title
    document.getElementById('qr_prefix')!.innerText = qrPrefix

    const table = document.getElementById('attribute_table')
    if (table) fillTable(table, data.policy)

    const lang = browser.i18n.getUILanguage()

    const irma = new IrmaCore({
        element: '#irma-web-form',
        language: lang.startsWith('NL') ? 'nl' : 'en',
        translations: {
            header: '',
            helper: '',
        },
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
            console.log('[popup]: error during session: ', e.msg)
        })
        .finally(async () => {
            setTimeout(async () => {
                const win = await messenger.windows.getCurrent()
                messenger.windows.remove(win.id)
            }, 1000)
        })
}

window.addEventListener('load', onLoad)
