/**
 * PostGuard thunderbird experiment
 */

/* global Components: false */

declare const Components
const { classes: Cc, interfaces: Ci, utils: Cu } = Components

const { ExtensionCommon } = Cu.import('resource://gre/modules/ExtensionCommon.jsm')
const { Services } = Cu.import('resource://gre/modules/Services.jsm')
const { ExtensionParent } = Cu.import('resource://gre/modules/ExtensionParent.jsm')
const { MailUtils } = Cu.import('resource:///modules/MailUtils.jsm')
const extension = ExtensionParent.GlobalManager.getExtension('pg4tb@e4a.org')

// To load and unload modules
const loadJsm = (path: string) => Cu.import(extension.rootURI.resolve(path))
const unloadJsm = (path: string) => Cu.unload(extension.rootURI.resolve(path))

const DEBUG_LOG = (str: string) => Services.console.logStringMessage(`[EXPERIMENT]: ${str}`)
const ERROR_LOG = (ex) => DEBUG_LOG(`exception: ${ex.toString()}, stack: ${ex.stack}`)

export default class pg4tb extends ExtensionCommon.ExtensionAPI {
    public getAPI(context) {
        return {
            pg4tb: {
                setSecurityInfo: function (
                    windowId: number,
                    tabId: number,
                    originalSubject: string
                ) {
                    DEBUG_LOG('pg4tb.js: setSecurityInfo()\n')
                    let compSec = Cc['@e4a/irmaseal/compose-encrypted;1'].createInstance(
                        Ci.nsIMsgComposeSecure
                    )

                    compSec = compSec.wrappedJSObject
                    compSec.init(windowId, tabId, originalSubject)

                    // Get window by windowId
                    const windowObject = context.extension.windowManager.get(windowId)
                    const win = windowObject.window

                    if (win.gMsgCompose.compFields) {
                        if ('securityInfo' in win.gMsgCompose.compFields) {
                            // TB < 64
                            win.gMsgCompose.compFields.securityInfo = compSec
                        } else {
                            // TB >
                            win.gMsgCompose.compFields.composeSecure = compSec
                        }
                    }
                    DEBUG_LOG('pg4tb.js: setSecurityInfo() complete\n')
                    return Promise.resolve()
                },
                displayMessage: function (msgId: number) {
                    const msgHdr = context.extension.messageManager.get(msgId)
                    MailUtils.displayMessageInFolderTab(msgHdr)
                },
            },
        }
    }

    public onStartup(): void {
        try {
            DEBUG_LOG('starting experiment')
            const { PostGuardMimeEncrypt } = loadJsm('pg4tb/mimeEncrypt.jsm')
            const { PostGuardMimeDecrypt } = loadJsm('pg4tb/mimeDecrypt.jsm')
            PostGuardMimeEncrypt.startup()
            PostGuardMimeDecrypt.startup()
            DEBUG_LOG('all modules loaded')
        } catch (ex) {
            ERROR_LOG(ex)
        }
    }

    public onShutdown(isAppShutdown: boolean): void {
        if (isAppShutdown) {
            DEBUG_LOG('shutting down experiment')
            return
        }

        try {
            DEBUG_LOG('unloading modules')
            const { PostGuardMimeEncrypt } = loadJsm('pg4tb/mimeEncrypt.jsm')
            const { PostGuardMimeDecrypt } = loadJsm('pg4tb/mimeDecrypt.jsm')
            PostGuardMimeEncrypt.shutdown()
            PostGuardMimeDecrypt.shutdown()
            unloadJsm('pg4tb/mimeEncrypt.jsm')
            unloadJsm('pg4tb/mimeDecrypt.jsm')
            DEBUG_LOG('invalidating startup cache')
            Services.obs.notifyObservers(null, 'startupcache-invalidate', null)
            DEBUG_LOG('succesfully shutdown experiment')
        } catch (ex) {
            ERROR_LOG(ex)
        }
    }
}
