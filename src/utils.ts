import { ComposeMail } from '@e4a/irmaseal-mail-utils'

function enqueueHeaders(
    headers: { [key: string]: string },
    controller: TransformStreamDefaultController
) {
    for (const [k, v] of Object.entries(headers)) {
        controller.enqueue(`${k}: ${v}\r\n`)
    }
    controller.enqueue(`\r\n`)
}

export function createMIMETransform(sender: string): TransformStream<Uint8Array, string> {
    // The number of chars a base64 encoded line should contain according to RFC 1421.
    // For more information see, https://datatracker.ietf.org/doc/html/rfc1421.
    const LINE_CHARS = 76
    const LINE_BYTES = (LINE_CHARS / 4) * 3

    // Buffer up to 16 lines.
    const BUF_LINES = 16
    const BUF_BYTES = BUF_LINES * LINE_BYTES

    const buf = Buffer.alloc(BUF_BYTES)
    let buf_tail = 0

    const boundary = generateBoundary()
    const altBoundary = generateBoundary()

    const composer = new ComposeMail()
    composer.setSender(sender)

    // The sent message has the following MIME structure:
    // - multipart/mixed
    //      - multipart/alternative
    //          - text/plain
    //          - text/html
    //      - application/postguard

    const outerHeaders = {
        'Content-Type': `multipart/mixed; boundary="${boundary}"`,
    }
    const alternativeHeaders = {
        'Content-Type': `multipart/alternative; boundary="${altBoundary}"`,
    }
    const plainHeaders = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Transfer-Encoding': 'base64',
    }
    const htmlHeaders = {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Transfer-Encoding': 'base64',
    }
    const encryptedHeaders = {
        'Content-Type': 'application/postguard; name="postguard.encrypted"',
        'Content-Disposition': 'attachment; filename="postguard.encrypted"',
        'Content-Transfer-Encoding': 'base64',
    }

    const plain = composer.getPlainTextB64()
    const html = composer.getHtmlTextB64()

    return new TransformStream({
        start: (controller) => {
            enqueueHeaders(outerHeaders, controller)
            controller.enqueue(`--${boundary}\r\n`)

            enqueueHeaders(alternativeHeaders, controller)
            controller.enqueue(`--${altBoundary}\r\n`)

            enqueueHeaders(plainHeaders, controller)
            controller.enqueue(`${plain}\r\n\r\n`)
            controller.enqueue(`--${altBoundary}\r\n`)

            enqueueHeaders(htmlHeaders, controller)
            controller.enqueue(`${html}\r\n\r\n`)
            controller.enqueue(`--${altBoundary}--\r\n`)

            controller.enqueue(`--${boundary}\r\n`)

            enqueueHeaders(encryptedHeaders, controller)
        },
        transform: (chunk, controller) => {
            while (chunk.byteLength != 0) {
                const len = chunk.byteLength
                const rem = BUF_BYTES - buf_tail

                if (len < rem) {
                    buf.fill(chunk.slice(0, len), buf_tail)
                    buf_tail += len
                    chunk = chunk.slice(len, len)
                } else {
                    buf.fill(chunk.slice(0, rem), buf_tail)
                    const b64string = buf.toString('base64')
                    const formatted = b64string.replace(/(.{76})/g, '$1\r\n')
                    controller.enqueue(formatted)

                    chunk = chunk.slice(rem, len)
                    buf_tail = 0
                }
            }
        },
        flush: (controller) => {
            const b64string = buf.slice(0, buf_tail).toString('base64')
            const formatted = b64string.replace(/(.{76})/g, '$1\r\n')
            controller.enqueue(formatted + '\r\n\r\n')
            controller.enqueue(`--${boundary}--\r\n\r\n`)
        },
    })
}

export function readableStreamFromArray(chunks: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start: (controller) => {
            controller.enqueue(chunks)
            controller.close()
        },
    })
}

// Converts a Thunderbird email account identity to an email address
export function toEmail(identity: string): string {
    const regex = /^(.*)<(.*)>$/
    const match = identity.match(regex)
    return match ? match[2] : identity
}

// Applies a transform in front of a WritableStream.
export function withTransform(
    writable: WritableStream,
    transform: TransformStream
): WritableStream {
    transform.readable.pipeTo(writable)
    return transform.writable
}

// Applies multiple tranforms (in order) in front of a WritableStream.
export function withTransforms(
    writable: WritableStream,
    transforms: TransformStream[]
): WritableStream {
    return transforms.reduce((prevW, currT) => withTransform(prevW, currT), writable)
}

export function isIRMASeal(fullParts: any): boolean {
    // check if the outside MIME is multipart/mixed
    // check if one of the parts contains application/postguard

    try {
        const outer = fullParts.parts[0]
        const mixed = outer.headers['content-type'].some((c) => c.includes('multipart/mixed'))
        if (!mixed) return false

        const sealed = outer.parts.some((part) =>
            part.headers['content-type'].some((c) => c.includes('application/postguard'))
        )

        return sealed
    } catch (e) {
        console.log(e)
        return false
    }
}

function generateBoundary(): string {
    const rand = crypto.getRandomValues(new Uint8Array(16))
    const boundary = Buffer.from(rand).toString('hex')
    return boundary
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
