import { Module } from '@nestjs/common';
import { TelegramBotService } from './telegram-bot.service';
import { PrismaService } from '../database/prisma.service';
import { UserService } from '../services/user.service';
import { TaskService } from '../services/task.service';
import { HabitService } from '../services/habit.service';
import { OpenAIService } from '../services/openai.service';
import { BillingService } from '../services/billing.service';
import { AiContextService } from '../services/ai-context.service';
import { PaymentService } from '../services/payment.service';

@Module({
  providers: [
    TelegramBotService,
    PrismaService,
    UserService,
    TaskService,
    HabitService,
    OpenAIService,
    BillingService,
    AiContextService,
    PaymentService,
  ],
  exports: [TelegramBotService],
})
export class TelegramBotModule {}
