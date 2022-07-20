import AttributeForm from 'pg-components/AttributeForm/AttributeForm.svelte'
import type { Policy } from 'pg-components/AttributeForm.svelte'

import { toEmail } from '../../utils'
import './index.css'

window.addEventListener('load', onLoad)

const finish = async (policy: Policy) => {
    browser.runtime
        .sendMessage({
            command: 'popup_done',
            policies: policy,
        })
        .finally(async () => {
            const win = await messenger.windows.getCurrent()
            messenger.windows.remove(win.id)
        })
}

async function onLoad() {
    const el = document.querySelector('#root')
    if (!el) return

    const data = await browser.runtime.sendMessage({
        command: 'popup_init',
    })

    const init = data.initialRecipients.reduce((policies, next) => {
        const email = toEmail(next)
        policies[email] = []
        return policies
    }, [])

    new AttributeForm({
        target: el,
        props: { initialPolicy: init, onSubmit: finish },
    })
}

window.addEventListener('load', onLoad)
