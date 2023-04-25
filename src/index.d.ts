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
    sort: KeySort
    header: { [key: string]: string }
    senderId?: string
    hints?: AttributeCon
}

type Policy = { [key: string]: AttributeCon }

type AttributeCon = AttributeRequest[]

type AttributeRequest = {
    t: string
    v: string
}

type KeySort = 'Decryption' | 'Signing'
