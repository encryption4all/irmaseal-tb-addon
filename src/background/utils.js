export function new_readable_byte_stream_from_array(array) {
	return new ReadableStream({
		type: 'bytes',
		start(controller) {
			this.controller = controller
			controller.enqueue(array)
			controller.close()
		},
		cancel() {
			const byobRequest = this.controller.byobRequest
			if (byobRequest) {
				byobRequest.respond(0)
			}
		},
	})
}

export function new_recording_writable_stream() {
	let written = new Uint8Array(0)
	const stream = new WritableStream({
		write(chunk) {
			written = new Uint8Array([...written, ...chunk])
		},
	})
	return { stream, written }
}
