declare const browser, messenger

type Options = {
    encryptDefault: boolean
    removeCiphertexts: boolean
    plaintextCopies: boolean
    encryptSubject: boolean
}

type PopupData = {
    policy: Policy
    hostname: string
    senderId: string
    recipientId: string
}

type Policy = {
    con: AttributeCon
    ts: number
}

type AttributeCon = [AttributeRequest]
type AttributeRequest = {
    t: string
    v: string
    notNull?: boolean
}
