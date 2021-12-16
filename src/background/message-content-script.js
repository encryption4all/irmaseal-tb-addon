const showSealedLayout = async () => {
    var sealed, sender, identity, messageId, layout

    const textPlain = document.getElementsByClassName('moz-text-plain')[0]
    const textHtml = document.getElementsByClassName('moz-text-html')[0]
    const text = textPlain ? textPlain : (textHtml ? textHtml : null)

    // Connect to the background script
    const port = browser.runtime.connect({ name: 'message-display-script' })
    port.postMessage({ command: 'queryMailDetails' })

    // Listen to visability changes to, e.g., cancel the session
    document.addEventListener('visibilitychange', () => {
        console.log('[content-script]: visability changed: hidden=', document.hidden)
        if (document.hidden) port.postMessage({ command: 'cancelSession' })
    })

    port.onMessage.addListener((message) => {
        console.log('[content-script]: Received message: ', message)
        switch (message.command) {
            case 'mailDetails': {
                ;({ sealed, sender, identity, messageId } = message.args)

                if (!sealed) {
                    // TODO: remove the listener?
                    return
                }

                // Hide the ciphertext
                text.style.display = 'none'

                // show the layout
                layout = document.createElement('div')
                layout.className = 'bg'
                layout.innerHTML = html(sender, identity)
                document.body.insertBefore(layout, document.body.firstChild)
                document.body.className = 'center encrypted'

                port.postMessage({ command: 'startSession', args: { messageId: messageId } })
                break
            }
            case 'showQr': {
                const { qrData } = message.args
                document.getElementById('qr_img').src = qrData

                break
            }
            case 'showDecryption': {
                const { mail } = message.args

                if (mail) {
                    layout.remove()
                    document.body.className = ''

                    // If the HTML format was encrypted just change the body
                    // document.body.innerHTML = mail

                    // Otherwise use plainTextBody mode
                    text.style.display = 'block'
                    text.innerText = mail
                }

                break
            }
        }
    })
}

showSealedLayout()

const html = (sender, identity) => `
<div class="center">
    <div id="idlock_svg">
        <img src="${browser.runtime.getURL('images/idlock.svg')}" />
    </div>
</div>
<div class="center">
    <p id="idlock_txt">${browser.i18n.getMessage('appName')}</p>
</div>
<div id="info_message">
    <p>${browser.i18n.getMessage('displayMessageTitle')}</p>
    <p class="blue">${sender}</p>
    <!-- <p class="smaller gray" disabled>Expires on June 15, 2021</p> -->
</div>
<div class="instructions_container">
    <div class="left">
        <img src="${browser.runtime.getURL('images/irma_logo.svg')}" id="logo" />
    </div>
    <div class="right">
        <div>
            <p>${browser.i18n.getMessage('displayMessageHeading')}</p>
        </div>
        <div id="attributes">
            <table class="smaller">
                <tr>
                    <td>${browser.i18n.getMessage(identity.type)}:</td>
                    <td class="blue">${identity.value}</td>
                </tr>
            </table>
        </div>
        <div id="qr_instruction">
            <p>${browser.i18n.getMessage('displayMessageQrPrefix')}</p>
        </div>
    </div>
</div>
<div class="center">
    <img id="qr_img" />
</div>
<div class="instructions_container">
    <div class="left"></div>
    <div class="right">
        <div id="download_irma">
            <p>${browser.i18n.getMessage('displayMessageIrmaHelp')}</p>
            <a
                href="https://play.google.com/store/apps/details?id=org.irmacard.cardemu&hl=en&gl=US&pcampaignid=pcampaignidMKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1"
                ><img alt="Get it on Google Play" src="${browser.runtime.getURL(
                    'images/google-play-badge.png'
                )}"
            /></a>
            <a
                href="https://apps.apple.com/us/app/irma-authentication/id1294092994?itsct=apps_box_badge&amp;itscg=30200"
                ><img src="${browser.runtime.getURL(
                    'images/appstore_badge.svg'
                )}")" alt="Download on the App Store"
            /></a>
        </div>
    </div>
</div>
`
