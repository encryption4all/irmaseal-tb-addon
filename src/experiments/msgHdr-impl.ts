// @ts-expect-error, not sure how to fix/ignore this ts error yet
const { ExtensionCommon } = ChromeUtils.import(
    'resource://gre/modules/ExtensionCommon.jsm'
)

export default class msgHdr extends ExtensionCommon.ExtensionAPI {
    public getAPI(context: any): any {
        return {
            msgHdr: {
                get: (messageId: string, key: string) => {
                    const realMsg = context.extension.messageManager.get(
                        messageId
                    )
                    const value = realMsg.getStringProperty(key)
                    return Promise.resolve(value)
                },
                set: (messageId: string, key: string, value: string) => {
                    const realMsg = context.extension.messageManager.get(
                        messageId
                    )
                    realMsg.setStringProperty(key, value)
                    return Promise.resolve()
                },
            },
        }
    }
}
