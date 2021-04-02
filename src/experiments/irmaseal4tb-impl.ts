/**
 * IRMAseal thunderbird experiment
 */

/* global Components: false */

declare const Components: any
const { classes: Cc, interfaces: Ci, utils: Cu } = Components

const { ExtensionCommon } = Cu.import('resource://gre/modules/ExtensionCommon.jsm')
const { Services } = Cu.import('resource://gre/modules/Services.jsm')
const { ExtensionParent } = Cu.import('resource://gre/modules/ExtensionParent.jsm')
const extension = ExtensionParent.GlobalManager.getExtension('irmaseal4tb@e4a.org')

// To load and unload modules
const loadJsm = (path: string) => Cu.import(extension.rootURI.resolve(path))
const unloadJsm = (path: string) => Cu.unload(extension.rootURI.resolve(path))

const DEBUG_LOG = (str: string) => Services.console.logStringMessage(`[EXPERIMENT]: ${str}`)
const ERROR_LOG = (ex: any) => DEBUG_LOG(`exception: ${ex.toString()}, stack: ${ex.stack}`)

export default class irmaseal4tb extends ExtensionCommon.ExtensionAPI {
    public getAPI(context: any): any {
        return {
            irmaseal4tb: {
                /**
                 * setSecurityInfo
                 */
                setSecurityInfo: function (windowId: number, value: string) {
                    DEBUG_LOG('irmaseal4tb.js: setSecurityInfo()\n')
                    let compSec = Cc['@e4a/irmaseal/compose-encrypted;1'].createInstance(
                        Components.interfaces.nsIMsgComposeSecure
                    )

                    compSec = compSec.wrappedJSObject
                    compSec.init(value)

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
                    DEBUG_LOG('irmaseal4tb.js: setSecurityInfo() complete\n')
                    return Promise.resolve()
                },

                /* Event that is triggered once the experiment intercepts MIME data */
                //onMimeData: new ExtensionCommon.EventManager({
                //    context,
                //    name: 'irmaseal4tb.onMimeData',
                //    register(fire: any) {
                //        function callback(event: any, data: any) {
                //            return fire.async(data)
                //        }

                //        const { IRMAsealMimeEncrypt } = loadJsm('mimeEncrypt.jsm')
                //        IRMAsealMimeEncrypt.add(callback)
                //        return function () {
                //            IRMAsealMimeEncrypt.remove(callback)
                //        }
                //    },
                //}).api(),
            },
        }
    }

    public onStartup(): any {
        try {
            DEBUG_LOG('starting experiment')

            const { IRMAsealMimeEncrypt } = loadJsm('mimeEncrypt.jsm')
            //            const { SampleOverlays } = loadJsm('sampleOverlays.jsm')

            IRMAsealMimeEncrypt.startup()

            const { IRMAsealMimeDecrypt } = loadJsm('mimeDecrypt.jsm')
            IRMAsealMimeDecrypt.startup()

            // DEBUG_LOG('starting overlay')
            //           SampleOverlays.startup()

            DEBUG_LOG('all modules loaded')
        } catch (ex) {
            ERROR_LOG(ex)
        }
    }

    public onShutdown(isAppShutdown: boolean): any {
        if (isAppShutdown) {
            DEBUG_LOG('shutting down experiment')
            return
        }

        try {
            DEBUG_LOG('unloading modules')

            const { IRMAsealMimeEncrypt } = loadJsm('mimeEncrypt.jsm')
            //          const { SampleOverlays } = loadJsm('sampleOverlays.jsm')

            IRMAsealMimeEncrypt.shutdown()
            //         SampleOverlays.shutdown()

            unloadJsm('mimeEncrypt.jsm')
            const { IRMAsealMimeDecrypt } = loadJsm('mimeDecrypt.jsm')

            IRMAsealMimeDecrypt.shutdown()
            unloadJsm('mimeDecrypt.jsm')
            //        unloadJsm('sampleOverlays.jsm')

            DEBUG_LOG('invalidating startup cache')
            Services.obs.notifyObservers(null, 'startupcache-invalidate', null)

            DEBUG_LOG('succesfully shutdown experiment')
        } catch (ex) {
            ERROR_LOG(ex)
        }
    }
}
