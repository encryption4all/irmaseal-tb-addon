/*eslint no-fallthrough: ["error", { "commentPattern": "break[\\s\\w]*omitted" }]*/
/* global ExtensionCommon,  ChromeUtils, ExtensionUtils */

'use strict'

var { EventEmitter, EventManager, ExtensionAPI } = ExtensionCommon
var { ExtensionError } = ExtensionUtils
var { Services } = ChromeUtils.import('resource://gre/modules/Services.jsm')

class ExtensionNotification {
    constructor(notificationId, properties, parent) {
        this.closedByUser = true
        this.properties = properties
        this.parent = parent
        this.notificationId = notificationId
        this.tbVersion = this.getThunderbirdVersion().major

        const { buttons, icon, label, priority, style, windowId, badges, placement } = properties

        const iconURL = icon && !icon.includes(':') ? parent.extension.baseURI.resolve(icon) : null
        const fontURL = parent.extension.baseURI.resolve('fonts/Overpass-Regular.tff')

        const buttonSet = buttons.map(({ id, label, accesskey }) => ({
            id,
            label,
            accesskey,
            callback: () => {
                // Fire the event and keep the notification open, decided to close it
                // based on the return values later.
                this.parent.emitter
                    .emit('buttonclicked', windowId, notificationId, id)
                    .then((rv) => {
                        let keepOpen = rv.some((value) => value?.close === false)
                        if (!keepOpen) {
                            this.remove(/* closedByUser */ true)
                        }
                    })

                // Keep the notification box open until we hear from the event
                // handlers.
                return true
            },
        }))

        const notificationBarCallback = (event) => {
            // Every dismissed notification will also generate a removed notification
            if (event === 'dismissed') {
                this.parent.emitter.emit('dismissed', windowId, notificationId)
            }

            if (event === 'removed') {
                this.parent.emitter.emit('closed', windowId, notificationId, this.closedByUser)

                this.cleanup()
            }
        }

        let element
        if (this.tbVersion < 94) {
            element = this.getNotificationBox().appendNotification(
                label,
                `extension-notification-${notificationId}`,
                iconURL,
                priority,
                buttonSet,
                notificationBarCallback
            )
        } else {
            element = this.getNotificationBox().appendNotification(
                `extension-notification-${notificationId}`,
                {
                    label,
                    image: iconURL,
                    priority,
                    eventCallback: notificationBarCallback,
                },
                buttonSet
            )
        }

        if (!element) return

        if (badges.length > 0) {
            element.removeAttribute('dismissable')
            if (placement !== 'message') element.removeAttribute('message-bar-type')
        }

        const shadowroot = element.shadowRoot
        const document = element.ownerDocument
        const message = shadowroot.querySelector('label.notification-message')

        badges.forEach((b) => {
            const newDiv = document.createElement('div')
            newDiv.classList.add('badge')

            const iconURL = badges && parent.extension.baseURI.resolve(`icons/${b.type}.svg`)
            const img = document.createElement('img')
            img.src = iconURL
            img.height = 20
            img.width = 20

            newDiv.appendChild(img)
            const label = document.createElement('label')
            label.innerText = b.value
            newDiv.appendChild(label)

            message.parentNode.insertBefore(newDiv, message.nextSibling)
        })

        if (style) {
            const s = element.ownerDocument.createElement('style')
            s.innerHTML = `
               @font-face {
                    font-family: 'Overpass';
                    src: url(${fontURL}) format('truetype');
                    font-weight: 600;
                    font-style: normal;
                }
                .notification-button.small-button {
                    background-color: #006EF4;
                    color: white;
                    border-radius: 15px;
                    border: unset;               
                    padding: 0 1.5rem;
                }
                .notification-message {
                    flex-grow: unset;
                    flex-wrap: wrap;
                }
                .notification-button.small-button:hover {
                    background-color: white;
                }
                .infobar > .icon {
                    width: 24px;
                    height: 24px; 
                    ${badges.length > 0 && placement === 'message' ? 'display: none;' : ''}
                }
                .container {
                    border-radius: ${
                        badges.length > 0 && placement !== 'message' ? '0' : 'inherit'
                    };
                }
                .infobar p {
                    font-family: 'Overpass';
                    font-style: normal;
                } 
                :host .container.infobar {
                    --message-bar-icon-url: url(${iconURL});
                    --message-bar-text-color: ${style['color']};
                    --message-bar-background-color: ${style['background-color']};
                }
                .badge {
                    display: flex;
                    justify-items: center;
                    align-items: center;
                    justify
                    border: 0px;
                    border-radius: 15px;
                    background-color: #017aff;
                    padding: 0 0.5em;
                    margin: 0 0.25em;
                    gap: 0.25em;
                }
        `
            element.shadowRoot.appendChild(s)
        }
    }

