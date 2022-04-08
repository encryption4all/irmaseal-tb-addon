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
const { MailServices } = Cu.import('resource:///modules/MailServices.jsm')
const { MailUtils } = Cu.import('resource:///modules/MailUtils.jsm')

const extension = ExtensionParent.GlobalManager.getExtension('pg4tb@e4a.org')
const { notifyTools } = Cu.import(extension.rootURI.resolve('pg4tb/notifyTools.js'))
const { block_on, folderPathToURI } = Cu.import(extension.rootURI.resolve('pg4tb/utils.jsm'))
const { clearTimeout, setTimeout } = ChromeUtils.import('resource://gre/modules/Timer.jsm')

// contract IDs
const IRMASEAL_ENCRYPT_CONTRACTID = '@e4a/irmaseal/compose-encrypted;1'
const IRMASEAL_JS_ENCRYPT_CID = Components.ID('{2b7a8e39-88d6-4ed2-91ec-f2aaf964be95}')

const DEBUG_LOG = (str) => Services.console.logStringMessage(`[experiment]: ${str}`)
const ERROR_LOG = (ex) => DEBUG_LOG(`exception: ${ex.toString()}, stack: ${ex.stack}`)

function MimeEncrypt() {
    this.wrappedJSObject = this
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

    init(windowId, tabId, accountId, copyPath) {
        this.windowId = windowId
        this.tabId = tabId
        if (accountId && copyPath) this.copySentFolderURI = folderPathToURI(accountId, copyPath)
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
        DEBUG_LOG(
            `mimeEncrypt.jsm: beginCryptoEncapsulation: copySentFolder: ${this.copySentFolder}\n`
        )

        this.outStream = outStream
        this.outStringStream = Cc['@mozilla.org/io/string-input-stream;1'].createInstance(
            Ci.nsIStringInputStream
        )

        this.recipientList = recipientList
        this.msgCompFields = msgCompFields
        this.msgIdentity = msgIdentity
        this.sendReport = sendReport
        this.isDraft = isDraft

        if (this.copySentFolderURI) {
            this.tempFile = Services.dirsvc.get('TmpD', Ci.nsIFile)
            this.tempFile.append('message.eml')
            this.tempFile.createUnique(0, 384) // == 0600, octal is deprecated

            // ensure that file gets deleted on exit, if something goes wrong ...
            let extAppLauncher = Cc['@mozilla.org/mime;1'].getService(Ci.nsPIExternalAppLauncher)
            this.foStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(
                Ci.nsIFileOutputStream
            )
            this.foStream.init(this.tempFile, 2, 0x200, false) // open as "write only"

            extAppLauncher.deleteTemporaryFileOnExit(this.tempFile)
        }

        // Setup a listener waiting for incoming chunks
        DEBUG_LOG(`mimeEncrypt.jsm: adding listener`)

        // After 5 seconds of not receiving data this promise rejects.
        // This is to make sure it never fully blocks.
        this.finished = new Promise((resolve, reject) => {
            var timeout = setTimeout(() => reject('timeout'), 5000)
            this.chunkListener = notifyTools.addListener((msg) => {
                switch (msg.command) {
                    case 'enc_ct':
                        clearTimeout(timeout)
                        timeout = setTimeout(() => reject('timeout'), 5000)

                        this.writeOut(msg.data)
                        break
                    case 'enc_finished':
                        resolve()
                        break
                    case 'enc_aborted':
                        reject(msg.error)
                        break
                }
                return
            })
        })

        block_on(
            notifyTools.notifyBackground({
                command: 'enc_init',
                tabId: this.tabId,
            })
        )

        // Both sides are ready
        notifyTools.notifyBackground({ command: 'enc_start', tabId: this.tabId })

        var headers = ''
        headers += `From: ${msgCompFields.from}\r\n`
        headers += `To: ${msgCompFields.to}\r\n`
        headers += `Subject: ${msgCompFields.subject}\r\n`
        headers += 'MIME-Version: 1.0\r\n'

        if (this.foStream) this.foStream.write(headers, headers.length)
        notifyTools.notifyBackground({ command: 'enc_plain', tabId: this.tabId, data: headers })

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
        if (this.foStream) this.foStream.write(data, length)
        block_on(notifyTools.notifyBackground({ command: 'enc_plain', tabId: this.tabId, data }))
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
        notifyTools.notifyBackground({ command: 'enc_finalize', tabId: this.tabId })

        try {
            block_on(this.finished)
        } catch (e) {
            ERROR_LOG(e)
            abort(e)
        }

        notifyTools.removeListener(this.chunkListener)

        DEBUG_LOG('mimeEncrypt: encryption complete.')

        if (this.foStream) {
            this.foStream.close()
            let tempFile = this.tempFile
            const copyListener = {
                GetMessageId(messageId) {},
                OnProgress(progress, progressMax) {},
                OnStartCopy() {},
                SetMessageKey(key) {
                    DEBUG_LOG(
                        `mimeEncrypt.jsm: copyListener: copyListener: SetMessageKey(${key})\n`
                    )
                },
                OnStopCopy(statusCode) {
                    if (statusCode !== 0) {
                        DEBUG_LOG(
                            `mimeEncrypt.jsm: copyListener: Error copying message: ${statusCode}\n`
                        )
                    }
                    try {
                        tempFile.remove(false)
                    } catch (ex) {
                        DEBUG_LOG('mimeEncrypt.jsm: copyListener: Could not delete temp file\n')
                        ERROR_LOG(ex)
                    }
                },
            }

            DEBUG_LOG(`Copying to folder with URI ${this.copySentFolderURI}`)

            MailServices.copy.copyFileMessage(
                this.tempFile,
                MailUtils.getExistingFolder(this.copySentFolderURI),
                null,
                false,
                0,
                '',
                copyListener,
                null
            )
        }

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

// Factory used to register a component in Thunderbird
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
