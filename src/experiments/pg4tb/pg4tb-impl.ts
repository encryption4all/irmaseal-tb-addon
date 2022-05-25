/**
 * PostGuard thunderbird experiment
 */

/* global Components: false */

declare const Components
const { classes: Cc, interfaces: Ci, utils: Cu } = Components

const { ExtensionCommon } = Cu.import('resource://gre/modules/ExtensionCommon.jsm')
const { ExtensionParent } = Cu.import('resource://gre/modules/ExtensionParent.jsm')
const { ExtensionUtils } = Cu.import('resource://gre/modules/ExtensionUtils.jsm')
const { ExtensionError } = ExtensionUtils
const { Services } = Cu.import('resource://gre/modules/Services.jsm')
const { MailUtils } = Cu.import('resource:///modules/MailUtils.jsm')

const extension = ExtensionParent.GlobalManager.getExtension('pg4tb@e4a.org')

const NAMESPACE = 'pg4tb'
const FOLDER = 'modules/'

const DEBUG_LOG = (str: string) => Services.console.logStringMessage(`[EXPERIMENT]: ${str}`)

export default class pg4tb extends ExtensionCommon.ExtensionAPI {
    public getAPI(context) {
        return {
            pg4tb: {
                setSecurityInfo: function (
                    windowId: number,
                    tabId: number,
                    originalSubject: string,
                    plaintextCopies: boolean,
                ) {
                    DEBUG_LOG('pg4tb.js: setSecurityInfo()\n')
                    let compSec = Cc['@e4a/irmaseal/compose-encrypted;1'].createInstance(
                        Ci.nsIMsgComposeSecure
                    )

                    compSec = compSec.wrappedJSObject
                    compSec.init(windowId, tabId, originalSubject, plaintextCopies)

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
        DEBUG_LOG('starting pg4tb experiment')

        const resProto = Cc['@mozilla.org/network/protocol;1?name=resource'].getService(
            Ci.nsISubstitutingProtocolHandler
        )

        if (resProto.hasSubstitution(NAMESPACE))
            throw new ExtensionError(
                `There is already a resource:// url for the namespace "${NAMESPACE}"`
            )

        const uri = Services.io.newURI(FOLDER, null, extension.rootURI)
        resProto.setSubstitutionWithFlags(NAMESPACE, uri, resProto.ALLOW_CONTENT_ACCESS)

        DEBUG_LOG('loading modules')
        const { PostGuardMimeEncrypt } = Cu.import('resource://pg4tb/mimeEncrypt.jsm')
        const { PostGuardMimeDecrypt } = Cu.import('resource://pg4tb/mimeDecrypt.jsm')
        PostGuardMimeEncrypt.startup()
        PostGuardMimeDecrypt.startup()
        DEBUG_LOG('all modules loaded and started')
    }

    public onShutdown(isAppShutdown: boolean): void {
        DEBUG_LOG('shutting down pg4tb experiment')
        if (isAppShutdown) {
            return
        }

        const { PostGuardMimeEncrypt } = Cu.import('resource://pg4tb/mimeEncrypt.jsm')
        const { PostGuardMimeDecrypt } = Cu.import('resource://pg4tb/mimeDecrypt.jsm')
        PostGuardMimeEncrypt.shutdown()
        PostGuardMimeDecrypt.shutdown()
        Cu.unload('resource://pg4tb/mimeEncrypt.jsm')
        Cu.unload('resource://pg4tb/mimeDecrypt.jsm')

        DEBUG_LOG('all modules shutdown')

        Services.obs.notifyObservers(null, 'startupcache-invalidate')

        const resProto = Cc['@mozilla.org/network/protocol;1?name=resource'].getService(
            Ci.nsISubstitutingProtocolHandler
        )

        DEBUG_LOG(`unloading namespace "${NAMESPACE}"`)
        resProto.setSubstitution(NAMESPACE, null)
    }
}
