import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { SubscriptionType } from '@prisma/client';
export interface CreatePaymentData {
    userId: string;
    amount: number;
    description: string;
    subscriptionType: SubscriptionType;
    returnUrl?: string;
}
export interface PaymentResult {
    paymentId: string;
    confirmationUrl: string;
    status: string;
}
export declare class PaymentService {
    private readonly configService;
    private readonly prisma;
    private readonly logger;
    private yooCheckout;
    constructor(configService: ConfigService, prisma: PrismaService);
    createPayment(data: CreatePaymentData): Promise<PaymentResult>;
    handlePaymentWebhook(paymentData: any): Promise<void>;
    checkPaymentStatus(paymentId: string): Promise<string>;
    private activateSubscription;
    private processReferralPayout;
    getSubscriptionPlans(): {
        PREMIUM_MONTHLY: {
            amount: number;
            currency: string;
            period: string;
            description: string;
            subscriptionType: string;
            features: string[];
        };
        PREMIUM_YEARLY: {
            amount: number;
            currency: string;
            period: string;
            description: string;
            subscriptionType: string;
            features: string[];
        };
    };
}
