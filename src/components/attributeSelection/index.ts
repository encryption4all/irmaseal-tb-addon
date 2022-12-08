import AttributeForm from '@e4a/pg-components/AttributeForm/AttributeForm.svelte'
import type { Policy } from '@e4a/pg-components/AttributeForm/AttributeForm.svelte'

import './index.scss'

window.addEventListener('load', onLoad)

const onSubmit = async (policy: Policy) => {
    browser.runtime
        .sendMessage({
            command: 'popup_done',
            policy,
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

    const lang = browser.i18n.getUILanguage() === 'nl' ? 'nl' : 'en'
    new AttributeForm({
        target: el,
        props: { initialPolicy: data.initialPolicy, onSubmit, submitButton: true, lang },
    })
}

window.addEventListener('load', onLoad)
