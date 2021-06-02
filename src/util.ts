export function getCiphertextFromMime(mime: any): string | undefined {
    try {
        const mimeparts = mime.parts
        const multiparts = mimeparts.find((part: any) => part.contentType === 'multipart/encrypted')
            .parts
        const fakeparts = multiparts.find(
            (part2: any) => part2.contentType === 'multipart/fake-container'
        ).parts
        const b64encoded = fakeparts.find((part3: any) => part3.contentType === 'text/plain')
        const body = b64encoded.body
        return body.replace('\n', '')
    } catch (e) {
        console.log('failed to get ciphertext from mime parts')
        return
    }
}
