export function createBase64Transform(): TransformStream<Uint8Array, string> {
    const bytes = 57 // we need 57 bytes for one line of base64 as in RFC 1421 https://datatracker.ietf.org/doc/html/rfc1421.
    const newline = '\r\n'
    const buf = Buffer.alloc(bytes)
    let buf_tail = 0
    return new TransformStream({
        transform: (chunk: Uint8Array, controller) => {
            let done = false
            while (!done) {
                const len = chunk.byteLength
                const rem = 57 - buf_tail
                if (len < rem) {
                    buf.fill(chunk, buf_tail)
                    buf_tail += len
                } else {
                    buf.fill(chunk.slice(0, rem), buf_tail)
                    const b64string = buf.toString('base64')
                    controller.enqueue(b64string + newline)
                    buf.fill(chunk.slice(rem, len))
                    done = true
                }
            }
        },
        flush: (controller) => {
            const b64string = buf.toString('base64')
            controller.enqueue(b64string)
        },
    })
}

export function new_readable_stream_from_array(chunks: Uint8Array): ReadableStream {
    return new ReadableStream({
        start: (controller) => {
            for (const c in chunks) {
                controller.enqueue(c)
            }
            controller.close()
        },
    })
}
