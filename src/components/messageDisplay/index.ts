const run = async () => {
    const details = await browser.runtime.sendMessage({ command: 'queryDetails' })

    const { isEncrypted, wasEncrypted } = details

    if (isEncrypted) {
        const text = document.body.querySelector('.moz-text-flowed')
        const html = document.body.querySelector('.moz-text-html')
        if (text) (text as HTMLElement).style.display = 'none'
        if (html) (html as HTMLElement).style.display = 'none'

        document.body.style.background = `url(${browser.extension.getURL(
            'images/hidden_email_pattern.svg'
        )}) space repeat`
        document.body.style['background-color'] = '#eaeaea'
        document.body.style.height = '100%'

        await browser.runtime.sendMessage({ command: 'showDecryptionBar' })
    } else if (wasEncrypted) {
        // TODO: show banner that mail was encrypted
    }
}

run()
