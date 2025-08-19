export default () => ({
  bot: {
    token: process.env.BOT_TOKEN,
    webhookUrl: process.env.WEBHOOK_URL,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  app: {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
  },
  payment: {
    yookassa: {
      shopId: process.env.YOOKASSA_SHOP_ID,
      secretKey: process.env.YOOKASSA_SECRET_KEY,
    },
  },
  redis: {
    url: process.env.REDIS_URL,
  },
});
