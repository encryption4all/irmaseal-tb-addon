/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 *  Module for handling PGP/MIME encrypted messages
 *  implemented as an XPCOM object.
 *  Adapted from: https://gitlab.com/pbrunschwig/thunderbird-encryption-example/-/blob/master/chrome/content/modules/mimeDecrypt.jsm
 */

/* global Components: false, ChromeUtils: false, NotifyTools: false */

'use strict'

var EXPORTED_SYMBOLS = ['IRMAsealMimeDecrypt']

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components

Cm.QueryInterface(Ci.nsIComponentRegistrar)

const Services = Cu.import('resource://gre/modules/Services.jsm').Services
const { ExtensionCommon } = ChromeUtils.import('resource://gre/modules/ExtensionCommon.jsm')
const { ExtensionParent } = ChromeUtils.import('resource://gre/modules/ExtensionParent.jsm')

const extension = ExtensionParent.GlobalManager.getExtension('irmaseal4tb@e4a.org')
const { notifyTools } = Cu.import(extension.rootURI.resolve('irmaseal4tb/notifyTools.js'))
const { block_on } = Cu.import(extension.rootURI.resolve('irmaseal4tb/utils.jsm'))
const { clearTimeout, setTimeout } = ChromeUtils.import('resource://gre/modules/Timer.jsm')

const MIME_JS_DECRYPTOR_CONTRACTID = '@mozilla.org/mime/pgp-mime-js-decrypt;1'
const MIME_JS_DECRYPTOR_CID = Components.ID('{f3a50b87-b198-42c0-86d9-116aca7180b3}')

const DEBUG_LOG = (str) => Services.console.logStringMessage(`[experiment]: ${str}`)
const ERROR_LOG = (ex) => DEBUG_LOG(`exception: ${ex.toString()}, stack: ${ex.stack}`)

const MIN_BUFFER = 1024

function MimeDecryptHandler() {
    DEBUG_LOG('mimeDecrypt.jsm: new MimeDecryptHandler()\n')
    this.mimeProxy = null
    this.msgHdr = null
    this.msgId = null
}

