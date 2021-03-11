/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*global Components: false */

'use strict'

/**
 *  Module for creating PGP/MIME signed and/or encrypted messages
 *  implemented as XPCOM component
 */

const Cc = Components.classes
const Ci = Components.interfaces
const Cr = Components.results
const Cu = Components.utils
const Cm = Components.manager
Cm.QueryInterface(Ci.nsIComponentRegistrar)

const Services = Cu.import('resource://gre/modules/Services.jsm').Services
const XPCOMUtils = Cu.import('resource://gre/modules/XPCOMUtils.jsm').XPCOMUtils

// contract IDs
const IRMASEAL_ENCRYPT_CONTRACTID = '@e4a/irmaseal/compose-encrypted;1'
const IRMASEAL_JS_ENCRYPT_CID = Components.ID(
    '{2b7a8e39-88d6-4ed2-91ec-f2aaf964be94}'
)

var gDebugLogLevel = 0

function MimeEncrypt() {}

MimeEncrypt.prototype = {
    classDescription: 'IRMAseal Encryption Handler',
    classID: IRMASEAL_JS_ENCRYPT_CID,
    get contractID() {
        return IRMASEAL_ENCRYPT_CONTRACTID
    },

    QueryInterface: XPCOMUtils.generateQI(['nsIMsgComposeSecure']),

    recicpientList: null,
    msgCompFields: null,
    msgIdentity: null,
    isDraft: null,
    sendReport: null,

    outStream: null,
    outStringStream: null,
    inBuffer: '',
    outBuffer: '',

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
        DEBUG('mimeEncrypt.jsm: requiresCryptoEncapsulation()\n')
        return true
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
        DEBUG('mimeEncrypt.jsm: beginCryptoEncapsulation()\n')

        this.outStream = outStream
        this.outStreamString = Cc[
            '@mozilla.org/io/string-input-stream;1'
        ].createInstance(Ci.nsIStringInputStream)

        this.recipientList = recipientList
        this.msgCompFields = msgCompFields
        this.msgIdentity = msgIdentity
        this.sendReport = sendReport
        this.isDraft = isDraft

        let headers = {
            Subject: `${msgCompFields.subject}`,
            To: `${recipientList}`,
            From: `${msgIdentity.email}`,
            'MIME-Version': '1.0',
            'Content-Type': `multipart/encrypted; protocol="application/irmaseal-encrypted"; boundary=${boundary}`,
        }

        str = ''
        for (const [k, v] in Object.entries(headers)) {
            str += `${k}: ${v}\r\n`
        }
        str += '\r\n'

        this.writeOut(str)
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
        if (gDebugLogLevel > 4)
            DEBUG(`mimeEncrypt.jsm: mimeCryptoWriteBlock(): ${length}\n`)

        this.inBuffer += buffer.substr(0, length)
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
        DEBUG('mimeEncrypt.jsm: finishCryptoEncapsulation()\n')

        let encryptedData = this.encryptData() + '\r\n'
        this.writeOut(encryptedData)
    },

    encryptData: function () {
        // replace with IRMAseal encryption.
        return btoa(this.outBuffer).replace(/(.{72})/g, '$1\r\n')
    },

    writeOut: function (str) {
        this.outStringStream.setData(str, str.length)
        var writeCount = this.outStream.writeFrom(
            this.outStringStream,
            str.length
        )
        if (writeCount < str.length) {
            DEBUG(
                `mimeEncrypt.jsm: writeOut: wrote ${writeCount} instead of  ${str.length} bytes\n`
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

function DEBUG(str) {
    if (gDebugLogLevel > 0) {
        try {
            Services.console.logStringMessage(str)
        } catch (x) {}
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

var EXPORTED_SYMBOLS = ['IRMAsealMimeEncrypt']
