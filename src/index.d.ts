declare const browser, messenger

interface Version {
    raw: string
    major: number
    minor: number
    revision: number
}

type PopupData = {
    con: AttributeCon
    hints: AttributeCon
    hostname: string
    senderId: string
    header: { string: string }
}

type Policy = { [key: string]: AttributeCon }

type AttributeCon = AttributeRequest[]

type AttributeRequest = {
    t: string
    v: string
}
