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

function MimeDecryptHandler() {
    DEBUG_LOG('mimeDecrypt.jsm: new MimeDecryptHandler()\n')
    this.mimeProxy = null
    this.msgHdr = null
    this.msgId = null // headerMessageId
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
        this.headersProcessed = false

        if (this.uri) {
            this.msgHdr = this.uri.QueryInterface(Ci.nsIMsgMessageUrl).messageHeader
            //this.msgId = this.msgHdr.messageId
            // use this line to convert the msgHdr to an Extension `Message` type.
            this.msgId = extension.messageManager.convert(this.msgHdr).id
            DEBUG_LOG(`msgId: ${this.msgId}`)
        }

        // add a listener to wait for decrypted blocks
        this.finished = new Promise((resolve, reject) => {
            var timeout = setTimeout(() => reject('timeout'), 5000)
            this.chunkListener = notifyTools.addListener((msg) => {
                switch (msg.command) {
                    case 'dec_session_started':
                        clearTimeout(timeout)
                        timeout = setTimeout(() => reject('timeout'), 10000)
                        break
                    case 'dec_ct':
                        clearTimeout(timeout)
                        timeout = setTimeout(() => reject('timeout'), 5000)

                        this.mimeProxy.outputDecryptedData(msg.data)
                        break
                    case 'dec_finished':
                        resolve()
                        break
                    case 'dec_aborted':
                        reject(msg.error)
                        break
                }
                return
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
        this.inStream.setInputStream(stream)
        if (count > 0) {
            const data = this.inStream.readBytes(count)

            if (data !== '\n')
                notifyTools.notifyBackground({
                    command: 'dec_chunk',
                    msgId: this.msgId,
                    data,
                })
        }
    },

    onStopRequest: function (request, status) {
        notifyTools.notifyBackground({ command: 'dec_finish', msgId: this.msgId })

        try {
            block_on(this.finished)
        } catch (e) {
            ERROR_LOG(e)
            this.mimeProxy.abort(e)
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