    getThunderbirdVersion() {
        let [major, minor, revision = 0] = Services.appinfo.version
            .split('.')
            .map((chunk) => parseInt(chunk, 10))
        return {
            major,
            minor,
            revision,
        }
    }

    getNotificationBoxPreSupernova() {
        const w = this.parent.extension.windowManager.get(
            this.properties.windowId,
            this.parent.context
        ).window
        switch (this.properties.placement) {
            case 'top':
                if (!w.gExtensionNotificationTopBox) {
                    // try to add it before the toolbox, if that fails add it firstmost
                    const toolbox = w.document.querySelector('toolbox')
                    if (toolbox) {
                        w.gExtensionNotificationTopBox = new w.MozElements.NotificationBox(
                            (element) => {
                                element.id = 'extension-notification-top-box'
                                element.setAttribute('notificationside', 'top')
                                toolbox.parentElement.insertBefore(
                                    element,
                                    toolbox.nextElementSibling
                                )
                            }
                        )
                    } else {
                        w.gExtensionNotificationTopBox = new w.MozElements.NotificationBox(
                            (element) => {
                                element.id = 'extension-notification-top-box'
                                element.setAttribute('notificationside', 'top')
                                w.document.documentElement.insertBefore(
                                    element,
                                    w.document.documentElement.firstChild
                                )
                            }
                        )
                    }
                }
                return w.gExtensionNotificationTopBox

            case 'message':
                // below the receipient list in the message preview window
                if (w.gMessageNotificationBar) {
                    return w.gMessageNotificationBar.msgNotificationBar
                }
            // break omitted

            default:
            case 'bottom':
                // default bottom notification in the mail3:pane
                if (w.specialTabs) {
                    return w.specialTabs.msgNotificationBar
                }
                // default bottom notification in message composer window and
                // most calendar dialogs (currently windows.onCreated event does not see these)
                if (w.gNotification) {
                    return w.gNotification.notificationbox
                }
                // if there is no default bottom box, use our own
                if (!w.gExtensionNotificationBottomBox) {
                    let statusbar = w.document.querySelector('[class~="statusbar"]')
                    w.gExtensionNotificationBottomBox = new w.MozElements.NotificationBox(
                        (element) => {
                            element.id = 'extension-notification-bottom-box'
                            element.setAttribute('notificationside', 'bottom')
                            if (statusbar) {
                                statusbar.parentNode.insertBefore(element, statusbar)
                            } else {
                                w.document.documentElement.append(element)
                            }
                        }
                    )
                }
                return w.gExtensionNotificationBottomBox
        }
    }

