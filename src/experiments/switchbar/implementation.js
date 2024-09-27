/* eslint no-fallthrough: ["error", { "commentPattern": "break[\\s\\w]*omitted" }] */
/* global ExtensionCommon, globalThis */

'use strict'

/* NOTE:
 * This experiment is adopted from: https://github.com/jobisoft/switchbar-API.
 * We remove many attributes of the notification and change the looks using CSS.
 * In the long term it is better to refactor this to a switchable status bar API.
 */

var { EventEmitter, EventManager, ExtensionAPI } = ExtensionCommon
var Services = globalThis.Services

class SwitchBar {
    constructor(notificationId, properties, parent) {
        return (async () => {
            this.closedByUser = true
            this.properties = properties
            this.parent = parent
            this.notificationId = notificationId

            const {
                enabled,
                buttonId,
                iconEnabled,
                iconDisabled,
                labels,
                style,
                windowId,
                buttons,
            } = properties

            var iconEnabledURL = null
            var iconDisabledURL = null
            if (iconEnabled) {
                if (iconEnabled.includes('chrome://')) {
                    iconEnabledURL = iconEnabled
                } else if (!iconEnabled.includes(':')) {
                    iconEnabledURL = parent.extension.baseURI.resolve(iconEnabled)
                }
            }
            if (iconDisabled) {
                if (iconDisabled.includes('chrome://')) {
                    iconDisabledURL = iconDisabled
                } else if (!iconDisabled.includes(':')) {
                    iconDisabledURL = parent.extension.baseURI.resolve(iconDisabled)
                }
            }

            var fontURL = parent.extension.baseURI.resolve('fonts/Overpass-Regular.tff')

            const buttonSet = buttons.map(({ id, label, accesskey }) => ({
                id,
                label,
                accesskey,
                callback: () => {
                    // Fire the event and keep the notification open, decided to close it
                    // based on the return values later.
                    this.parent.emitter.emit('buttonclicked', windowId, notificationId, id)
                    //.then((rv) => {
                    //    let keepOpen = rv.some((value) => value?.close === false)
                    //    if (!keepOpen) {
                    //        this.remove(/* closedByUser */ true)
                    //    }
                    //})

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

            let notBox = this.getNotificationBox()

            let element = await notBox.appendNotification(
                `extension-notification-${notificationId}`,
                {
                    label: '',
                    image: enabled ? iconEnabledURL : iconDisabledURL,
                    priority: 0,
                },
                buttonSet,
                notificationBarCallback
            )

            const shadowroot = element.shadowRoot

            console.log(shadowroot)

            const document = element.ownerDocument

            if (style) {
                element.removeAttribute('type')
                element.removeAttribute('message-bar-type')
                element.removeAttribute('dismissable')

                // swap the button and text
                const message = shadowroot.querySelector('.message')
                const buttonContainer = element.buttonContainer.cloneNode()

                console.log(buttonContainer)

                message.parentNode.insertBefore(buttonContainer, message)
                message.innerHTML = enabled ? labels.enabled : labels.disabled

                // change the button to a switch
                const label = document.createElement('label')
                const input = document.createElement('input')
                const span = document.createElement('span')
                input.setAttribute('type', 'checkbox')
                input.checked = enabled
                element.classList.add(enabled ? 'enabled' : 'disabled')
                element.classList.add('initial')
                span.setAttribute('class', 'slider round')
                label.setAttribute('class', 'switch')
                label.replaceChildren(input, span)
                buttonContainer.replaceChildren(label)

                //const attributeButton = shadowroot.querySelector('.notification-button')
                //attributeButton.disabled = !enabled

                input.addEventListener('input', (e) => {
                    const enabled = e.target.checked

                    this.parent.emitter.emit(
                        'buttonclicked',
                        windowId,
                        notificationId,
                        buttonId,
                        e.target.checked
                    )

                    //attributeButton.disabled = !enabled
                    message.innerHTML = enabled ? labels.enabled : labels.disabled
                    element.classList.remove(enabled ? 'disabled' : 'enabled')
                    element.classList.add(enabled ? 'enabled' : 'disabled')
                    element.classList.remove('initial')
                })

                console.log(shadowroot)

                element.style.transition = 'none'

                const s = element.ownerDocument.createElement('style')
                s.innerHTML = `
               @font-face {
                    font-family: 'Overpass';
                    src: url(${fontURL}) format('truetype');
                    font-weight: 600;
                    font-style: normal;
                } 
                :host {
                    border-radius: 0px;
                }
                :host(.enabled) {
                    --message-bar-icon-url: url(${iconEnabledURL});
                }
                :host(.disabled) {
                    --message-bar-icon-url: url(${iconDisabledURL});
                }
                .infobar p {
                    font-family: 'Overpass';
                    font-style: normal;
                    margin: 0;
                }
                .infobar > .icon {
                    width: 24px;
                    height: 24px;
                    margin-right: 0.5rem;
                }
                .container.infobar {
                    border-radius: 0;
                    padding: 3px;
                }
                .message {
                    margin-inline-start: 8px;
                }
                .switch {
                    position: relative;
                    display: inline-block;
                    width: 40px;
                    height: 16px;
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
                    background-color: ${style['slider-background-color-disabled']};
                    transition: .4s;
                }
                .slider:before {
                    position: absolute;
                    content: "";
                    height: 12px;
                    width: 12px;
                    left: 2px;
                    bottom: 2px;
                    background-color: ${style['slider-color-disabled']};
                    transition: .4s;
                }
                input:checked + .slider:before {
                    background-color: ${style['slider-color-enabled']};
                }
                input:checked + .slider {
                    background-color: ${style['slider-background-color-enabled']};
                }
                input:focus + .slider {
                    box-shadow: 0 0 1px #2196F3;
                }
                input:checked + .slider:before {
                    transform: translateX(24px);
                }
                .slider.round {
                    border-radius: 8px;
                }
                .slider.round:before {
                    border-radius: 50%;
                }
                :host(.enabled) .container.infobar {
                    --message-bar-background-color: ${style['background-color-enabled']};
                    --message-bar-text-color: ${style['color-enabled']};
                }
                :host(.disabled) .container.infobar {
                    --message-bar-background-color: ${style['background-color-disabled']};
                    --message-bar-text-color: ${style['color-disabled']};
                }
                .notification-button.small-button {
                    background-color: #006EF4;
                    color: white;
                    border-radius: 15px;
                    border: unset;               
                    padding: 0 1.5rem;
                }
                .notification-button.small-button:hover {
                    background-color: white;
                }
                :host(.disabled) .notification-button.small-button {
                    display: none;
                }
                /*
                :host(:not(.initial)) .container.infobar {
                    -moz-transition: background-color 0.33s linear;
                }
                */
            `

                // Add the styles to the shadow root.
                element.shadowRoot.appendChild(s)
                console.log(element.shadowRoot)
            }
            return this
        })()
    }
    //  document.body.insertBefore(notification, document.body.firstChild);

    getNotificationBox() {
        const w = this.parent.extension.windowManager.get(
            this.properties.windowId,
            this.parent.context
        ).window
        console.log(this.properties)
        console.log(w)
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
                        await new SwitchBar(notificationId, properties, this)
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
