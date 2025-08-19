import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { YooCheckout } from '@a2seven/yoo-checkout';
import { SubscriptionType, PaymentStatus } from '@prisma/client';

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

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private yooCheckout: YooCheckout;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const shopId = this.configService.get<string>('payment.yookassa.shopId');
    const secretKey = this.configService.get<string>(
      'payment.yookassa.secretKey',
    );

    if (!shopId || !secretKey) {
      this.logger.warn(
        'YooKassa credentials not found. Payment service will be disabled.',
      );
      return;
    }

    this.yooCheckout = new YooCheckout({
      shopId,
      secretKey,
    });

    this.logger.log('YooKassa payment service initialized');
  }

  async createPayment(data: CreatePaymentData): Promise<PaymentResult> {
    if (!this.yooCheckout) {
      throw new Error('Payment service is not initialized');
    }

    try {
      // Создаем платеж в ЮKassa
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
            email: 'customer@example.com', // В реальном проекте получать email пользователя
          },
          items: [
            {
              description: data.description,
              quantity: '1.00',
              amount: {
                value: data.amount.toFixed(2),
                currency: 'RUB',
              },
              vat_code: 1, // НДС не облагается
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

      // Сохраняем информацию о платеже в БД
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
    } catch (error) {
      this.logger.error('Error creating payment:', error);
      throw new Error('Failed to create payment');
    }
  }

  async handlePaymentWebhook(paymentData: any): Promise<void> {
    try {
      const paymentId = paymentData.object.id;
      const status = paymentData.object.status;

      // Получаем платеж из БД
      const payment = await this.prisma.payment.findUnique({
        where: { transactionId: paymentId },
        include: { user: true },
      });

      if (!payment) {
        this.logger.warn(`Payment not found in database: ${paymentId}`);
        return;
      }

      // Обновляем статус платежа
      let newStatus: PaymentStatus;
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

      // Если платеж успешен, активируем подписку
      if (newStatus === 'COMPLETED') {
        await this.activateSubscription(
          payment.userId,
          payment.subscriptionType,
        );
      }

      this.logger.log(`Payment ${paymentId} status updated to ${newStatus}`);
    } catch (error) {
      this.logger.error('Error handling payment webhook:', error);
      throw error;
    }
  }

  async checkPaymentStatus(paymentId: string): Promise<string> {
    if (!this.yooCheckout) {
      throw new Error('Payment service is not initialized');
    }

    try {
      const payment = await this.yooCheckout.getPayment(paymentId);
      return payment.status;
    } catch (error) {
      this.logger.error(`Error checking payment status: ${paymentId}`, error);
      throw error;
    }
  }

  private async activateSubscription(
    userId: string,
    subscriptionType: SubscriptionType,
  ): Promise<void> {
    try {
      const now = new Date();
      const subscriptionEnds = new Date();

      // Устанавливаем период подписки (30 дней)
      subscriptionEnds.setMonth(subscriptionEnds.getMonth() + 1);

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          subscriptionType,
          subscriptionStarted: now,
          subscriptionEnds,
          isTrialActive: false, // Отключаем пробный период
        },
      });

      this.logger.log(
        `Subscription ${subscriptionType} activated for user ${userId}`,
      );
    } catch (error) {
      this.logger.error('Error activating subscription:', error);
      throw error;
    }
  }

  // Предопределенные планы подписки
  getSubscriptionPlans() {
    return {
      PREMIUM: {
        amount: 299,
        currency: 'RUB',
        period: '1 месяц',
        description: 'Premium подписка на 1 месяц',
        features: [
          '50 напоминаний в день',
          '100 ИИ-запросов в день',
          '100 задач в день',
          '20 привычек в день',
          'Расширенная аналитика',
          'Кастомные темы',
        ],
      },
      PREMIUM_PLUS: {
        amount: 599,
        currency: 'RUB',
        period: '1 месяц',
        description: 'Premium Plus подписка на 1 месяц',
        features: [
          'Безлимитные напоминания',
          'Безлимитные ИИ-запросы',
          'Безлимитные задачи и привычки',
          'Приоритетная поддержка',
          'Все Premium функции',
        ],
      },
    };
  }
}
