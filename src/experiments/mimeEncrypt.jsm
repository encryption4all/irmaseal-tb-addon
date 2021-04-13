/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 *  Module for creating PGP/MIME signed and/or encrypted messages
 *  implemented as XPCOM component.
 *  Adapted from: https://gitlab.com/pbrunschwig/thunderbird-encryption-example
 */

/* global Components: false, ChromeUtils: false */

'use strict'

var EXPORTED_SYMBOLS = ['IRMAsealMimeEncrypt']

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components

Cm.QueryInterface(Ci.nsIComponentRegistrar)

const Services = Cu.import('resource://gre/modules/Services.jsm').Services
var { ExtensionCommon } = ChromeUtils.import('resource://gre/modules/ExtensionCommon.jsm')

// contract IDs
const IRMASEAL_ENCRYPT_CONTRACTID = '@e4a/irmaseal/compose-encrypted;1'
const IRMASEAL_JS_ENCRYPT_CID = Components.ID('{2b7a8e39-88d6-4ed2-91ec-f2aaf964be95}')

const DEBUG_LOG = (str) => Services.console.logStringMessage(`[experiment]: ${str}`)
const ERROR_LOG = (ex) => DEBUG_LOG(`exception: ${ex.toString()}, stack: ${ex.stack}`)
const BOUNDARY = 'foo'

function MimeEncrypt() {
    this.wrappedJSObject = this
    this.sampleValue = null
}

MimeEncrypt.prototype = {
    classDescription: 'IRMAseal Encryption Handler',
    classID: IRMASEAL_JS_ENCRYPT_CID,
    get contractID() {
        return IRMASEAL_ENCRYPT_CONTRACTID
    },

    QueryInterface: ChromeUtils.generateQI(['nsIMsgComposeSecure']),

    recicpientList: null,
    msgCompFields: null,
    msgIdentity: null,
    isDraft: null,
    sendReport: null,

    outStream: null,
    outStringStream: null,
    outBuffer: '',
    val: null,

    init: function (val) {
        this.val = val
    },

    /**
     * Determine if encryption is required or not
     * (nsIMsgComposeSecure interface)
     *
     * @param {nsIMsgIdentity}   msgIdentity:   the sender's identity
     * @param {nsIMsgCompFields} msgCompFields: the msgCompFields object of the composer window
     *
     * @return {Boolean}:  true if the message should be encrypted, false otherwiese
     */
    requiresCryptoEncapsulation: function (msgIdentity, msgCompFields) {
        DEBUG_LOG('mimeEncrypt.jsm: requiresCryptoEncapsulation()\n')

        //if ('securityInfo' in msgCompFields) {
        //    try {
        //        // TB < 64 holds the relevant data in securityInfo.
        //        let secInfo = msgCompFields.securityInfo.wrappedJSObject
        //        this.sampleValue = secInfo.sampleValue
        //    } catch (ex) {
        //        return false
        //    }
        //}
        return this.val != null
    },

    /**
     * Prepare for encrypting the data (called before we get the message data)
     * (nsIMsgComposeSecure interface)
     *
     * @param {nsIOutputStream}      outStream: the stream that will consume the result of our decryption
     * @param {String}           recipientList: List of recipients, separated by space
     * @param {nsIMsgCompFields} msgCompFields: the msgCompFields object of the composer window
     * @param {nsIMsgIdentity}     msgIdentity: the sender's identity
     * @param {nsIMsgSendReport}    sendReport: report progress to TB
     * @param {Boolean}                isDraft: true if saving draft
     *
     * (no return value)
     */
    beginCryptoEncapsulation: function (
        outStream,
        recipientList,
        msgCompFields,
        msgIdentity,
        sendReport,
        isDraft
    ) {
        DEBUG_LOG('mimeEncrypt.jsm: beginCryptoEncapsulation()\n')

        this.outStream = outStream
        this.outStringStream = Cc['@mozilla.org/io/string-input-stream;1'].createInstance(
            Ci.nsIStringInputStream
        )

        this.recipientList = recipientList
        this.msgCompFields = msgCompFields
        this.msgIdentity = msgIdentity
        this.sendReport = sendReport
        this.isDraft = isDraft

        const headers = {
            // This is duplicated somehow if left in here..
            // Subject: `${msgCompFields.subject}`,
            // To: `${recipientList}`,
            // From: `${msgIdentity.email}`,
            'MIME-Version': '1.0',
            'Content-Type': `multipart/encrypted; protocol="application/irmaseal"; boundary=${BOUNDARY}`,
        }

        var headerStr = ''
        for (const [k, v] of Object.entries(headers)) {
            headerStr += `${k}: ${v}\r\n`
        }
        headerStr += '\r\n'

        DEBUG_LOG(`mimeEncrypt.jsm: beginCryptoEncapsulation(): writing headers:\n${headerStr}\n`)
        this.writeOut(headerStr)
    },

    /**
     * Encrypt a block of data (we are getting called for every bit of
     * data that TB sends to us). Most likely the data gets fed line by line
     * (nsIMsgComposeSecure interface)
     *
     * @param {String} buffer: buffer containing the data
     * @param {Number} length: number of bytes
     *
     * (no return value)
     */
    mimeCryptoWriteBlock: function (buffer, length) {
        DEBUG_LOG(`mimeEncrypt.jsm: mimeCryptoWriteBlock(): ${length}\n`)

        this.outBuffer += buffer.substr(0, length)
        return null
    },

    /**
     * we got all data; time to return something to Thunderbird
     * (nsIMsgComposeSecure interface)
     *
     * @param {Boolean}          abort: if true, sending is aborted
     * @param {nsIMsgSendReport} sendReport: report progress to TB
     *
     * (no return value)
     */
    finishCryptoEncapsulation: function (abort, sendReport) {
        DEBUG_LOG('mimeEncrypt.jsm: finishCryptoEncapsulation()\n')
        const encryptedData = this.val.replace(/(.{80})/g, '$1\n')

        var content = 'This is an IRMAseal/MIME encrypted message.\r\n\r\n'
        content += `--${BOUNDARY}\r\n`
        content += 'Content-Type: application/irmaseal\r\n\r\n'
        content += 'Version: 1\r\n\r\n'
        content += `--${BOUNDARY}\r\n`
        content += 'Content-Type: application/octet-stream\r\n\r\n'
        content += `${encryptedData}\r\n\r\n`
        content += `--${BOUNDARY}--\r\n`

        DEBUG_LOG(`mimeEncrypt.jsm: finishCryptoEncapsulation: writing content:\n${content}`)
        this.writeOut(content)
    },
    writeOut: function (content) {
        this.outStringStream.setData(content, content.length)
        var writeCount = this.outStream.writeFrom(this.outStringStream, content.length)
        if (writeCount < content.length) {
            DEBUG_LOG(
                `mimeEncrypt.jsm: writeOut: wrote ${writeCount} instead of  ${content.length} bytes\n`
            )
        }
    },
}

/**
 * Factory used to register a component in Thunderbird
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

// Exported API that will register and unregister the class Factory

var IRMAsealMimeEncrypt = {
    startup: function (reason) {
        this.factory = new Factory(MimeEncrypt)
    },

    shutdown: function (reason) {
        if (this.factory) {
            this.factory.unregister()
        }
    },
}
