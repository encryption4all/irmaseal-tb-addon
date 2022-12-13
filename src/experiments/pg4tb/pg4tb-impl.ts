/**
 * PostGuard thunderbird experiment.
 */

/* global Components: false */

declare const Components
const { classes: Cc, interfaces: Ci, utils: Cu } = Components

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
const files = {}

export default class pg4tb extends ExtensionCommon.ExtensionAPI {
    public getAPI(context) {
        return {
            pg4tb: {
                displayMessage: async function (msgId: number) {
                    const msgHdr = context.extension.messageManager.get(msgId)
                    MailUtils.displayMessageInFolderTab(msgHdr)
                },
                createTempFile: async function (): Promise<number> {
                    const tempFile = Services.dirsvc.get('TmpD', Ci.nsIFile)
                    tempFile.append('temp.eml')
                    tempFile.createUnique(0, 0o600)

                    const foStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(
                        Ci.nsIFileOutputStream
                    )
                    foStream.init(tempFile, 2, 0x200, false) // open as "write only"

                    // ensure that file gets deleted on exit, if something goes wrong ...
                    const extAppLauncher = Cc['@mozilla.org/mime;1'].getService(
                        Ci.nsPIExternalAppLauncher
                    )
                    extAppLauncher.deleteTemporaryFileOnExit(tempFile)
                    files[fileId] = { file: tempFile, stream: foStream }
                    return fileId++
                },
                writeToFile: async function (fileId: number, data: string) {
                    const { stream } = files[fileId]
                    if (!stream) throw new ExtensionError('file not found')
                    stream.write(data, data.length)
                },
                copyFileMessage: function (
                    fileId: number,
                    folder?: any,
                    originalMsgId?: number
                ): Promise<number> {
                    return new Promise((resolve, reject) => {
                        const { file, stream } = files[fileId]
                        if (!file || !stream) throw new ExtensionError('file not found')
                        stream.close()

                        // Handle two cases:
                        // 1. no folder is given: copy in the same folder as original message,
                        // 2. a folder is given: copy to that folder.

                        const originalMsgHdr = originalMsgId
                            ? context.extension.messageManager.get(originalMsgId)
                            : undefined

                        let newFolder: any
                        if (folder) {
                            const uri = folderPathToURI(folder.accountId, folder.path)
                            newFolder = MailUtils.getExistingFolder(uri)
                        } else if (originalMsgHdr) {
                            newFolder = originalMsgHdr.folder
                        } else {
                            file.remove(false)
                            throw new ExtensionError('no destination folder')
                        }

                        let newKey: number
                        let newMsgId = -1

                        const copyListener = {
                            GetMessageId(messageId) {},
                            OnProgress(progress, progressMax) {},
                            OnStartCopy() {},
                            SetMessageKey(key) {
                                newKey = key
                            },
                            OnStopCopy(statusCode: number) {
                                file.remove(false)

                                if (statusCode !== 0) {
                                    return reject(
                                        new ExtensionError(`error copying message: ${statusCode}`)
                                    )
                                }

                                const newHdr = newFolder.GetMessageHeader(newKey)
                                newMsgId = extension.messageManager.convert(newHdr).id

                                if (originalMsgHdr) {
                                    newHdr.markRead(originalMsgHdr.isRead)
                                    newHdr.markFlagged(originalMsgHdr.isFlagged)
                                    newHdr.subject = originalMsgHdr.subject
                                    newHdr.date = originalMsgHdr.date
                                }

                                delete files[fileId]
                                newFolder.updateFolder(null)
                                resolve(newMsgId)
                            },
                        }

                        // console.info(`Copying to folder with URI: ${newFolder.URI}`)

                        MailServices.copy.copyFileMessage(
                            file, // aFile
                            newFolder, // dstFolder
                            null, // msgToReplace (msgHdr)
                            false, // isDraftOrTemplate
                            0, // aMsgFlags
                            '', // aMsgKeywords
                            copyListener, // listener
                            null // msgWindow
                        )
                    })
                },
            },
        }
    }

    public onShutdown(isAppShutdown: boolean): void {
        if (isAppShutdown) return

        Services.obs.notifyObservers(null, 'startupcache-invalidate')
    }
}
