// Converts a Thunderbird email account identity to an email address
export function toEmail(identity: string): string {
    const regex = /^(.*)<(.*)>$/
    const match = identity.match(regex)
    const email = match ? match[2] : identity
    return email.toLowerCase()
}

export function generateBoundary(): string {
    const rand = crypto.getRandomValues(new Uint8Array(16))
    const boundary = Buffer.from(rand).toString('hex')
    return boundary
}

export async function hashCon(con: AttributeCon): Promise<string> {
    const sorted = con.sort(
        (att1: AttributeRequest, att2: AttributeRequest) =>
            att1.t.localeCompare(att2.t) || att1.v.localeCompare(att2.v)
    )
    return await hashString(JSON.stringify(sorted))
}

export async function hashString(message: string): Promise<string> {
    const msgArray = new TextEncoder().encode(message)
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgArray)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
    return hashHex
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    const timeout: Promise<T> = new Promise((_, reject) => {
        const timer = setTimeout(() => {
            clearTimeout(timer)
            reject(new Error(`timeout of ${ms} ms exceeded`))
        }, ms)
    })

    return Promise.race([p, timeout])
}

export async function getLocalFolder(folderName: string): Promise<any> {
    const accs = await browser.accounts.list()
    for (const acc of accs) {
        if (acc.name === 'Local Folders') {
            for (const f of acc.folders) {
                if (f.name === folderName) return f
            }
            const f = await browser.folders.create(acc, folderName)
            return f
        }
    }
    return undefined
}

export async function isPGEncrypted(msgId: number): Promise<boolean> {
    const attachments = await browser.messages.listAttachments(msgId)
    const filtered = attachments.filter((att) => att.name === 'postguard.encrypted')
    return filtered.length === 1
}

export async function wasPGEncrypted(msgId: number): Promise<boolean> {
    const full = await browser.messages.getFull(msgId)
    return 'x-postguard' in full.headers
}
