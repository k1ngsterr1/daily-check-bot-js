declare const _default: () => {
    bot: {
        token: string | undefined;
        webhookUrl: string | undefined;
    };
    database: {
        url: string | undefined;
    };
    openai: {
        apiKey: string | undefined;
    };
    app: {
        nodeEnv: string;
        port: number;
        logLevel: string;
    };
    payment: {
        yookassa: {
            shopId: string | undefined;
            secretKey: string | undefined;
        };
    };
    redis: {
        url: string | undefined;
    };
};
export default _default;
