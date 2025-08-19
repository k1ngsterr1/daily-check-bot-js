import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { PrismaService } from './database/prisma.service';
import {
  UserService,
  TaskService,
  HabitService,
  MoodService,
  FocusService,
} from './services';
import { TelegramBotModule } from './bot/telegram-bot.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ScheduleModule.forRoot(),
    TelegramBotModule,
  ],
  providers: [
    PrismaService,
    UserService,
    TaskService,
    HabitService,
    MoodService,
    FocusService,
  ],
})
export class AppModule {}
