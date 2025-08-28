"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var PaymentService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../database/prisma.service");
const yoo_checkout_1 = require("@a2seven/yoo-checkout");
let PaymentService = PaymentService_1 = class PaymentService {
    configService;
    prisma;
    logger = new common_1.Logger(PaymentService_1.name);
    yooCheckout;
    constructor(configService, prisma) {
        this.configService = configService;
        this.prisma = prisma;
        const shopId = this.configService.get('payment.yookassa.shopId');
        const secretKey = this.configService.get('payment.yookassa.secretKey');
        if (!shopId || !secretKey) {
            this.logger.warn('YooKassa credentials not found. Payment service will be disabled.');
            return;
        }
        this.yooCheckout = new yoo_checkout_1.YooCheckout({
            shopId,
            secretKey,
        });
        this.logger.log('YooKassa payment service initialized');
    }
    async createPayment(data) {
        if (!this.yooCheckout) {
            throw new Error('Payment service is not initialized');
        }
        try {
            const payment = await this.yooCheckout.createPayment({
                amount: {
                    value: data.amount.toFixed(2),
                    currency: 'RUB',
                },
                confirmation: {
                    type: 'redirect',
                    return_url: data.returnUrl || 'https://t.me/daily_check_bot',
                },
                description: data.description,
                receipt: {
                    customer: {
                        email: 'customer@example.com',
                    },
                    items: [
                        {
                            description: data.description,
                            quantity: '1.00',
                            amount: {
                                value: data.amount.toFixed(2),
                                currency: 'RUB',
                            },
                            vat_code: 1,
                            payment_mode: 'full_payment',
                            payment_subject: 'service',
                        },
                    ],
                },
                metadata: {
                    userId: data.userId,
                    subscriptionType: data.subscriptionType,
                },
            });
            const now = new Date();
            const billingEnd = new Date();
            billingEnd.setMonth(billingEnd.getMonth() + 1);
            await this.prisma.payment.create({
                data: {
                    id: payment.id,
                    userId: data.userId,
                    amount: data.amount,
                    currency: 'RUB',
                    status: 'PENDING',
                    subscriptionType: data.subscriptionType,
                    transactionId: payment.id,
                    billingPeriodStart: now,
                    billingPeriodEnd: billingEnd,
                    createdAt: now,
                },
            });
            this.logger.log(`Payment created: ${payment.id} for user ${data.userId}`);
            return {
                paymentId: payment.id,
                confirmationUrl: payment.confirmation?.confirmation_url || '',
                status: payment.status,
            };
        }
        catch (error) {
            this.logger.error('Error creating payment:', error);
            throw new Error('Failed to create payment');
        }
    }
    async handlePaymentWebhook(paymentData) {
        try {
            const paymentId = paymentData.object.id;
            const status = paymentData.object.status;
            const payment = await this.prisma.payment.findUnique({
                where: { transactionId: paymentId },
                include: { user: true },
            });
            if (!payment) {
                this.logger.warn(`Payment not found in database: ${paymentId}`);
                return;
            }
            let newStatus;
            switch (status) {
                case 'succeeded':
                    newStatus = 'COMPLETED';
                    break;
                case 'canceled':
                    newStatus = 'FAILED';
                    break;
                default:
                    newStatus = 'PENDING';
            }
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: {
                    status: newStatus,
                    updatedAt: new Date(),
                },
            });
            if (newStatus === 'COMPLETED') {
                await this.activateSubscription(payment.userId, payment.subscriptionType, payment.id, payment.amount);
            }
            this.logger.log(`Payment ${paymentId} status updated to ${newStatus}`);
        }
        catch (error) {
            this.logger.error('Error handling payment webhook:', error);
            throw error;
        }
    }
    async checkPaymentStatus(paymentId) {
        if (!this.yooCheckout) {
            throw new Error('Payment service is not initialized');
        }
        try {
            const payment = await this.yooCheckout.getPayment(paymentId);
            return payment.status;
        }
        catch (error) {
            this.logger.error(`Error checking payment status: ${paymentId}`, error);
            throw error;
        }
    }
    async activateSubscription(userId, subscriptionType, paymentId, amount) {
        try {
            const now = new Date();
            const subscriptionEnds = new Date();
            if (amount === 999) {
                subscriptionEnds.setFullYear(subscriptionEnds.getFullYear() + 1);
            }
            else {
                subscriptionEnds.setMonth(subscriptionEnds.getMonth() + 1);
            }
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    subscriptionType,
                    subscriptionStarted: now,
                    subscriptionEnds,
                    isTrialActive: false,
                },
            });
            if (paymentId && amount) {
                await this.processReferralPayout(userId, paymentId, amount);
            }
            this.logger.log(`Subscription ${subscriptionType} activated for user ${userId}`);
        }
        catch (error) {
            this.logger.error('Error activating subscription:', error);
            throw error;
        }
    }
    async processReferralPayout(userId, paymentId, amount) {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                include: {
                    referredByUser: true,
                },
            });
            if (!user?.referredBy || !user.referredByUser) {
                return;
            }
            const payoutAmount = Math.round(amount * 0.4);
            await this.prisma.referralPayout.create({
                data: {
                    referrerId: user.referredBy,
                    referredUserId: userId,
                    paymentId: paymentId,
                    amount: payoutAmount,
                    originalAmount: amount,
                    percentage: 40,
                    status: 'pending',
                },
            });
            await this.prisma.user.update({
                where: { id: user.referredBy },
                data: {
                    referralBalance: {
                        increment: payoutAmount,
                    },
                },
            });
            this.logger.log(`Referral payout created: ${payoutAmount}₽ for referrer ${user.referredBy}`);
        }
        catch (error) {
            this.logger.error('Error processing referral payout:', error);
        }
    }
    getSubscriptionPlans() {
        return {
            PREMIUM_MONTHLY: {
                amount: 199,
                currency: 'RUB',
                period: '1 месяц',
                description: 'Premium подписка на 1 месяц',
                subscriptionType: 'PREMIUM',
                features: [
                    'Безлимитные задачи, напоминания и привычки',
                    'Безлимитные запросы к ИИ',
                    'Расширенная аналитика и отчеты',
                    'Приоритетная поддержка',
                    'Эксклюзивные темы и значки',
                    'Экспорт данных',
                    'Персональный менеджер продуктивности',
                    'Интеграция с внешними сервисами',
                    'Без рекламы',
                ],
            },
            PREMIUM_YEARLY: {
                amount: 999,
                currency: 'RUB',
                period: '1 год',
                description: 'Premium подписка на 1 год (скидка 58%)',
                subscriptionType: 'PREMIUM',
                features: [
                    'Все Premium функции',
                    'Экономия 1389₽ в год',
                    'Безлимитные задачи, напоминания и привычки',
                    'Безлимитные запросы к ИИ',
                    'Расширенная аналитика и отчеты',
                    'Приоритетная поддержка',
                    'Эксклюзивные темы и значки',
                    'Экспорт данных',
                    'Персональный менеджер продуктивности',
                ],
            },
        };
    }
};
exports.PaymentService = PaymentService;
exports.PaymentService = PaymentService = PaymentService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        prisma_service_1.PrismaService])
], PaymentService);
//# sourceMappingURL=payment.service.js.map