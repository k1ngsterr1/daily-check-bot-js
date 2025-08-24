"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var NotificationService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const prisma_service_1 = require("../database/prisma.service");
const telegram_bot_service_1 = require("../bot/telegram-bot.service");
const habit_service_1 = require("./habit.service");
const cron = __importStar(require("node-cron"));
let NotificationService = NotificationService_1 = class NotificationService {
    prisma;
    telegramBotService;
    habitService;
    schedulerRegistry;
    logger = new common_1.Logger(NotificationService_1.name);
    activeReminders = new Map();
    constructor(prisma, telegramBotService, habitService, schedulerRegistry) {
        this.prisma = prisma;
        this.telegramBotService = telegramBotService;
        this.habitService = habitService;
        this.schedulerRegistry = schedulerRegistry;
    }
    async onModuleInit() {
        await this.loadActiveHabitReminders();
        this.logger.log('Notification service initialized');
    }
    async loadActiveHabitReminders() {
        const activeHabits = await this.prisma.habit.findMany({
            where: {
                isActive: true,
                reminderTime: { not: null },
            },
            include: {
                user: true,
            },
        });
        for (const habit of activeHabits) {
            await this.scheduleHabitReminder(habit);
        }
        this.logger.log(`Loaded ${activeHabits.length} habit reminders`);
    }
    async scheduleHabitReminder(habit) {
        const cronPattern = this.parseReminderPattern(habit.reminderTime, habit.frequency);
        if (!cronPattern) {
            this.logger.warn(`Could not parse reminder pattern for habit ${habit.id}`);
            return;
        }
        const jobName = `habit_reminder_${habit.id}`;
        if (this.activeReminders.has(jobName)) {
            this.cancelHabitReminder(habit.id);
        }
        try {
            const task = cron.schedule(cronPattern, async () => {
                await this.sendHabitReminder(habit);
            });
            this.activeReminders.set(jobName, task);
            task.start();
            this.logger.log(`Scheduled reminder for habit "${habit.title}" with pattern: ${cronPattern}`);
        }
        catch (error) {
            this.logger.error(`Failed to schedule reminder for habit ${habit.id}:`, error);
        }
    }
    parseReminderPattern(reminderTime, frequency) {
        if (reminderTime.includes('каждый час') ||
            reminderTime.includes('hourly')) {
            return '0 * * * *';
        }
        if (reminderTime.includes('каждые 2 часа') ||
            reminderTime.includes('every 2 hours')) {
            return '0 */2 * * *';
        }
        if (reminderTime.includes('каждые 3 часа') ||
            reminderTime.includes('every 3 hours')) {
            return '0 */3 * * *';
        }
        if (reminderTime.includes('каждые 4 часа') ||
            reminderTime.includes('every 4 hours')) {
            return '0 */4 * * *';
        }
        if (reminderTime.includes('каждые 6 часов') ||
            reminderTime.includes('every 6 hours')) {
            return '0 */6 * * *';
        }
        const timeMatch = reminderTime.match(/(\d{1,2}):(\d{2})/);
        if (timeMatch) {
            const [, hours, minutes] = timeMatch;
            if (frequency === 'DAILY') {
                return `${minutes} ${hours} * * *`;
            }
            if (frequency === 'WEEKLY') {
                return `${minutes} ${hours} * * 1`;
            }
        }
        if (reminderTime.includes('каждую минуту') ||
            reminderTime.includes('every minute')) {
            return '* * * * *';
        }
        if (reminderTime.includes('каждые две минуты') ||
            reminderTime.includes('каждые 2 минуты') ||
            reminderTime.includes('every 2 minutes')) {
            return '*/2 * * * *';
        }
        if (reminderTime.includes('каждые три минуты') ||
            reminderTime.includes('каждые 3 минуты') ||
            reminderTime.includes('every 3 minutes')) {
            return '*/3 * * * *';
        }
        if (reminderTime.includes('каждые пять минут') ||
            reminderTime.includes('каждые 5 минут') ||
            reminderTime.includes('every 5 minutes')) {
            return '*/5 * * * *';
        }
        if (reminderTime.includes('каждые десять минут') ||
            reminderTime.includes('каждые 10 минут') ||
            reminderTime.includes('every 10 minutes')) {
            return '*/10 * * * *';
        }
        if (reminderTime.includes('каждые 15 минут') ||
            reminderTime.includes('every 15 minutes')) {
            return '*/15 * * * *';
        }
        if (reminderTime.includes('каждые 30 минут') ||
            reminderTime.includes('каждые полчаса') ||
            reminderTime.includes('every 30 minutes')) {
            return '*/30 * * * *';
        }
        if (frequency === 'DAILY') {
            return '0 9 * * *';
        }
        return null;
    }
    async sendHabitReminder(habit) {
        try {
            const user = habit.user ||
                (await this.prisma.user.findUnique({
                    where: { id: habit.userId },
                }));
            if (!user) {
                this.logger.warn(`User not found for habit ${habit.id}`);
                return;
            }
            const message = this.generateReminderMessage(habit);
            const keyboard = this.generateReminderKeyboard(habit.id);
            await this.telegramBotService.sendMessageToUser(parseInt(user.id), message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard,
            });
            await this.prisma.habit.update({
                where: { id: habit.id },
                data: { updatedAt: new Date() },
            });
            this.logger.log(`Sent reminder for habit "${habit.title}" to user ${user.id}`);
        }
        catch (error) {
            this.logger.error(`Failed to send reminder for habit ${habit.id}:`, error);
        }
    }
    generateReminderMessage(habit) {
        const messages = {
            'пить воду каждый час': [
                '💧 Время пить воду! Не забывайте о гидратации!',
                '🚰 Пора выпить стакан воды! Ваш организм скажет спасибо!',
                '💦 Напоминание: время для воды! Поддерживайте водный баланс!',
            ],
            'делать зарядку': [
                '🏃‍♂️ Время для зарядки! Разомните тело!',
                '💪 Пора делать упражнения! Ваше тело ждет движения!',
                '🤸‍♀️ Время зарядки! Несколько упражнений придадут бодрости!',
            ],
            медитация: [
                '🧘‍♂️ Время для медитации. Найдите несколько минут для себя!',
                '🌸 Пора помедитировать! Успокойте ум и расслабьтесь!',
                '☯️ Время внутренней гармонии! Несколько минут медитации!',
            ],
        };
        const habitTitle = habit.title.toLowerCase();
        for (const [key, messageList] of Object.entries(messages)) {
            if (habitTitle.includes(key)) {
                return messageList[Math.floor(Math.random() * messageList.length)];
            }
        }
        return `⏰ *Напоминание о привычке*\n\n🎯 ${habit.title}\n\nВремя выполнить вашу привычку!`;
    }
    generateReminderKeyboard(habitId) {
        return {
            inline_keyboard: [
                [
                    { text: '✅ Выполнил', callback_data: `complete_habit_${habitId}` },
                    {
                        text: '⏰ Отложить на 15 мин',
                        callback_data: `snooze_habit_${habitId}_15`,
                    },
                ],
                [
                    { text: '📊 Статистика', callback_data: `habit_stats_${habitId}` },
                    {
                        text: '❌ Пропустить сегодня',
                        callback_data: `skip_habit_${habitId}`,
                    },
                ],
            ],
        };
    }
    async cancelHabitReminder(habitId) {
        const jobName = `habit_reminder_${habitId}`;
        if (this.activeReminders.has(jobName)) {
            const task = this.activeReminders.get(jobName);
            task?.stop();
            task?.destroy();
            this.activeReminders.delete(jobName);
            this.logger.log(`Cancelled reminder for habit ${habitId}`);
        }
    }
    async updateHabitReminder(habitId) {
        const habit = await this.prisma.habit.findUnique({
            where: { id: habitId },
            include: { user: true },
        });
        if (!habit) {
            return;
        }
        await this.cancelHabitReminder(habitId);
        if (habit.isActive && habit.reminderTime) {
            await this.scheduleHabitReminder(habit);
        }
    }
    async snoozeHabitReminder(habitId, minutes) {
        const delayMs = minutes * 60 * 1000;
        setTimeout(async () => {
            const habit = await this.prisma.habit.findUnique({
                where: { id: habitId },
                include: { user: true },
            });
            if (habit) {
                await this.sendHabitReminder(habit);
            }
        }, delayMs);
        this.logger.log(`Snoozed habit ${habitId} for ${minutes} minutes`);
    }
    async cleanupOldJobs() {
        this.logger.log('Running daily cleanup of notification jobs');
        const inactiveHabits = await this.prisma.habit.findMany({
            where: { isActive: false },
            select: { id: true },
        });
        for (const habit of inactiveHabits) {
            await this.cancelHabitReminder(habit.id);
        }
        this.logger.log(`Cleaned up ${inactiveHabits.length} inactive habit reminders`);
    }
};
exports.NotificationService = NotificationService;
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_DAY_AT_MIDNIGHT),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], NotificationService.prototype, "cleanupOldJobs", null);
exports.NotificationService = NotificationService = NotificationService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Inject)((0, common_1.forwardRef)(() => telegram_bot_service_1.TelegramBotService))),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        telegram_bot_service_1.TelegramBotService,
        habit_service_1.HabitService,
        schedule_1.SchedulerRegistry])
], NotificationService);
//# sourceMappingURL=notification.service.js.map