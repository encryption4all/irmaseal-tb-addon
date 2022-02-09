/* eslint no-fallthrough: ["error", { "commentPattern": "break[\\s\\w]*omitted" }] */
/* global ExtensionCommon,  ChromeUtils */

'use strict'

/* NOTE:
 * This experiment is adopted from: https://github.com/jobisoft/switchbar-API.
 * We remove many attributes of the notification and change the looks using CSS.
 * In the long term it is better to refactor this to a switchable status bar API.
 */

var { EventEmitter, EventManager, ExtensionAPI } = ExtensionCommon
var { Services } = ChromeUtils.import('resource://gre/modules/Services.jsm')

class SwitchBar {
    constructor(notificationId, properties, parent) {
        this.closedByUser = true
        this.properties = properties
        this.parent = parent
        this.notificationId = notificationId

        const { buttons, icon, label, style, windowId } = properties

        var iconURL = null
        if (icon) {
            if (icon.includes('chrome://')) {
                iconURL = icon
            } else if (!icon.includes(':')) {
                iconURL = parent.extension.baseURI.resolve(icon)
            }
        }

        const buttonSet = new Map();
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
        if (this.getThunderbirdVersion().major < 94) {
            element = this.getNotificationBox().appendNotification(
                label,
                `extension-notification-${notificationId}`,
                iconURL,
                0,
                buttonSet,
                notificationBarCallback
            )
        } else {
            element = this.getNotificationBox().appendNotification(
                `extension-notification-${notificationId}`,
                {
                    label,
                    image: iconURL,
                    priority: 0
                },
                buttonSet,
                notificationBarCallback
            )
        }

        const shadowroot = element.shadowRoot
        const document = element.ownerDocument

        if (style) {
            //            const allowedCssPropNames = ['background', 'color', 'margin', 'padding', 'font']
            //            const sanitizedStyles = Object.keys(style).filter((cssPropertyName) => {
            //                const parts = cssPropertyName.split('-')
            //                return (
            //                    // check if first part is in whitelist
            //                    parts.length > 0 &&
            //                    allowedCssPropNames.includes(parts[0]) &&
            //                    // validate second part (if any) being a simple word
            //                    (parts.length == 1 || (parts.length == 2 && /^[a-zA-Z0-9]+$/.test(parts[1])))
            //                )
            //            })

            element.removeAttribute('type')
            element.removeAttribute('message-bar-type')
            element.removeAttribute('dismissable')

            // swap the button and text
            const message = shadowroot.querySelector('label.notification-message')
            const buttonContainer = element.buttonContainer
            message.parentNode.insertBefore(buttonContainer, message)

            // change the button to a switch
            const label = document.createElement('label')
            const input = document.createElement('input')
            const span = document.createElement('span')
            input.setAttribute('type', 'checkbox')
            span.setAttribute('class', 'slider round')
            label.setAttribute('class', 'switch')
            label.replaceChildren(input, span)
            buttonContainer.replaceChildren(label)
            
            const s = element.ownerDocument.createElement('style')

            input.addEventListener('input', (e) => {
                console.log('checkbox clicked: ', e)
                console.log('checkbox is enabled', e.target.checked)

                this.parent.emitter.emit('buttonclicked', windowId, notificationId, 'btn-switch', e.target.checked)

                s['background-color'] = e.target.checked
                    ? style['background-color-enabled']
                    : style['background-color-disabled']

                s['color'] = e.target.checked
                    ? style['color-enabled']
                    : style['color-disabled']
            })

            element.style['background-color'] = style['background-color-enabled']
            element.style['color'] = style['color-enabled']
            element.style.transition = 'none'

            s.innerHTML = `
                :host {
                    --message-bar-background-color: ${style['background-color-enabled']};
                    --message-bar-icon-url: url(${iconURL});
                    --message-bar-text-color: ${style['color-enabled']};
                    border-radius: 0px;
                }
                .container.infobar {
                    padding: 3px;
                }
                label.notification-message {
                    margin-inline-start: 8px;
                }
                .switch {
                    position: relative;
                    display: inline-block;
                    width: 34px;
                    height: 20px;
                }
                .switch input {
                    opacity: 0;
                    width: 0;
                    height: 0;
                }
                .slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: #ccc;
                    -webkit-transition: .4s;
                    transition: .4s;
                }
                .slider:before {
                    position: absolute;
                    content: "";
                    height: 16px;
                    width: 16px;
                    left: 2px;
                    bottom: 2px;
                    background-color: white;
                    -webkit-transition: .4s;
                    transition: .4s;
                }
                input:checked + .slider {
                    background-color: #69A597};
                }
                input:focus + .slider {
                    box-shadow: 0 0 1px #2196F3;
                }
                input:checked + .slider:before {
                    -webkit-transform: translateX(14px);
                    -ms-transform: translateX(14px);
                    transform: translateX(14px);
                }
                .slider.round {
                    border-radius: 34px;
                }
                .slider.round:before {
                    border-radius: 50%;
                }
            `

            // Add the styles to the shadow root.
            element.shadowRoot.appendChild(s)
        }
    }

