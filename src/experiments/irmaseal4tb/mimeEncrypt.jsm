/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 *  Module for creating PGP/MIME signed and/or encrypted messages
 *  implemented as XPCOM component.
 *  Adapted from: https://gitlab.com/pbrunschwig/thunderbird-encryption-example
 */

/* global Components: false, ChromeUtils: false, NotifyTools: false */

'use strict'

var EXPORTED_SYMBOLS = ['IRMAsealMimeEncrypt']

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components

Cm.QueryInterface(Ci.nsIComponentRegistrar)

const Services = Cu.import('resource://gre/modules/Services.jsm').Services
const { ExtensionCommon } = ChromeUtils.import('resource://gre/modules/ExtensionCommon.jsm')
const { ExtensionParent } = ChromeUtils.import('resource://gre/modules/ExtensionParent.jsm')

const extension = ExtensionParent.GlobalManager.getExtension('irmaseal4tb@e4a.org')
const { notifyTools } = Cu.import(extension.rootURI.resolve('irmaseal4tb/notifyTools.js'))

// contract IDs
const IRMASEAL_ENCRYPT_CONTRACTID = '@e4a/irmaseal/compose-encrypted;1'
const IRMASEAL_JS_ENCRYPT_CID = Components.ID('{2b7a8e39-88d6-4ed2-91ec-f2aaf964be95}')

const DEBUG_LOG = (str) => Services.console.logStringMessage(`[experiment]: ${str}`)
const ERROR_LOG = (ex) => DEBUG_LOG(`exception: ${ex.toString()}, stack: ${ex.stack}`)

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

    recipientList: null,
    msgCompFields: null,
    msgIdentity: null,
    isDraft: null,
    sendReport: null,

    outStream: null,
    outStringStream: null,
    outBuffer: '',

    init(windowId, tabId) {
        this.windowId = windowId
        this.tabId = tabId
    },

    block_on(promise) {
        const inspector = Cc['@mozilla.org/jsinspector;1'].createInstance(Ci.nsIJSInspector)
        let synchronous = null
        promise
            .then((result) => {
                synchronous = result
                inspector.exitNestedEventLoop()
            })
            .catch((error) => {
                synchronous = error
                inspector.exitNestedEventLoop()
            })

        inspector.enterNestedEventLoop(0)
        if (synchronous instanceof Error) throw synchronous
        return synchronous
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

        // Setup a listener waiting for incoming chunks
        DEBUG_LOG(`mimeEncrypt.jsm: adding listener`)

        this.finished = new Promise((resolve, reject) => {
            this.chunkListener = notifyTools.addListener((msg) => {
                switch (msg.command) {
                    case 'headers':
                    case 'ct':
                        this.writeOut(msg.data)
                        break
                    case 'finished':
                        resolve()
                        break
                    case 'aborted':
                        reject(msg.error)
                        break
                }
                return 
            })
        })

        this.block_on(
            notifyTools.notifyBackground({
                command: 'init',
                tabId: this.tabId,
            })
        )

        // Both sides are ready
        notifyTools.notifyBackground({command: 'start', tabId: this.tabId})

        DEBUG_LOG(`mimeEncrypt.jsm: beginCryptoEncapsulation(): finish\n`)
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
    mimeCryptoWriteBlock: function (data, length) {
        //DEBUG_LOG(`mimeEncrypt.jsm: mimeCryptoWriteBlock(): ${length}\n`)

        notifyTools.notifyBackground({ command: 'chunk', tabId: this.tabId, data })

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
        DEBUG_LOG(`mimeEncrypt.jsm: finishCryptoEncapsulation()\n`)

        // Notify background that no new chunks will be coming.
        notifyTools.notifyBackground({ command: 'finalize', tabId: this.tabId })

        this.block_on(this.finished)

        notifyTools.removeListener(this.chunkListener)
        DEBUG_LOG(`mimeEncrypt.jsm: finishCryptoEncapsulation(): done\n`)
    },

    writeOut: function (content) {
        DEBUG_LOG(`mimeEncrypt.jsm: writeOut: wrote ${content.length} bytes\n`)
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
