import { Module } from '@nestjs/common';
import { TelegramBotService } from './telegram-bot.service';
import { PrismaService } from '../database/prisma.service';
import { UserService } from '../services/user.service';
import { TaskService } from '../services/task.service';
import { OpenAIService } from '../services/openai.service';
import { BillingService } from '../services/billing.service';

@Module({
  providers: [
    TelegramBotService,
    PrismaService,
    UserService,
    TaskService,
    OpenAIService,
    BillingService,
  ],
  exports: [TelegramBotService],
})
export class TelegramBotModule {}
