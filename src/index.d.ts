declare const browser, messenger

interface Version {
    raw: string
    major: number
    minor: number
    revision: number
}

type PopupData = {
    con: AttributeCon
    hostname: string
    senderId: string
    recipientId: string
}

type Policy = { [key: string]: AttributeCon }

type AttributeCon = AttributeRequest[]

type AttributeRequest = {
    t: string
    v: string
}
