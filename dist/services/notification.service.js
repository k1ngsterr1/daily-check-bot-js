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
const openai_service_1 = require("./openai.service");
const task_service_1 = require("./task.service");
const cron = __importStar(require("node-cron"));
let NotificationService = NotificationService_1 = class NotificationService {
    prisma;
    telegramBotService;
    habitService;
    openaiService;
    taskService;
    schedulerRegistry;
    logger = new common_1.Logger(NotificationService_1.name);
    activeReminders = new Map();
    constructor(prisma, telegramBotService, habitService, openaiService, taskService, schedulerRegistry) {
        this.prisma = prisma;
        this.telegramBotService = telegramBotService;
        this.habitService = habitService;
        this.openaiService = openaiService;
        this.taskService = taskService;
        this.schedulerRegistry = schedulerRegistry;
    }
    async onModuleInit() {
        this.logger.log('Notification service initialized');
        await this.loadActiveHabitReminders();
    }
    async loadActiveHabitReminders() {
        this.logger.log('Individual habit reminders disabled - using AI notifications only');
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
            if (!user.dailyReminders) {
                this.logger.log(`User ${user.id} has disabled reminders, skipping habit reminder`);
                return;
            }
            if (await this.telegramBotService.isHabitSkippedToday(habit.id, user.id)) {
                this.logger.log(`Habit ${habit.id} is skipped for today, not sending reminder`);
                return;
            }
            const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
            if (habit.updatedAt && habit.updatedAt > thirtyMinutesAgo) {
                this.logger.log(`Habit reminder for ${habit.id} was already sent recently, skipping`);
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
                [
                    {
                        text: '🔕 Отключить уведомления',
                        callback_data: 'disable_all_reminders',
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
        this.logger.log(`Individual habit reminder update skipped for habit ${habitId} - using AI notifications only`);
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
    async checkAndSendReminders() {
        return;
        try {
            const now = new Date();
            const currentMinuteStart = new Date(now);
            currentMinuteStart.setSeconds(0, 0);
            const currentMinuteEnd = new Date(currentMinuteStart);
            currentMinuteEnd.setMinutes(currentMinuteEnd.getMinutes() + 1);
            const remindersToSend = await this.prisma.reminder.findMany({
                where: {
                    status: 'ACTIVE',
                    scheduledTime: {
                        gte: currentMinuteStart,
                        lt: currentMinuteEnd,
                    },
                },
                include: {
                    user: true,
                },
            });
            for (const reminder of remindersToSend) {
                try {
                    if (!reminder.user.dailyReminders) {
                        this.logger.log(`User ${reminder.userId} has disabled reminders, skipping`);
                        await this.prisma.reminder.update({
                            where: { id: reminder.id },
                            data: { status: 'DISMISSED' },
                        });
                        continue;
                    }
                    await this.sendGeneralReminder(reminder);
                    await this.prisma.reminder.update({
                        where: { id: reminder.id },
                        data: {
                            status: 'COMPLETED',
                        },
                    });
                    this.logger.log(`Sent reminder "${reminder.title}" to user ${reminder.userId}`);
                }
                catch (error) {
                    this.logger.error(`Failed to send reminder ${reminder.id}:`, error);
                    await this.prisma.reminder.update({
                        where: { id: reminder.id },
                        data: { status: 'DISMISSED' },
                    });
                }
            }
            if (remindersToSend.length > 0) {
                this.logger.log(`Processed ${remindersToSend.length} reminders`);
            }
        }
        catch (error) {
            this.logger.error('Error in checkAndSendReminders:', error);
        }
    }
    async sendGeneralReminder(reminder) {
        const message = `🔔 *Напоминание!*\n\n${reminder.message}`;
        await this.telegramBotService.sendMessageToUser(parseInt(reminder.user.id), message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '✅ Готово',
                            callback_data: `reminder_done_${reminder.id.substring(0, 20)}`,
                        },
                    ],
                    [
                        {
                            text: '⏰ Через 15 мин',
                            callback_data: `reminder_snooze_15_${reminder.id.substring(0, 20)}`,
                        },
                        {
                            text: '⏰ Через час',
                            callback_data: `reminder_snooze_60_${reminder.id.substring(0, 20)}`,
                        },
                    ],
                    [
                        {
                            text: '🔕 Отключить уведомления',
                            callback_data: 'disable_all_reminders',
                        },
                    ],
                ],
            },
        });
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
    async sendMorningMotivation() {
        this.logger.log('Running morning motivation messages');
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const activeDependencies = await this.prisma.dependencySupport.findMany({
                where: {
                    status: 'ACTIVE',
                    OR: [{ lastMorningSent: null }, { lastMorningSent: { lt: today } }],
                },
                include: { user: true },
            });
            for (const dependency of activeDependencies) {
                try {
                    const motivation = this.generateMorningMotivation(dependency.type);
                    await this.telegramBotService.sendMessageToUser(parseInt(dependency.user.id), `🌅 *Доброе утро!*\n\n${motivation}\n\n💪 Ты сможешь справиться с этим!`, {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '🤝 Обещаю сам себе',
                                        callback_data: `morning_promise_${dependency.type.toLowerCase()}`,
                                    },
                                ],
                            ],
                        },
                        parse_mode: 'Markdown',
                    });
                    await this.prisma.dependencySupport.update({
                        where: { id: dependency.id },
                        data: {
                            totalPromises: dependency.totalPromises + 1,
                            lastMorningSent: new Date(),
                        },
                    });
                }
                catch (error) {
                    this.logger.error(`Failed to send morning message to ${dependency.user.id}:`, error);
                }
            }
            this.logger.log(`Sent morning messages to ${activeDependencies.length} users`);
        }
        catch (error) {
            this.logger.error('Error in morning motivation job:', error);
        }
    }
    async sendEveningCheck() {
        this.logger.log('Running evening check messages');
        try {
            const activeDependencies = await this.prisma.dependencySupport.findMany({
                where: { status: 'ACTIVE' },
                include: { user: true },
            });
            for (const dependency of activeDependencies) {
                try {
                    const checkMessage = this.generateEveningCheck(dependency.type);
                    await this.telegramBotService.sendMessageToUser(parseInt(dependency.user.id), `🌙 *Время подвести итоги дня*\n\n${checkMessage}\n\n❓ Как прошел день? Продержался?`, {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '💪 Держусь',
                                        callback_data: `evening_holding_${dependency.type.toLowerCase()}`,
                                    },
                                    {
                                        text: '😔 Сдался',
                                        callback_data: `evening_failed_${dependency.type.toLowerCase()}`,
                                    },
                                ],
                            ],
                        },
                        parse_mode: 'Markdown',
                    });
                }
                catch (error) {
                    this.logger.error(`Failed to send evening message to ${dependency.user.id}:`, error);
                }
            }
            this.logger.log(`Sent evening messages to ${activeDependencies.length} users`);
        }
        catch (error) {
            this.logger.error('Error in evening check job:', error);
        }
    }
    generateMorningMotivation(dependencyType) {
        const motivations = {
            SMOKING: [
                '🚭 Каждый день без сигарет - это день, когда ты становишься сильнее',
                '🌱 Твоё тело уже начинает восстанавливаться. Продолжай!',
                '💨 Каждый вдох чистого воздуха - это твоя победа',
            ],
            ALCOHOL: [
                '🧠 Ясность мысли и энергия - это твои награды за трезвость',
                '💪 Ты контролируешь свою жизнь, а не зависимость',
                '🌟 Каждый трезвый день приближает тебя к лучшей версии себя',
            ],
            DRUGS: [
                '🆓 Свобода от веществ - это свобода быть собой',
                '🧘‍♂️ Твой разум становится яснее с каждым днем',
                '🌈 Жизнь полна красок, когда ты видишь её реальной',
            ],
            GAMING: [
                '🎯 Реальная жизнь - это твоя главная игра',
                '⏰ Время, потраченное на развитие, никогда не теряется',
                '🌱 Каждый день без игр - шаг к новым достижениям',
            ],
            SOCIAL_MEDIA: [
                '📱 Реальный мир намного интереснее виртуального',
                '👥 Живое общение дает энергию, которую не даст экран',
                '🧘‍♀️ Покой ума приходит с отключением от постоянного потока информации',
            ],
        };
        const typeMotivations = motivations[dependencyType] || motivations.SMOKING;
        return typeMotivations[Math.floor(Math.random() * typeMotivations.length)];
    }
    generateEveningCheck(dependencyType) {
        const checks = {
            SMOKING: '🚭 Как дела с отказом от курения?',
            ALCOHOL: '🍷 Как прошел день без алкоголя?',
            DRUGS: '💊 Удалось ли избежать употребления?',
            GAMING: '🎮 Контролировал ли время за играми?',
            SOCIAL_MEDIA: '📱 Как дела с ограничением соцсетей?',
        };
        return checks[dependencyType] || checks.SMOKING;
    }
    async sendMorningAINotifications() {
        this.logger.log('Running morning AI notifications for all users');
        try {
            const users = await this.prisma.user.findMany({
                where: {
                    timezone: { not: null },
                    OR: [
                        { habits: { some: { isActive: true } } },
                        { tasks: { some: { status: 'PENDING' } } },
                    ],
                },
                include: {
                    habits: { where: { isActive: true } },
                    tasks: { where: { status: 'PENDING' } },
                },
            });
            for (const user of users) {
                try {
                    const tasksText = user.tasks.map((t) => t.title).join(', ');
                    const habitsText = user.habits.map((h) => h.title).join(', ');
                    const aiPrompt = `
Создай короткое (не более 2-3 предложений) мотивационное утреннее сообщение на русском языке для пользователя.

Задачи на сегодня: ${tasksText || 'Нет задач'}
Привычки: ${habitsText || 'Нет привычек'}

Сообщение должно быть:
- Энергичным и мотивирующим
- Кратким и емким
- Содержать практические советы
- Начинаться с эмодзи утра (🌅 или ☀️)
`;
                    const aiAdvice = await this.openaiService.getAIResponse(aiPrompt);
                    await this.telegramBotService.sendMessageToUser(parseInt(user.id), `${aiAdvice}\n\n💪 Удачного дня!`, {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🎯 Мои привычки', callback_data: 'my_habits' }],
                                [{ text: '📝 Мои задачи', callback_data: 'my_tasks' }],
                            ],
                        },
                        parse_mode: 'Markdown',
                    });
                    this.logger.log(`Sent morning AI notification to user ${user.id}`);
                }
                catch (error) {
                    this.logger.error(`Failed to send morning AI notification to ${user.id}:`, error);
                }
            }
            this.logger.log(`Sent morning AI notifications to ${users.length} users`);
        }
        catch (error) {
            this.logger.error('Error in morning AI notifications job:', error);
        }
    }
    async sendEveningAISummary() {
        this.logger.log('Running evening AI summary for all users');
        try {
            const users = await this.prisma.user.findMany({
                where: {
                    timezone: { not: null },
                    OR: [
                        { habits: { some: { isActive: true } } },
                        {
                            tasks: {
                                some: {
                                    status: 'COMPLETED',
                                    updatedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
                                },
                            },
                        },
                    ],
                },
                include: {
                    habits: { where: { isActive: true } },
                    tasks: {
                        where: {
                            status: 'COMPLETED',
                            updatedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
                        },
                    },
                },
            });
            for (const user of users) {
                try {
                    const completedTasksText = user.tasks.map((t) => t.title).join(', ');
                    const habitsText = user.habits.map((h) => h.title).join(', ');
                    const aiPrompt = `
Создай короткий (не более 3-4 предложений) вечерний анализ дня на русском языке для пользователя.

Выполненные задачи сегодня: ${completedTasksText || 'Нет выполненных задач'}
Привычки пользователя: ${habitsText || 'Нет привычек'}

Сообщение должно быть:
- Анализирующим прогресс
- Поддерживающим
- Содержать рекомендации на завтра
- Начинаться с вечернего эмодзи (🌙 или 🌆)
`;
                    const aiAnalysis = await this.openaiService.getAIResponse(aiPrompt);
                    await this.telegramBotService.sendMessageToUser(parseInt(user.id), `${aiAnalysis}\n\n😴 Спокойной ночи!`, {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📊 Мой прогресс', callback_data: 'my_progress' }],
                                [
                                    {
                                        text: '🎯 Завтра начнем сначала!',
                                        callback_data: 'back_to_menu',
                                    },
                                ],
                            ],
                        },
                        parse_mode: 'Markdown',
                    });
                    this.logger.log(`Sent evening AI summary to user ${user.id}`);
                }
                catch (error) {
                    this.logger.error(`Failed to send evening AI summary to ${user.id}:`, error);
                }
            }
            this.logger.log(`Sent evening AI summaries to ${users.length} users`);
        }
        catch (error) {
            this.logger.error('Error in evening AI summary job:', error);
        }
    }
};
exports.NotificationService = NotificationService;
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_DAY_AT_MIDNIGHT),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], NotificationService.prototype, "cleanupOldJobs", null);
__decorate([
    (0, schedule_1.Cron)('0 9 * * *'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], NotificationService.prototype, "sendMorningMotivation", null);
__decorate([
    (0, schedule_1.Cron)('0 21 * * *'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], NotificationService.prototype, "sendEveningCheck", null);
__decorate([
    (0, schedule_1.Cron)('0 9 * * *'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], NotificationService.prototype, "sendMorningAINotifications", null);
__decorate([
    (0, schedule_1.Cron)('0 21 * * *'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], NotificationService.prototype, "sendEveningAISummary", null);
exports.NotificationService = NotificationService = NotificationService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Inject)((0, common_1.forwardRef)(() => telegram_bot_service_1.TelegramBotService))),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        telegram_bot_service_1.TelegramBotService,
        habit_service_1.HabitService,
        openai_service_1.OpenAIService,
        task_service_1.TaskService,
        schedule_1.SchedulerRegistry])
], NotificationService);
//# sourceMappingURL=notification.service.js.map