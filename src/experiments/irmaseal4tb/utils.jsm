/* global Components: false, ChromeUtils: false*/

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components

var EXPORTED_SYMBOLS = ['block_on']

var block_on = function (promise) {
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
}