    getThunderbirdVersion() {
        const [major, minor, revision = 0] = Services.appinfo.version
            .split('.')
            .map((chunk) => parseInt(chunk, 10))
        return {
            major,
            minor,
            revision,
        }
    }

    getNotificationBox() {
        const w = this.parent.extension.windowManager.get(
            this.properties.windowId,
            this.parent.context
        ).window
        switch (this.properties.placement) {
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
                    const statusbar = w.document.querySelector('[class~="statusbar"]')
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
        }
    }

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

var switchbar = class extends ExtensionAPI {
    constructor(extension) {
        super(extension)
        this.notificationsMap = new Map()
        this.emitter = new EventEmitter()
        this.nextId = 1
        Services.obs.addObserver(this, 'domwindowclosed')
    }

    onShutdown() {
        Services.obs.removeObserver(this, 'domwindowclosed')
        for (const notification of this.notificationsMap.values()) {
            notification.remove(/* closedByUser */ false)
        }
    }

    // Observer for the domwindowclosed notification, to remove
    // obsolete notifications from the notificationsMap.
    observe(aSubject, aTopic, aData) {
        const win = this.context.extension.windowManager.convert(aSubject)
        this.notificationsMap.forEach((value, key) => {
            if (value.properties.windowId == win.id) {
                this.notificationsMap.delete(key)
            }
        })
    }

    getAPI(context) {
        this.context = context

        return {
            switchbar: {
                create: async (properties) => {
                    const notificationId = this.nextId++
                    this.notificationsMap.set(
                        notificationId,
                        new SwitchBar(notificationId, properties, this)
                    )
                    return notificationId
                },

                clear: async (notificationId) => {
                    if (this.notificationsMap.has(notificationId)) {
                        this.notificationsMap.get(notificationId).remove(/* closedByUser */ false)
                        return true
                    }
                    return false
                },

                getAll: async () => {
                    const result = {}
                    this.notificationsMap.forEach((value, key) => {
                        result[key] = value.properties
                    })
                    return result
                },

                onDismissed: new EventManager({
                    context,
                    name: 'switchbar.onDismissed',
                    register: (fire) => {
                        const listener = (event, windowId, notificationId) =>
                            fire.async(windowId, notificationId)

                        this.emitter.on('dismissed', listener)
                        return () => {
                            this.emitter.off('dismissed', listener)
                        }
                    },
                }).api(),

                onClosed: new EventManager({
                    context,
                    name: 'switchbar.onClosed',
                    register: (fire) => {
                        const listener = (event, windowId, notificationId, closedByUser) =>
                            fire.async(windowId, notificationId, closedByUser)

                        this.emitter.on('closed', listener)
                        return () => {
                            this.emitter.off('closed', listener)
                        }
                    },
                }).api(),

                onButtonClicked: new EventManager({
                    context,
                    name: 'switchbar.onButtonClicked',
                    register: (fire) => {
                        const listener = (event, windowId, notificationId, buttonId, checked) =>
                            fire.async(windowId, notificationId, buttonId, checked)

                        this.emitter.on('buttonclicked', listener)
                        return () => {
                            this.emitter.off('buttonclicked', listener)
                        }
                    },
                }).api(),
            },
        }
    }
}
