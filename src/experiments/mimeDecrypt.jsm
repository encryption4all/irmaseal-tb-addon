/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 *  Module for handling PGP/MIME encrypted messages
 *  implemented as an XPCOM object.
 *  Adapted from: https://gitlab.com/pbrunschwig/thunderbird-encryption-example/-/blob/master/chrome/content/modules/mimeDecrypt.jsm
 */

/* global Components: false, atob: false */

'use strict'

var EXPORTED_SYMBOLS = ['IRMAsealMimeDecrypt']

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components

Cm.QueryInterface(Ci.nsIComponentRegistrar)

const Services = Cu.import('resource://gre/modules/Services.jsm').Services

const MIME_JS_DECRYPTOR_CONTRACTID = '@mozilla.org/mime/pgp-mime-js-decrypt;1'
const MIME_JS_DECRYPTOR_CID = Components.ID('{f3a50b87-b198-42c0-86d9-116aca7180b3}')

const DEBUG_LOG = (str) => Services.console.logStringMessage(`[experiment]: ${str}`)
const ERROR_LOG = (ex) => DEBUG_LOG(`exception: ${ex.toString()}, stack: ${ex.stack}`)

const BOUNDARY = 'foo'

function MimeDecryptHandler() {
    DEBUG_LOG('mimeDecrypt.jsm: new MimeDecryptHandler()\n')
    this.mimeProxy = null
    this.dataBuffer = ''
}

MimeDecryptHandler.prototype = {
    classDescription: 'IRMAseal/MIME JS Decryption Handler',
    classID: MIME_JS_DECRYPTOR_CID,
    contractID: MIME_JS_DECRYPTOR_CONTRACTID,
    QueryInterface: ChromeUtils.generateQI([Ci.nsIStreamListener]),

    inStream: Cc['@mozilla.org/scriptableinputstream;1'].createInstance(
        Ci.nsIScriptableInputStream
    ),

    // the MIME handler needs to implement the nsIStreamListener API
    onStartRequest: function (request, uri) {
        DEBUG_LOG('mimeDecrypt.jsm: onStartRequest()\n')

        this.mimeProxy = request.QueryInterface(Ci.nsIPgpMimeProxy)
    },

    onDataAvailable: function (req, stream, offset, count) {
        this.inStream.init(stream)
        if (count > 0) {
            this.dataBuffer += this.inStream.read(count)
        }
    },

    onStopRequest: function (request, status) {
        let decryptedData = this.decryptData()
        this.mimeProxy.outputDecryptedData(decryptedData, decryptedData.length)
    },

    decryptData: function () {
        DEBUG_LOG(`decrypting dataBuffer:\n${this.dataBuffer}`)

        const [section1, section2, section3] = this.dataBuffer.split(`--${BOUNDARY}`).slice(0, -1)

        const sec1RegExp = /(.*)\r?\n--foo/
        const sec2RegExp = /Content-Type: application\/irmaseal\r?\nVersion: (.*)\r?\n/
        const sec3RegExp = /Content-Type: application\/octet-stream\r?\n(.*)\r?\n/

        const plain = section1.replace(sec1RegExp, '$1')
        const version = section2.replace(sec2RegExp, '$1')
        const bytes = section3.replace(sec3RegExp, '$1')

        // TODO: error handling in case of no match
        //if (!section2.match(sec2RegExp)) {
        //    DEBUG_LOG('not an IRMAseal message')
        //    return
        //}

        //DEBUG_LOG(`plain: ${plain},\n info: ${version},\n bytes: ${bytes}`)

        // For now, just pass the ciphertext bytes to the frontend
        const msg = bytes //atob(bytes.replace(/[\r\n]/g, ''))

        // We need to wrap the result into a multipart/mixed message
        // TODO: can add more here
        let output = ''
        output += `Content-Type: multipart/mixed; boundary="${BOUNDARY}"\r\n\r\n`
        output += `--${BOUNDARY}\r\n`
        output += `Content-Type: text/plain\r\n\r\n`
        output += `${msg}\r\n`
        output += `--${BOUNDARY}--\r\n`

        //DEBUG_LOG(output)
        return output
    },
}

/**
 * Factory used to register the component in Thunderbird
 */

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

var IRMAsealMimeDecrypt = {
    startup: function (reason) {
        try {
            this.factory = new Factory(MimeDecryptHandler)

            // re-use the PGP/MIME handler for our own purposes
            // only required if you want to decrypt something else than Content-Type: multipart/encrypted

            //let reg = Components.manager.QueryInterface(Ci.nsIComponentRegistrar)
            //let pgpMimeClass = Components.classes['@mozilla.org/mimecth;1?type=multipart/encrypted']

            //reg.registerFactory(
            //    pgpMimeClass,
            //    'Sample Decryption Module',
            //    '@mozilla.org/mimecth;1?type=multipart/irmaseal-encrypted',
            //    null
            //)
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