MimeDecryptHandler.prototype = {
    classDescription: 'IRMAseal/MIME JS Decryption Handler',
    classID: MIME_JS_DECRYPTOR_CID,
    contractID: MIME_JS_DECRYPTOR_CONTRACTID,
    QueryInterface: ChromeUtils.generateQI([Ci.nsIStreamListener]),

    inStream: Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream),

    // the MIME handler needs to implement the nsIStreamListener API
    onStartRequest: function (request) {
        DEBUG_LOG('mimeDecrypt.jsm: onStartRequest()\n')
        this.mimeProxy = request.QueryInterface(Ci.nsIPgpMimeProxy)
        this.uri = this.mimeProxy.messageURI

        if (this.uri) {
            this.msgHdr = this.uri.QueryInterface(Ci.nsIMsgMessageUrl).messageHeader
            this.msgId = extension.messageManager.convert(this.msgHdr).id
            DEBUG_LOG(`msgId: ${this.msgId}`)
        }

        this.buffer = ''
        this.bufferCount = 0
        this.sessionOnGoing = false
        this.aborted = false

        // add a listener to wait for decrypted blocks
        // initially waits one minute for a session to start
        this.finishedPromise = new Promise((resolve, reject) => {
            this.sessionPromise = new Promise((resolve2, reject2) => {
                var timeout = setTimeout(
                    () => reject(new Error('wait for session timed out')),
                    60000
                )
                this.listener = notifyTools.addListener((msg) => {
                    switch (msg.command) {
                        case 'dec_session_start':
                            DEBUG_LOG('session started')
                            this.sessionOnGoing = true
                            clearTimeout(timeout)
                            timeout = setTimeout(() => reject(new Error('session timeout')), 60000)
                            return
                        case 'dec_session_complete':
                            DEBUG_LOG('session complete')
                            this.sessionOnGoing = false
                            resolve2()
                            return
                        case 'dec_plain':
                            DEBUG_LOG('got some plaintext')
                            clearTimeout(timeout)
                            timeout = setTimeout(
                                () => reject(new Error('plaintext chunks timeout')),
                                5000
                            )
                            this.mimeProxy.outputDecryptedData(msg.data, msg.data.length)
                            return
                        case 'dec_finished':
                            resolve()
                            return
                        case 'dec_aborted':
                            DEBUG_LOG(`decryption aborted due to error: ${msg.error}`)
                            this.aborted = true
                            reject(new Error(msg.error))
                            reject2(new Error(msg.error))
                            return
                    }
                })
            })
        })

        // Wait till both sides are ready.
        block_on(
            notifyTools.notifyBackground({
                command: 'dec_init',
                msgId: this.msgId,
            })
        )

        // Both sides are ready, start reading from metadata.
        notifyTools.notifyBackground({ command: 'dec_metadata', msgId: this.msgId })
    },

    onDataAvailable: function (req, stream, offset, count) {
        DEBUG_LOG(
            `onDataAvailable: onGoing: ${this.sessionOnGoing}, aborted: ${this.aborted}, count: ${count}`
        )
        if (this.aborted || count === 0) return
        if (this.sessionOnGoing) {
            // If a session is still ongoing, block until it completes
            // then, signal for the decryption to start.
            try {
                DEBUG_LOG('blocking on session')
                block_on(this.sessionPromise)
                notifyTools.notifyBackground({ command: 'dec_start', msgId: this.msgId })
            } catch (e) {
                DEBUG_LOG('sessionPromise rejected')
                return
            }
        }

        this.inStream.setInputStream(stream)
        const data = this.inStream.readBytes(count)

        // Check if the data is base64 encoded.
        let b64
        try {
            b64 = btoa(data)
        } catch (e) {
            b64 = data
        }

        // Ignore the newlines
        if (b64 == '\n') return

        this.buffer += b64
        this.bufferCount += count

        if (this.bufferCount > MIN_BUFFER) {
            block_on(
                notifyTools.notifyBackground({
                    command: 'dec_ct',
                    msgId: this.msgId,
                    data: this.buffer,
                })
            )

            this.buffer = ''
            this.bufferCount = 0
        }
    },

    onStopRequest: function (request, status) {
        DEBUG_LOG('mimeDecrypt.jsm: onStartRequest(): start\n')
        if (this.bufferCount > 0) {
            block_on(
                notifyTools.notifyBackground({
                    command: 'dec_ct',
                    msgId: this.msgId,
                    data: this.buffer,
                })
            )
        }

        notifyTools.notifyBackground({ command: 'dec_finalize', msgId: this.msgId })

        try {
            block_on(this.finishedPromise)
        } catch (e) {
            ERROR_LOG(e)
            throw e
        } finally {
            notifyTools.removeListener(this.listener)
            DEBUG_LOG(`mimeDecrypt.jsm: onStopRequest(): completed\n Success: ${!this.aborted}`)
        }
    },
}

// Factory used to register the component in Thunderbird
class Factory {
    constructor(component) {
        this.component = component
        this.register()
        Object.freeze(this)
    }

    createInstance(outer, iid) {
        if (outer) {
            throw Cr.NS_ERROR_NO_AGGREGATION
        }
        return new this.component()
    }

    register() {
        Cm.registerFactory(
            this.component.prototype.classID,
            this.component.prototype.classDescription,
            this.component.prototype.contractID,
            this
        )
    }

    unregister() {
        Cm.unregisterFactory(this.component.prototype.classID, this)
    }
}

// Exported API that will register and unregister the class Factory
var IRMAsealMimeDecrypt = {
    startup: function (reason) {
        try {
            this.factory = new Factory(MimeDecryptHandler)

            // re-use the PGP/MIME handler for our own purposes
            // only required if you want to decrypt something else than Content-Type: multipart/encrypted

            let reg = Components.manager.QueryInterface(Ci.nsIComponentRegistrar)
            let pgpMimeClass = Components.classes['@mozilla.org/mimecth;1?type=multipart/encrypted']

            reg.registerFactory(
                pgpMimeClass,
                'IRMASeal Decryption Module',
                '@mozilla.org/mimecth;1?type=application/irmaseal',
                null
            )
        } catch (ex) {
            DEBUG_LOG(ex.message)
        }
    },

    shutdown: function (reason) {
        if (this.factory) {
            this.factory.unregister()
        }
    },
}
