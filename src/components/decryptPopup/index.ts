import * as IrmaCore from '@privacybydesign/irma-core'
import * as IrmaClient from '@privacybydesign/irma-client'
import * as IrmaWeb from '@privacybydesign/irma-web'
import './index.scss'

const EMAIL_ATTRIBUTE_TYPE = 'pbdf.sidn-pbdf.email.email'

window.addEventListener('load', onLoad)

// If hours <  4: seconds till 4 AM today.
// If hours >= 4: seconds till 4 AM tomorrow.
function secondsTill4AM(): number {
    const now = Date.now()
    const nextMidnight = new Date(now).setHours(24, 0, 0, 0)
    const secondsTillMidnight = Math.round((nextMidnight - now) / 1000)
    const secondsTill4AM = secondsTillMidnight + 4 * 60 * 60
    return secondsTill4AM % (24 * 60 * 60)
}

async function doSession(con: AttributeCon, pkg: string): Promise<string> {
    const lang = browser.i18n.getUILanguage()
    const irma = new IrmaCore({
        debugging: true,
        element: '#irma-web-form',
        language: lang.startsWith('NL') ? 'nl' : 'en',
        translations: {
            header: '',
            helper: browser.i18n.getMessage('displayMessageQrPrefix'),
        },
        session: {
            url: pkg,
            start: {
                url: (o) => `${o.url}/v2/request/start`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ con, validity: secondsTill4AM() }),
            },
            mapping: {
                sessionPtr: (r) => {
                    const ptr = r.sessionPtr
                    ptr.u = `https://ihub.ru.nl/irma/1/${ptr.u}`
                    return ptr
                },
            },
            result: {
                url: (o, { sessionToken }) => `${o.url}/v2/request/jwt/${sessionToken}`,
                parseResponse: (r) => r.text(),
            },
        },
    })

    irma.use(IrmaClient)
    irma.use(IrmaWeb)
    return irma.start()
}

function fillTable(table: HTMLElement, data: PopupData) {
    function row({ t, v }) {
        const row = document.createElement('tr')
        const tdtype = document.createElement('td')
        const tdvalue = document.createElement('td')
        tdtype.innerText = browser.i18n.getMessage(t) ?? t
        tdvalue.innerText = v ? v : ''
        tdvalue.classList.add('value')
        row.appendChild(tdtype)
        row.appendChild(tdvalue)
        return row
    }

    table.appendChild(row({ t: EMAIL_ATTRIBUTE_TYPE, v: data.recipientId }))
    data.hints = data.hints.filter(({ t }) => t !== EMAIL_ATTRIBUTE_TYPE)
    for (const { t, v } of data.hints) {
        table.appendChild(row({ t, v }))
    }
}

async function onLoad() {
    const data: PopupData = await browser.runtime.sendMessage({
        command: 'popup_init',
    })

    const title = browser.i18n.getMessage('displayMessageTitle')
    const appName = browser.i18n.getMessage('appName')
    const header = browser.i18n.getMessage('displayMessageHeading')
    const irmaHelpHeader = browser.i18n.getMessage('displayMessageIrmaHelpHeader')
    const irmaHelpBody = browser.i18n.getMessage('displayMessageIrmaHelpBody')
    const irmaHelpLink = browser.i18n.getMessage('displayMessageIrmaHelpLinkText')
    const irmaHelpDownloadHeader = browser.i18n.getMessage('displayMessageIrmaHelpDownloadHeader')

    document.getElementById('name')!.innerText = appName
    document.getElementById('display-message-title')!.innerText = title
    document.getElementById('sender')!.innerText = data.senderId
    document.getElementById('msg-header')!.innerText = header
    document.getElementById('irma-help-header')!.innerText = irmaHelpHeader
    document.getElementById('irma-help-body')!.innerText = irmaHelpBody
    document.getElementById('irma-help-link')!.innerText = irmaHelpLink
    document.getElementById('irma-help-download-header')!.innerText = irmaHelpDownloadHeader

    const table: HTMLTableElement | null = document.querySelector('table#attribute-table')
    if (table) fillTable(table, data)

    doSession(data.con, data.hostname)
        .then((jwt) => {
            browser.runtime.sendMessage({
                command: 'popup_done',
                jwt: jwt,
            })
        })
        .finally(() =>
            setTimeout(async () => {
                const win = await messenger.windows.getCurrent()
                messenger.windows.remove(win.id)
            }, 750)
        )
}

window.addEventListener('load', onLoad)
