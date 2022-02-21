// The number of chars a base64 encoded line should contain according to RFC 1421.
// For more information see, https://datatracker.ietf.org/doc/html/rfc1421.
const LINE_CHARS = 76
const LINE_BYTES = (LINE_CHARS / 4) * 3

// Buffer up to 16 lines.
const BUF_LINES = 16
const BUF_BYTES = BUF_LINES * LINE_BYTES

export function createMIMETransform(/*resolve: () => void*/): TransformStream<Uint8Array, string> {
    const buf = Buffer.alloc(BUF_BYTES)
    let buf_tail = 0

    // TODO create one at random
    const boundary = 'boundary'
    const outer_headers = {
        'Content-Type': `multipart/mixed; boundary="${boundary}"`,
    }
    const encrypted_headers = {
        'Content-Type': 'application/irmaseal; name="irmaseal.encrypted"',
        'Content-Disposition': 'attachment; filename="encrypted.irmaseal"',
        'Content-Transfer-Encoding': 'base64',
    }
    const plain_headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Transfer-Encoding': '7bit',
    }
    const plain =
        'This mail has been encrypted using Cryptify. For more information, see cryptify.mail.'

    return new TransformStream({
        start: (controller) => {
            for (const [k, v] of Object.entries(outer_headers)) {
                controller.enqueue(`${k}: ${v}\r\n`)
            }

            controller.enqueue(`--${boundary}\r\n`)

            for (const [k, v] of Object.entries(encrypted_headers)) {
                controller.enqueue(`${k}: ${v}\r\n`)
            }

            controller.enqueue('\r\n')
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
            controller.enqueue(formatted + '\r\n')
            controller.enqueue(`--${boundary}\r\n`)

            for (const [k, v] of Object.entries(plain_headers)) {
                controller.enqueue(`${k}: ${v}\r\n`)
            }
            controller.enqueue(`\r\n${plain}\r\n--${boundary}--`)
        },
    })
}

export function new_readable_stream_from_array(chunks: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start: (controller) => {
            controller.enqueue(chunks)
            controller.close()
        },
    })
}
