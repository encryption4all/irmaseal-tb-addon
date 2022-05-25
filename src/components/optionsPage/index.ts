import { DEFAULT_OPTIONS } from './../../constants'
import './index.css'

const translation = {
    encryptDefault: 'encrypt-default',
    removeCiphertexts: 'ct-copies',
    plaintextCopies: 'pt-copies',
    encryptSubject: 'encrypt-subject',
}

const form = document.querySelector('form')

async function saveOptions(e: Event) {
    e.preventDefault()

    const options = DEFAULT_OPTIONS
    Object.keys(translation).forEach((k) => {
        options[k] = (<HTMLInputElement>form?.querySelector(`#${translation[k]}`)).checked
    })

    await browser.runtime.sendMessage({ command: 'storeOptions', options })
}

async function onLoad() {
    const options = await browser.runtime.sendMessage({ command: 'loadOptions' })

    Object.keys(options).forEach((k) => {
        const input = <HTMLInputElement>form?.querySelector(`#${translation[k]}`)
        input.checked = options[k]
    })
}

document.addEventListener('DOMContentLoaded', onLoad)
form?.addEventListener('submit', saveOptions)
