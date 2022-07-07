declare const browser, messenger

interface Version {
    raw: string
    major: number
    minor: number
    revision: number
}

type PopupData = {
    policy: Policy
    hostname: string
    senderId: string
    recipientId: string
}

type Policies = { [key: string]: Policy }

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
