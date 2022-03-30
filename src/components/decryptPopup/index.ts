import * as IrmaCore from '@privacybydesign/irma-core'
import * as IrmaClient from '@privacybydesign/irma-client'
import * as IrmaWeb from '@privacybydesign/irma-web'
import { hashString } from './../../utils'
import jwtDecode, { JwtPayload } from 'jwt-decode'
import './index.css'

window.addEventListener('load', onLoad)

function fillTable(table: HTMLElement, data: PopupData) {
    for (const { t, v } of data.policy.con) {
        const row = document.createElement('tr')
        const tdtype = document.createElement('td')
        const tdvalue = document.createElement('td')
        tdtype.innerText = browser.i18n.getMessage(t) ?? t
        tdvalue.innerText = t === 'pbdf.sidn-pbdf.email.email' ? data.recipientId : v
        tdvalue.classList.add('blue')
        row.appendChild(tdtype)
        row.appendChild(tdvalue)
        table.appendChild(row)
    }
}

function secondsTill4AM(): number {
    const now = Date.now()
    const nextMidnight = new Date(now).setHours(24, 0, 0, 0)
    const secondsTillMidnight = Math.round((nextMidnight - now) / 1000)
    const secondsTill4AM = secondsTillMidnight + 4 * 60 * 60
    return secondsTill4AM
}

async function doSession(pol: Policy, pkg: string): Promise<string> {
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
                body: JSON.stringify({ con: pol.con, validity: secondsTill4AM() }),
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
                parseResponse: (r) => {
                    return r
                        .text()
                        .then((encoded: string) => {
                            const decoded = jwtDecode<JwtPayload>(encoded)
                            const serializedCon = JSON.stringify(pol.con)
                            hashString(serializedCon).then((hash) => {
                                browser.storage.local.set({
                                    [hash]: { encoded, exp: decoded.exp },
                                })
                            })

                            return fetch(`${pkg}/v2/request/key/${pol.ts.toString()}`, {
                                headers: {
                                    Authorization: `Bearer ${encoded}`,
                                },
                            })
                        })
                        .then((r) => r.json())
                        .then((json) => {
                            if (json.status !== 'DONE' || json.proofStatus !== 'VALID')
                                throw new Error('not done and valid')
                            return json.key
                        })
                },
            },
        },
    })

    irma.use(IrmaClient)
    irma.use(IrmaWeb)
    return irma.start()
}

async function onLoad() {
    const data: PopupData = await browser.runtime.sendMessage({
        command: 'popup_init',
    })

    const title = browser.i18n.getMessage('displayMessageTitle')
    const appName = browser.i18n.getMessage('appName')
    const header = browser.i18n.getMessage('displayMessageHeading')
    const helper = browser.i18n.getMessage('displayMessageIrmaHelp')

    document.getElementById('name')!.innerText = appName
    // document.getElementById('sender')!.innerText = data.senderId
    document.getElementById('msg_header')!.innerText = header
    document.getElementById('irma_help')!.innerText = helper
    document.getElementById('display_message_title')!.innerText = title
    // document.getElementById('qr_prefix')!.innerText = qrPrefix

    //const table = document.getElementById('attribute_table')
    //if (table) fillTable(table, data)

    doSession(data.policy, data.hostname)
        .then((usk) => {
            browser.runtime.sendMessage({
                command: 'popup_done',
                usk: usk,
            })
        })
        .finally(() =>
            setTimeout(async () => {
                const win = await messenger.windows.getCurrent()
                messenger.windows.remove(win.id)
            }, 1000)
        )
}

window.addEventListener('load', onLoad)