    getNotificationBoxPostSupernova() {
        const w = this.parent.extension.windowManager.get(
            this.properties.windowId,
            this.parent.context
        ).window
        switch (this.properties.placement) {
            case 'top':
                if (!w.gExtensionNotificationTopBox) {
                    const messengerBody = w.document.getElementById('messengerBody')
                    const toolbox = w.document.querySelector('toolbox')
                    if (messengerBody) {
                        w.gExtensionNotificationTopBox = new w.MozElements.NotificationBox(
                            (element) => {
                                element.id = 'extension-notification-top-box'
                                element.setAttribute('notificationside', 'top')
                                messengerBody.insertBefore(element, messengerBody.firstChild)
                            }
                        )
                    } else if (toolbox) {
                        w.gExtensionNotificationTopBox = new w.MozElements.NotificationBox(
                            (element) => {
                                element.id = 'extension-notification-top-box'
                                element.setAttribute('notificationside', 'top')
                                element.style.marginInlineStart = 'var(--spaces-total-width)'
                                toolbox.insertAdjacentElement('afterend', element)
                            }
                        )
                    } else {
                        w.gExtensionNotificationTopBox = new w.MozElements.NotificationBox(
                            (element) => {
                                element.id = 'extension-notification-top-box'
                                element.setAttribute('notificationside', 'top')
                                w.document.documentElement.insertBefore(
                                    element,
                                    w.document.documentElement.firstChild
                                )
                            }
                        )
                    }
                }
                return w.gExtensionNotificationTopBox

            case 'message': {
                if (!this.properties.tabId) {
                    throw new Error('appendNotification - missing tab id')
                }
                const aTab = this.parent.context.extension.tabManager.get(this.properties.tabId)
                let messageBrowser = null
                switch (aTab.nativeTab.mode?.name) {
                    case 'mailMessageTab':
                        // message tab;
                        messageBrowser = aTab.nativeTab.chromeBrowser.contentWindow
                        break
                    case 'mail3PaneTab':
                        // message in mail3pane tab
                        messageBrowser =
                            aTab.nativeTab.chromeBrowser.contentWindow.messageBrowser.contentWindow
                        break
                    default:
                        // message window;
                        messageBrowser = aTab.nativeTab.messageBrowser.contentWindow
                        break
                }
                if (messageBrowser) {
                    return messageBrowser.gMessageNotificationBar.msgNotificationBar
                }
                console.error(
                    'appendNotification - could not get window for tabId ' + this.properties.tabId
                )
                return null
            }
            default:
            case 'bottom':
                return this.getNotificationBoxPreSupernova()
        }
    }

    getNotificationBox() {
        if (this.tbVersion >= 112) {
            return this.getNotificationBoxPostSupernova()
        }
        return this.getNotificationBoxPreSupernova()
    }
    //    getNotificationBox() {
    //        const w = this.parent.extension.windowManager.get(
    //            this.properties.windowId,
    //            this.parent.context
    //        ).window
    //        switch (this.properties.placement) {
    //            case 'message':
    //                // below the receipient list in the message preview window
    //                if (w.gMessageNotificationBar) {
    //                    return w.gMessageNotificationBar.msgNotificationBar
    //                }
    //            // break omitted
    //
    //            default:
    //            case 'bottom':
    //                // default bottom notification in the mail3:pane
    //                if (w.specialTabs) {
    //                    return w.specialTabs.msgNotificationBar
    //                }
    //                // default bottom notification in message composer window and
    //                // most calendar dialogs (currently windows.onCreated event does not see these)
    //                if (w.gNotification) {
    //                    return w.gNotification.notificationbox
    //                }
    //                // if there is no default bottom box, use our own
    //                if (!w.gExtensionNotificationBottomBox) {
    //                    let statusbar = w.document.querySelector('[class~="statusbar"]')
    //                    w.gExtensionNotificationBottomBox = new w.MozElements.NotificationBox(
    //                        (element) => {
    //                            element.id = 'extension-notification-bottom-box'
    //                            element.setAttribute('notificationside', 'bottom')
    //                            if (statusbar) {
    //                                statusbar.parentNode.insertBefore(element, statusbar)
    //                            } else {
    //                                w.document.documentElement.append(element)
    //                            }
    //                        }
    //                    )
    //                }
    //                return w.gExtensionNotificationBottomBox
    //
    //            case 'top':
    //                if (!w.gExtensionNotificationTopBox) {
    //                    // try to add it before the toolbox, if that fails add it firstmost
    //                    const toolbox = w.document.querySelector('toolbox')
    //                    if (toolbox) {
    //                        w.gExtensionNotificationTopBox = new w.MozElements.NotificationBox(
    //                            (element) => {
    //                                element.id = 'extension-notification-top-box'
    //                                element.setAttribute('notificationside', 'top')
    //                                toolbox.parentElement.insertBefore(
    //                                    element,
    //                                    toolbox.nextElementSibling
    //                                )
    //                            }
    //                        )
    //                    } else {
    //                        w.gExtensionNotificationTopBox = new w.MozElements.NotificationBox(
    //                            (element) => {
    //                                element.id = 'extension-notification-top-box'
    //                                element.setAttribute('notificationside', 'top')
    //                                w.document.documentElement.insertBefore(
    //                                    element,
    //                                    w.document.documentElement.firstChild
    //                                )
    //                            }
    //                        )
    //                    }
    //                }
    //                return w.gExtensionNotificationTopBox
    //        }
    //    }

