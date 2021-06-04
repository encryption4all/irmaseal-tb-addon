const showSealedLayout = async () => {
    // Query mail information
    const { sealed, sender, identity, messageId } = await browser.runtime.sendMessage({
        command: 'queryMailDetails',
    })

    if (!sealed) return

    // Start a session in the background script
    const { qrData } = await browser.runtime.sendMessage({
        command: 'startSession',
        args: { messageId: messageId },
    })

    // Hide the ciphertext
    const text = document.getElementsByClassName('moz-text-plain')[0]
    const display = text.style.display
    text.style.display = 'none'

    // Build the layout
    const envelope = document.createElement('div')
    envelope.className = 'envelope'

    const header = document.createElement('div')
    header.className = 'header'
    envelope.appendChild(header)

    const envelopeText = document.createElement('div')
    envelopeText.className = 'envelopeText'
    envelopeText.innerText = `This message has been encrypted with IRMAseal.\nYou have received a locked message by:\n\n${sender}.\n\nTo open this email, you have to prove that you have the following identity loaded in your IRMA app:\n\n${identity.type}: ${identity.value}.\n`
    envelope.appendChild(envelopeText)

    const qr = document.createElement('img')
    qr.src = qrData
    envelope.appendChild(qr)

    const help = document.createElement('div')
    help.className = 'help'
    help.innerText = "Don't have IRMA yet?"
    envelope.appendChild(help)

    document.body.insertBefore(envelope, document.body.firstChild)

    const plain = await browser.runtime.sendMessage({
        command: 'waitForSessionFinishedAndDecrypt',
        args: { messageId: messageId },
    })

    if (plain) {
        envelope.remove()
        text.innerText = plain
        text.style.display = display
    }
}

showSealedLayout()
