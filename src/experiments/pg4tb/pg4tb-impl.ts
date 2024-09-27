/**
 * PostGuard thunderbird experiment.
 */

/* global Components: false */

declare const Components
const { classes: Cc, interfaces: Ci, utils: Cu } = Components

const { ExtensionError } = Cu.import('resource://gre/modules/ExtensionError.jsm')
const { ExtensionCommon } = Cu.import('resource://gre/modules/ExtensionCommon.jsm')
const { ExtensionParent } = Cu.import('resource://gre/modules/ExtensionParent.jsm')
const { Services } = Cu.import('resource://gre/modules/Services.jsm')
const { MailUtils } = Cu.import('resource:///modules/MailUtils.jsm')
const { MailServices } = Cu.import('resource:///modules/MailServices.jsm')

const extension = ExtensionParent.GlobalManager.getExtension('pg4tb@e4a.org')

function folderPathToURI(accountId: number, path: string): string {
    const server = MailServices.accounts.getAccount(accountId).incomingServer
    const rootURI = server.rootFolder.URI
    if (path == '/') {
        return rootURI
    }
    // The .URI property of an IMAP folder doesn't have %-encoded characters.
    // If encoded here, the folder lookup service won't find the folder.
    if (server.type == 'imap') {
        return rootURI + path
    }
    return (
        rootURI +
        path
            .split('/')
            .map((p) =>
                encodeURIComponent(p).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))
            )
            .join('/')
    )
}

let fileId = 0
const files = new Map()

export default class pg4tb extends ExtensionCommon.ExtensionAPI {
    public getAPI(context) {
        return {
            pg4tb: {
                displayMessage: async function (msgId: number): Promise<void> {
                    const msgHdr = context.extension.messageManager.get(msgId)
                    if (!msgHdr) throw new ExtensionError(`error showing message: ${msgId}`)

                    MailUtils.displayMessageInFolderTab(msgHdr)
                },
                createTempFile: async function (): Promise<number> {
                    try {
                        const tempFile = Services.dirsvc.get('TmpD', Ci.nsIFile)
                        tempFile.append('temp.eml')
                        tempFile.createUnique(0, 0o600)

                        const foStream = Cc[
                            '@mozilla.org/network/file-output-stream;1'
                        ].createInstance(Ci.nsIFileOutputStream)
                        foStream.init(tempFile, 2, 0x200, false) // open as "write only"

                        // ensure that file gets deleted on exit, if something goes wrong ...
                        const extAppLauncher = Cc['@mozilla.org/mime;1'].getService(
                            Ci.nsPIExternalAppLauncher
                        )
                        extAppLauncher.deleteTemporaryFileOnExit(tempFile)
                        files.set(fileId, { file: tempFile, stream: foStream })

                        return fileId++
                    } catch (ex) {
                        throw new ExtensionError(
                            `error creating temporary file: ${(ex as Error).message}`
                        )
                    }
                },
                writeToFile: async function (fileId: number, data: string) {
                    const { stream } = files.get(fileId)
                    if (!stream) throw new ExtensionError('file not found')

                    stream.write(data, data.length)
                },
                copyFileMessage: async function (
                    fileId: number,
                    folder?: any,
                    originalMsgId?: number
                ): Promise<number> {
                    const { file, stream } = files.get(fileId)
                    if (!file || !stream) throw new ExtensionError('file not found')
                    stream.close()

                    let destinationFolder: any
                    if (folder) {
                        const uri = folderPathToURI(folder.accountId, folder.path)
                        destinationFolder = MailUtils.getExistingFolder(uri)
                    } else {
                        file.remove(false)
                        throw new ExtensionError('no destination folder')
                    }

                    try {
                        const msgHdr = await new Promise((resolve, reject) => {
                            let newKey: number
                            const msgHdrs = new Map()

                            const folderListener = {
                                onMessageAdded(parentItem, msgHdr) {
                                    if (destinationFolder.URI != msgHdr.folder.URI) {
                                        return
                                    }
                                    const key = msgHdr.messageKey
                                    msgHdrs.set(key, msgHdr)
                                    if (msgHdrs.has(newKey)) {
                                        finish(msgHdrs.get(newKey))
                                    }
                                },
                                onFolderAdded(parent, child) {},
                            }

                            MailServices.mailSession.AddFolderListener(
                                folderListener,
                                Ci.nsIFolderListener.added
                            )

                            const finish = (msgHdr) => {
                                MailServices.mailSession.RemoveFolderListener(folderListener)

                                // if there was an original message, copy the date etc.
                                if (originalMsgId) {
                                    const originalHdr =
                                        context.extension.messageManager.get(originalMsgId)
                                    msgHdr.markRead(originalHdr.isRead)
                                    msgHdr.markFlagged(originalHdr.isFlagged)
                                    msgHdr.date = originalHdr.date
                                }

                                resolve(msgHdr)
                            }

                            const copyListener = {
                                GetMessageId(messageId) {},
                                OnProgress(progress, progressMax) {},
                                OnStartCopy() {},
                                SetMessageKey(aKey) {
                                    newKey = aKey
                                    if (msgHdrs.has(newKey)) {
                                        finish(msgHdrs.get(newKey))
                                    }
                                },
                                OnStopCopy(statusCode: number) {
                                    if (statusCode !== 0) {
                                        return reject(
                                            new ExtensionError(
                                                `error copying message: ${statusCode}`
                                            )
                                        )
                                    }
                                    if (newKey && msgHdrs.has(newKey)) {
                                        finish(msgHdrs.get(newKey))
                                    }
                                },
                            }

                            // console.info(`Copying to folder with URI: ${newFolder.URI}`)

                            MailServices.copy.copyFileMessage(
                                file, // aFile
                                destinationFolder, // dstFolder
                                null, // msgToReplace (msgHdr)
                                false, // isDraftOrTemplate
                                0, // aMsgFlags
                                '', // aMsgKeywords
                                copyListener, // listener
                                null // msgWindow
                            )
                        })

                        const newMsgId = extension.messageManager.convert(msgHdr).id

                        try {
                            files.delete([fileId])
                            if (file.exists()) file.remove(false)
                        } catch (e) {
                            // ignore any errors here, the file gets deleted on shutdown anyway
                        }

                        return newMsgId
                    } catch (ex) {
                        throw ExtensionError(
                            `error during creation of new message from file: ${
                                (ex as Error).message
                            }`
                        )
                    }
                },
            },
        }
    }

    public onShutdown(isAppShutdown: boolean): void {
        if (isAppShutdown) return

        Services.obs.notifyObservers(null, 'startupcache-invalidate')
    }
}
