import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { TelegramBotService } from '../bot/telegram-bot.service';
import { HabitService } from './habit.service';
export declare class NotificationService {
    private readonly prisma;
    private readonly telegramBotService;
    private readonly habitService;
    private readonly schedulerRegistry;
    private readonly logger;
    private activeReminders;
    constructor(prisma: PrismaService, telegramBotService: TelegramBotService, habitService: HabitService, schedulerRegistry: SchedulerRegistry);
    onModuleInit(): Promise<void>;
    loadActiveHabitReminders(): Promise<void>;
    scheduleHabitReminder(habit: any): Promise<void>;
    private parseReminderPattern;
    sendHabitReminder(habit: any): Promise<void>;
    private generateReminderMessage;
    private generateReminderKeyboard;
    cancelHabitReminder(habitId: string): Promise<void>;
    updateHabitReminder(habitId: string): Promise<void>;
    snoozeHabitReminder(habitId: string, minutes: number): Promise<void>;
    cleanupOldJobs(): Promise<void>;
}