    remove(closedByUser) {
        // The remove() method is called by button clicks and by notificationBox.clear()
        // but not by dismissal. In that case, the default value defined in the constructor
        // defines the value of closedByUser which is used by the event emitter.
        this.closedByUser = closedByUser
        const notificationBox = this.getNotificationBox()
        const notification = notificationBox.getNotificationWithValue(
            `extension-notification-${this.notificationId}`
        )
        notificationBox.removeNotification(notification)
    }

    cleanup() {
        this.parent.notificationsMap.delete(this.notificationId)
    }
}

var notificationbar = class extends ExtensionAPI {
    constructor(extension) {
        super(extension)
        this.notificationsMap = new Map()
        this.emitter = new EventEmitter()
        this.nextId = 1
        Services.obs.addObserver(this, 'domwindowclosed')
    }

    onShutdown() {
        Services.obs.removeObserver(this, 'domwindowclosed')
        for (let notification of this.notificationsMap.values()) {
            notification.remove(/* closedByUser */ false)
        }
    }

    // Observer for the domwindowclosed notification, to remove
    // obsolete notifications from the notificationsMap.
    observe(aSubject, aTopic, aData) {
        let win = this.context.extension.windowManager.convert(aSubject)
        this.notificationsMap.forEach((value, key) => {
            if (value.properties.windowId == win.id) {
                this.notificationsMap.delete(key)
            }
        })
    }

    getAPI(context) {
        this.context = context
        const self = this

        return {
            notificationbar: {
                async create(properties) {
                    const notificationId = self.nextId++
                    self.notificationsMap.set(
                        notificationId,
                        new ExtensionNotification(notificationId, properties, self)
                    )
                    return notificationId
                },

                async clear(notificationId) {
                    if (self.notificationsMap.has(notificationId)) {
                        self.notificationsMap.get(notificationId).remove(/* closedByUser */ false)
                        return true
                    }
                    return false
                },

                async getAll() {
                    const result = {}
                    self.notificationsMap.forEach((value, key) => {
                        result[key] = value.properties
                    })
                    return result
                },

                onDismissed: new EventManager({
                    context,
                    name: 'notificationbar.onDismissed',
                    register: (fire) => {
                        const listener = (event, windowId, notificationId) =>
                            fire.async(windowId, notificationId)

                        self.emitter.on('dismissed', listener)
                        return () => {
                            self.emitter.off('dismissed', listener)
                        }
                    },
                }).api(),

                onClosed: new EventManager({
                    context,
                    name: 'notificationbar.onClosed',
                    register: (fire) => {
                        const listener = (event, windowId, notificationId, closedByUser) =>
                            fire.async(windowId, notificationId, closedByUser)

                        self.emitter.on('closed', listener)
                        return () => {
                            self.emitter.off('closed', listener)
                        }
                    },
                }).api(),

                onButtonClicked: new EventManager({
                    context,
                    name: 'notificationbar.onButtonClicked',
                    register: (fire) => {
                        const listener = (event, windowId, notificationId, buttonId) =>
                            fire.async(windowId, notificationId, buttonId)

                        self.emitter.on('buttonclicked', listener)
                        return () => {
                            self.emitter.off('buttonclicked', listener)
                        }
                    },
                }).api(),
            },
        }
    }
}
