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

var EXPORTED_SYMBOLS = ['PostGuardMimeDecrypt']

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

const MIME_JS_DECRYPTOR_CONTRACTID = '@mozilla.org/mime/pgp-mime-js-decrypt;1'
const MIME_JS_DECRYPTOR_CID = Components.ID('{f3a50b87-b198-42c0-86d9-116aca7180b3}')

const DEBUG_LOG = (str) => Services.console.logStringMessage(`[experiment]: ${str}`)
const ERROR_LOG = (ex) => DEBUG_LOG(`exception: ${ex.toString()}, stack: ${ex.stack}`)

// Minimal buffer size before sending buffered data to the background script.
const MIN_BUFFER = 1024

// Time after which a session is assumed aborted.
const SESSION_TIMEOUT = 60000

// Maximum time before the decryption handler expects an answer to a message.
const MSG_TIMEOUT = 3000

function MimeDecryptHandler() {
    // DEBUG_LOG('mimeDecrypt.jsm: new MimeDecryptHandler()\n')
    this._init()
}

MimeDecryptHandler.prototype = {
    classDescription: 'PostGuard/MIME JS Decryption Handler',
    classID: MIME_JS_DECRYPTOR_CID,
    contractID: MIME_JS_DECRYPTOR_CONTRACTID,
    QueryInterface: ChromeUtils.generateQI([Ci.nsIStreamListener]),

    inStream: Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream),

    _init: function () {
        this.mimeProxy = null
        this.originalMsgHdr = null
        this.msgId = null
        this.request = null
    },

    // the MIME handler needs to implement the nsIStreamListener API
    onStartRequest: function (request) {
        this.mimeProxy = request.QueryInterface(Ci.nsIPgpMimeProxy)
        this.uri = this.mimeProxy.messageURI
        this.request = request
        this.originalMsgHdr = this.uri.QueryInterface(Ci.nsIMsgMessageUrl).messageHeader
        this.folder = this.originalMsgHdr.folder
        this.msgId = extension.messageManager.convert(this.originalMsgHdr).id
        this.buffer = ''
        this.bufferCount = 0
        this.sessionStarted = false
        this.sessionCompleted = false
        this.aborted = false

        // DEBUG_LOG(`mimeDecrypt.jsm: onStartRequest(), id: ${this.msgId}`)

        this.finishedPromise = new Promise((resolve, reject) => {
            this.sessionPromise = new Promise((resolve2, reject2) => {
                var timeout = setTimeout(() => reject(new Error('init timeout exceeded')), 10000)

                this.listener = notifyTools.addListener((msg) => {
                    if (msg.msgId !== this.msgId) return
                    switch (msg.command) {
                        case 'dec_session_start':
                            DEBUG_LOG('session started')
                            this.sessionStarted = true
                            clearTimeout(timeout)
                            timeout = setTimeout(
                                () => reject(new Error('session timeout exceeded')),
                                SESSION_TIMEOUT
                            )
                            break
                        case 'dec_session_complete':
                            DEBUG_LOG('session complete')
                            this.sessionCompleted = true
                            this.initFile()
                            resolve2()
                            break
                        case 'dec_plain':
                            clearTimeout(timeout)
                            timeout = setTimeout(
                                () => reject(new Error('plaintext chunks timeout exceeded')),
                                MSG_TIMEOUT
                            )
                            // this.mimeProxy.outputDecryptedData(msg.data, msg.data.length)
                            this.foStream.write(msg.data, msg.data.length)
                            break
                        case 'dec_finished':
                            DEBUG_LOG('decryption complete')
                            clearTimeout(timeout)
                            resolve()
                            return
                        case 'dec_aborted':
                            DEBUG_LOG(`decryption aborted due to error: ${msg.error}`)
                            this.aborted = true
                            clearTimeout(timeout)
                            reject(new Error(msg.error))
                            reject2(new Error(msg.error))
                            break
                        default:
                            break
                    }
                    return
                })

                this.shutdownObserver = {
                    QueryInterface: ChromeUtils.generateQI([Ci.nsIObserver]),
                    observe: function (aSubject, aTopic, aData) {
                        if (aTopic === 'mime-decrypt-shutdown') {
                            this.aborted = true
                            const err = new Error('extension shutdown during decryption')
                            reject(err)
                            reject2(err)
                        }
                    },
                }
                Services.obs.addObserver(this.shutdownObserver, 'mime-decrypt-shutdown')
            })
        })

        // Wait till both sides are ready.
        this.aborted = block_on(
            Promise.race([
                new Promise((resolve, _) => setTimeout(resolve, MSG_TIMEOUT, true)),
                notifyTools
                    .notifyBackground({
                        command: 'dec_init',
                        msgId: this.msgId,
                    })
                    .then(() => this.aborted),
            ])
        )

        if (this.aborted) {
            // aborted after init, ignore the request
            // DEBUG_LOG('aborted after init')
            return
        }

        this.copyReceivedFolderPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(
                reject,
                MSG_TIMEOUT,
                new Error('waiting for copyFolder too long')
            )
            this.copyFolderListener = notifyTools.addListener((msg) => {
                if (msg.msgId !== this.msgId) return
                else if (msg.command === 'dec_copy_folder') {
                    clearTimeout(timer)
                    resolve(msg.folder)
                }
                return
            })
        })

        // Both sides are ready and there was no error during initialization,
        // so start sending (first meta, then regular) data to the background.
        notifyTools.notifyBackground({ command: 'dec_metadata', msgId: this.msgId })
    },

    onDataAvailable: function (req, stream, offset, count) {
        if (this.aborted) {
            // TODO: We could just send the encrypted data in this case.
            // this.mimeProxy.outputDecryptedData(b64, b64.length)
            return
        }
        if (count === 0) return

        DEBUG_LOG(
            `onDataAvailable: started: ${this.sessionStarted}, completed: ${this.sessionCompleted}, aborted: ${this.aborted}, count: ${count}`
        )

        this.inStream.setInputStream(stream)
        const data = this.inStream.readBytes(count)

        if (this.sessionStarted && !this.sessionCompleted) {
            try {
                block_on(this.sessionPromise)
                notifyTools.notifyBackground({ command: 'dec_start', msgId: this.msgId })
            } catch {
                DEBUG_LOG('session not completed')
                return
            }
        }

        // Check if the data is base64 encoded.
        // Note: In older versions, we might get the data differently.
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
            notifyTools.notifyBackground({
                command: 'dec_ct',
                msgId: this.msgId,
                data: this.buffer,
            })

            this.buffer = ''
            this.bufferCount = 0
        }
    },

    onStopRequest: function (request, status) {
        if (this.aborted) {
            if (this.foStream) this.foStream.close()
            if (this.tempFile) this.tempFile.remove(false)
            this.removeListeners()
            return
        }

        DEBUG_LOG(`mimeDecrypt.jsm: onStopRequest(), aborted: ${this.aborted}\n`)

        // Flush the remaining buffer.
        if (this.bufferCount) {
            notifyTools.notifyBackground({
                command: 'dec_ct',
                msgId: this.msgId,
                data: this.buffer,
            })
        }

        try {
            if (!this.sessionCompleted) block_on(this.sessionPromise)
            notifyTools.notifyBackground({ command: 'dec_start', msgId: this.msgId })
            notifyTools.notifyBackground({ command: 'dec_finalize', msgId: this.msgId })
            block_on(this.finishedPromise)
        } finally {
            if (this.foStream) this.foStream.close()
            this.removeListeners()
        }
        if (this.aborted) return

        DEBUG_LOG(`mimeDecrypt.jsm: onStopRequest(): succesfully completed: ${!this.aborted}`)

        this.copyReceivedFolderPromise
            .then((copyReceivedFolder) => {
                const { accountId, path } = copyReceivedFolder
                const copyReceivedFolderURI = folderPathToURI(accountId, path)
                return copyReceivedFolderURI
            })
            .catch((e) => {
                return undefined
            })
            .then((copyReceivedFolderURI) => {
                const file = this.tempFile
                const newFolder = copyReceivedFolderURI
                    ? MailUtils.getExistingFolder(copyReceivedFolderURI)
                    : this.folder
                const originalMsgHdr = this.originalMsgHdr
                const origMsgId = this.msgId

                let newKey
                const copyListener = {
                    GetMessageId(messageId) {},
                    OnProgress(progress, progressMax) {},
                    OnStartCopy() {
                        DEBUG_LOG(`mimeDecrypt.jsm: copyListener: OnStartCopy`)
                    },
                    SetMessageKey(key) {
                        DEBUG_LOG(`mimeDecrypt.jsm: copyListener: SetMessageKey(${key})`)
                        newKey = key
                    },
                    OnStopCopy(statusCode) {
                        DEBUG_LOG(`mimeDecrypt.jsm: copyListener: OnStopCopy`)
                        if (statusCode !== 0) {
                            DEBUG_LOG(
                                `mimeDecrypt.jsm: copyListener: Error copying message: ${statusCode}`
                            )
                            return
                        }
                        try {
                            file.remove(false)
                        } catch (ex) {
                            DEBUG_LOG('mimeDecrypt.jsm: copyListener: Could not delete temp file')
                            ERROR_LOG(ex)
                        }

                        const newHdr = newFolder.GetMessageHeader(newKey)
                        const newId = extension.messageManager.convert(newHdr).id

                        // TODO: this does not seem to work.
                        newHdr.markRead(originalMsgHdr.isRead)
                        newHdr.markFlagged(originalMsgHdr.isFlagged)
                        newHdr.subject = originalMsgHdr.subject
                        newHdr.date = originalMsgHdr.date

                        // Notify the background that copying completed, such that we can display
                        // this new message.
                        notifyTools.notifyBackground({
                            command: 'dec_copy_complete',
                            msgId: origMsgId,
                            newMsgId: newId,
                        })
                    },
                }

                DEBUG_LOG(`Copying to folder with URI: ${newFolder.URI}`)

                MailServices.copy.copyFileMessage(
                    file, // aFile
                    newFolder, // dstFolder
                    null, // msgToReplace (msgHdr)
                    false, // isDraftOrTemplate
                    null, // aMsgFlags
                    '', // aMsgKeywords
                    copyListener, // listener
                    null // msgWindow
                )
            })
    },

    initFile: function () {
        this.tempFile = Services.dirsvc.get('TmpD', Ci.nsIFile)
        this.tempFile.append('message.eml')
        this.tempFile.createUnique(0, 0o600)

        // ensure that file gets deleted on exit, if something goes wrong ...
        let extAppLauncher = Cc['@mozilla.org/mime;1'].getService(Ci.nsPIExternalAppLauncher)

        this.foStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(
            Ci.nsIFileOutputStream
        )
        this.foStream.init(this.tempFile, 2, 0x200, false) // open as "write only"
        extAppLauncher.deleteTemporaryFileOnExit(this.tempFile)
    },

    removeListeners: function () {
        if (this.listener) notifyTools.removeListener(this.listener)
        Services.obs.removeObserver(this.shutdownObserver, 'mime-decrypt-shutdown')
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
var PostGuardMimeDecrypt = {
    startup: function (reason) {
        try {
            this.factory = new Factory(MimeDecryptHandler)

            // re-use the PGP/MIME handler for our own purposes
            // only required if you want to decrypt something else than Content-Type: multipart/encrypted

            let reg = Components.manager.QueryInterface(Ci.nsIComponentRegistrar)
            let pgpMimeClass = Components.classes['@mozilla.org/mimecth;1?type=multipart/encrypted']

            reg.registerFactory(
                pgpMimeClass,
                'PostGuard Decryption Module',
                '@mozilla.org/mimecth;1?type=application/postguard',
                null
            )
        } catch (ex) {
            DEBUG_LOG(ex.message)
        }
    },

    shutdown: function (reason) {
        Services.obs.notifyObservers(null, 'mime-decrypt-shutdown')
        notifyTools.removeAllListeners()

        if (this.factory) {
            this.factory.unregister()
        }
    },
}
