/* global Components: false */

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components

const { MailServices } = Cu.import('resource:///modules/MailServices.jsm')

var EXPORTED_SYMBOLS = ['block_on', 'getFolder', 'folderPathToURI']

var inspector

var block_on = function (promise) {
    if (!inspector) {
        inspector = Cc['@mozilla.org/jsinspector;1'].createInstance(Ci.nsIJSInspector)
    }

    let result = null
    promise
        .then((res) => {
            result = res
            inspector.exitNestedEventLoop()
        })
        .catch((err) => {
            result = err
            inspector.exitNestedEventLoop()
        })

    inspector.enterNestedEventLoop(0)
    if (result instanceof Error) throw result

    return result
}

/**
 * Convert a human-friendly path to a folder URI. This function does not assume that the
 * folder referenced exists.
 * @return {String}
 */
function folderPathToURI(accountId, path) {
    let server = MailServices.accounts.getAccount(accountId).incomingServer
    let rootURI = server.rootFolder.URI
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

function getFolder({ accountId, path, id }) {
    if (id && !path && !accountId) {
        accountId = id
        path = '/'
    }

    let uri = folderPathToURI(accountId, path)
    let folder = MailServices.folderLookup.getFolderForURL(uri)
    if (!folder) {
        throw new Error(`Folder not found: ${path}`)
    }
    return { folder, accountId }
}
