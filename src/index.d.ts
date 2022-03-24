declare const browser, messenger

interface PopupData {
    hostname: string
    policy: Policy
    senderId: string
    recipientId: string
}

interface Policy {
    con: { t: string; v: string }[]
    ts: number
}
