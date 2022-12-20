const hideEmail = () => {
    const html = document.body.querySelector('.moz-text-html')
    if (html) (html as HTMLElement).style.display = 'none'
    else {
        const text = document.body.querySelector('.moz-text-flowed')
        if (text) (text as HTMLElement).style.display = 'none'
    }

    document.body.style.background = `url(${browser.runtime.getURL(
        'images/hidden_email_pattern.svg'
    )}) space repeat`
    document.body.style['background-color'] = '#eaeaea'
    document.body.style.height = '100%'
}

const run = () => {
    const p = browser.runtime.connect({ name: 'displayScript' })
    p.postMessage({ command: 'queryDetails' })
    p.onMessage.addListener(({ isEncrypted }) => {
        if (isEncrypted) hideEmail()
    })
}

run()
