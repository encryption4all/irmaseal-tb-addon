import * as YiviCore from '@privacybydesign/yivi-core'
import * as YiviClient from '@privacybydesign/yivi-client'
import * as YiviWeb from '@privacybydesign/yivi-web'
import './index.scss'

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

async function doSession(
    con: AttributeCon,
    pkg: string,
    clientHeader: { string: string }
): Promise<string> {
    const yivi = new YiviCore({
        debugging: false,
        element: '#yivi-web-form',
        language: browser.i18n.getUILanguage() === 'nl' ? 'nl' : 'en',
        translations: {
            header: '',
            helper: browser.i18n.getMessage('displayMessageQrPrefix'),
        },
        state: {
            serverSentEvents: false,
            polling: {
                endpoint: 'status',
                interval: 500,
                startState: 'INITIALIZED',
            },
        },
        session: {
            url: pkg,
            start: {
                url: (o) => `${o.url}/v2/request/start`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...clientHeader,
                },
                body: JSON.stringify({ con, validity: secondsTill4AM() }),
            },
            result: {
                url: (o, { sessionToken }) => `${o.url}/v2/request/jwt/${sessionToken}`,
                headers: clientHeader,
                parseResponse: (r) => r.text(),
            },
        },
    })

    yivi.use(YiviClient)
    yivi.use(YiviWeb)
    return yivi.start()
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
    const yiviHelpHeader = browser.i18n.getMessage('displayMessageYiviHelpHeader')
    const yiviHelpBody = browser.i18n.getMessage('displayMessageYiviHelpBody')
    const yiviHelpLink = browser.i18n.getMessage('displayMessageYiviHelpLinkText')
    const yiviHelpDownloadHeader = browser.i18n.getMessage('displayMessageYiviHelpDownloadHeader')

    document.getElementById('name')!.innerText = appName
    document.getElementById('display-message-title')!.innerText = title
    document.getElementById('sender')!.innerText = data.senderId
    document.getElementById('msg-header')!.innerText = header
    document.getElementById('yivi-help-header')!.innerText = yiviHelpHeader
    document.getElementById('yivi-help-body')!.innerText = yiviHelpBody
    document.getElementById('yivi-help-link')!.innerText = yiviHelpLink
    document.getElementById('yivi-help-download-header')!.innerText = yiviHelpDownloadHeader

    const table: HTMLTableElement | null = document.querySelector('table#attribute-table')
    if (table) fillTable(table, data)

    doSession(data.con, data.hostname, data.header)
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
        .catch((e) => console.log('errur:', e))
}

window.addEventListener('load', onLoad)
