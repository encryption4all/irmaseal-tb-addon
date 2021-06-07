const showSealedLayout = async () => {
    const text = document.getElementsByClassName('moz-text-plain')[0]
    const display = text.style.display

    var envelope, header, envelopeText, qr, help
    var sealed, sender, identity, messageId

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
                    // TODO: remove the listener
                    return
                }

                // Hide the ciphertext
                text.style.display = 'none'

                port.postMessage({ command: 'startSession', args: { messageId: messageId } })
                break
            }
            case 'showQr': {
                const { qrData } = message.args

                console.log('[content-script]: qrData:', qrData)

                // Build the layout

                envelope = document.createElement('div')
                header = document.createElement('div')
                envelopeText = document.createElement('div')
                qr = document.createElement('img')
                help = document.createElement('div')

                envelope.className = 'envelope'
                header.className = 'header'
                envelopeText.className = 'envelopeText'
                envelopeText.innerText = `This message has been encrypted with IRMAseal.\nYou have received a locked message by:\n\n${sender}.\n\nTo open this email, you have to prove that you have the following identity loaded in your IRMA app:\n\n${identity.type}: ${identity.value}.\n`
                qr.src = qrData
                help.className = 'help'
                help.innerText = "Don't have IRMA yet?"

                envelope.appendChild(header)
                envelope.appendChild(envelopeText)
                envelope.appendChild(qr)
                envelope.appendChild(help)
                document.body.insertBefore(envelope, document.body.firstChild)

                break
            }
            case 'showDecryption': {
                const { mail } = message.args

                console.log('[content-script]: decrypted mail: ', mail)

                if (mail) {
                    envelope.remove()
                    text.innerText = mail
                    text.style.display = display
                }

                break
            }
        }
    })
}

showSealedLayout()
