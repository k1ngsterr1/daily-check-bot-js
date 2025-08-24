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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var TelegramBotService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramBotService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const telegraf_1 = require("telegraf");
const client_1 = require("@prisma/client");
const user_service_1 = require("../services/user.service");
const openai_service_1 = require("../services/openai.service");
const task_service_1 = require("../services/task.service");
const habit_service_1 = require("../services/habit.service");
const billing_service_1 = require("../services/billing.service");
const ai_context_service_1 = require("../services/ai-context.service");
const payment_service_1 = require("../services/payment.service");
const prisma_service_1 = require("../database/prisma.service");
const notification_service_1 = require("../services/notification.service");
let TelegramBotService = TelegramBotService_1 = class TelegramBotService {
    configService;
    userService;
    openaiService;
    taskService;
    habitService;
    billingService;
    aiContextService;
    paymentService;
    prisma;
    notificationService;
    logger = new common_1.Logger(TelegramBotService_1.name);
    bot;
    activePomodoroSessions = new Map();
    activeIntervalReminders = new Map();
    constructor(configService, userService, openaiService, taskService, habitService, billingService, aiContextService, paymentService, prisma, notificationService) {
        this.configService = configService;
        this.userService = userService;
        this.openaiService = openaiService;
        this.taskService = taskService;
        this.habitService = habitService;
        this.billingService = billingService;
        this.aiContextService = aiContextService;
        this.paymentService = paymentService;
        this.prisma = prisma;
        this.notificationService = notificationService;
        const token = this.configService.get('bot.token');
        if (!token) {
            throw new Error('BOT_TOKEN is not provided');
        }
        this.bot = new telegraf_1.Telegraf(token);
        this.setupMiddleware();
        this.setupHandlers();
        this.setupErrorHandling();
    }
    setupMiddleware() {
        this.bot.use((0, telegraf_1.session)({
            defaultSession: () => ({
                step: undefined,
                data: {},
                waitingForInput: false,
                currentAction: undefined,
                tempData: {},
            }),
        }));
        this.bot.use(async (ctx, next) => {
            if (ctx.from) {
                ctx.userId = ctx.from.id.toString();
                const existingUser = await this.userService
                    .findByTelegramId(ctx.from.id.toString())
                    .catch(() => null);
                if (!existingUser) {
                    await this.userService.findOrCreateUser({
                        id: ctx.from.id.toString(),
                        username: ctx.from.username,
                        firstName: ctx.from.first_name,
                        lastName: ctx.from.last_name,
                    });
                    await this.billingService.initializeTrialForUser(ctx.from.id.toString());
                }
            }
            ctx.replyWithMarkdown = (text, extra = {}) => {
                return ctx.reply(text, { parse_mode: 'Markdown', ...extra });
            };
            ctx.editMessageTextWithMarkdown = (text, extra = {}) => {
                return ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra });
            };
            return next();
        });
    }
    setupErrorHandling() {
        this.bot.catch(async (err, ctx) => {
            this.logger.error('Bot error for message:', err);
            try {
                const error = err;
                if (error.message &&
                    error.message.includes("message can't be edited")) {
                    await ctx.replyWithMarkdown('❌ Произошла ошибка. Попробуйте позже или обратитесь к администратору.');
                }
                else {
                    await ctx.replyWithMarkdown('❌ Произошла ошибка. Попробуйте позже или обратитесь к администратору.');
                }
            }
            catch (responseError) {
                this.logger.error('Failed to send error response:', responseError);
            }
        });
    }
    setupHandlers() {
        this.bot.start(async (ctx) => {
            try {
                const startPayload = ctx.startPayload;
                let referrerId;
                if (startPayload && startPayload.startsWith('ref_')) {
                    referrerId = startPayload.replace('ref_', '');
                    this.logger.log(`User started with referral from: ${referrerId}`);
                }
                const userData = {
                    id: ctx.from?.id.toString() || ctx.userId,
                    username: ctx.from?.username || undefined,
                    firstName: ctx.from?.first_name || undefined,
                    lastName: ctx.from?.last_name || undefined,
                };
                const user = await this.userService.findOrCreateUser(userData);
                if (referrerId && referrerId !== user.id) {
                    await this.handleReferralRegistration(ctx, user.id, referrerId);
                }
                this.logger.log(`User ${user.id} started bot. Onboarding passed: ${user.onboardingPassed}`);
                if (!user.onboardingPassed) {
                    this.logger.log(`Starting onboarding for user ${user.id}`);
                    await this.startOnboarding(ctx);
                }
                else {
                    this.logger.log(`Showing main menu for user ${user.id}`);
                    await this.showMainMenu(ctx);
                }
            }
            catch (error) {
                this.logger.error('Error in start command:', error);
                await ctx.replyWithMarkdown('❌ Произошла ошибка при запуске бота. Попробуйте еще раз.');
            }
        });
        this.bot.on('voice', async (ctx) => {
            try {
                await ctx.replyWithMarkdown('🎤 Обрабатываю голосовое сообщение...');
                const userId = ctx.from.id.toString();
                const voiceMessage = ctx.message.voice;
                const taskTitle = `📝 Задача из голосового сообщения (${new Date().toLocaleTimeString('ru-RU')})`;
                const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
                const task = await this.taskService.createTask({
                    userId,
                    title: taskTitle,
                    description: 'Создано из голосового сообщения. Добавьте описание.',
                    priority: 'MEDIUM',
                    dueDate,
                });
                const keyboard = {
                    inline_keyboard: [
                        [
                            {
                                text: '✅ Выполнено',
                                callback_data: `task_complete_${task.id}`,
                            },
                            {
                                text: '✏️ Редактировать',
                                callback_data: `task_edit_${task.id}`,
                            },
                        ],
                        [
                            { text: '📋 Все задачи', callback_data: 'tasks_list' },
                            { text: '🔄 Главное меню', callback_data: 'main_menu' },
                        ],
                    ],
                };
                const intervalInfo = this.extractTimeIntervalFromText(taskTitle);
                let responseMessage = `✅ *Задача создана!*\n\n` +
                    `📝 *Название:* ${task.title}\n` +
                    `📅 *Срок:* ${task.dueDate ? task.dueDate.toLocaleDateString('ru-RU') : 'Не указан'}\n` +
                    `🎯 *Приоритет:* ${this.getPriorityEmoji(task.priority)} ${task.priority}`;
                if (intervalInfo) {
                    responseMessage += `\n\n⏰ **Следующее уведомление о задаче будет отправлено в ${intervalInfo.nextTime}**`;
                }
                responseMessage += `\n\n💡 *Совет:* Нажмите "Редактировать", чтобы добавить подробное описание задачи.`;
                await ctx.replyWithMarkdown(responseMessage, {
                    reply_markup: keyboard,
                });
                this.logger.log(`Task created from voice message for user ${userId}: ${task.id}`);
            }
            catch (error) {
                this.logger.error('Error handling voice message:', error);
                await ctx.replyWithMarkdown('❌ Не удалось создать задачу из голосового сообщения. Попробуйте еще раз.');
            }
        });
        this.bot.help(async (ctx) => {
            await ctx.replyWithMarkdown(`
🤖 *Ticky AI - Ваш персональный AI помощник продуктивности*

*Основные команды:*
/start - Начать работу с ботом
/help - Показать эту справку
/menu - Главное меню
/feedback - Оставить отзыв о боте
/tasks - Управление задачами
/habits - Управление привычками
/mood - Отметить настроение
/focus - Сессия фокуса
/stats - Статистика
/settings - Настройки

*Быстрые действия:*
📝 Добавить задачу
✅ Завершить задачу
🔄 Добавить привычку
😊 Отметить настроение
⏰ Сессия фокуса

Для получения подробной информации используйте /menu
      `);
        });
        this.bot.command('menu', async (ctx) => {
            await this.showMainMenu(ctx);
        });
        this.bot.command('tasks', async (ctx) => {
            await this.showTasksMenu(ctx);
        });
        this.bot.command('habits', async (ctx) => {
            await this.showHabitsMenu(ctx);
        });
        this.bot.command('mood', async (ctx) => {
            await this.showMoodMenu(ctx);
        });
        this.bot.command('focus', async (ctx) => {
            await this.showFocusSession(ctx);
        });
        this.bot.command('help', async (ctx) => {
            const helpMessage = `
🤖 *Ticky AI - Справка*

**Доступные команды:**
/start - Начать работу с ботом
/help - Показать эту справку
/menu - Главное меню
/feedback - Оставить отзыв о боте
/tasks - Управление задачами
/habits - Управление привычками
/mood - Отметить настроение
/focus - Сессия фокуса
/reminders - Активные напоминания
/testnotify - Тестовое уведомление

**Основные функции:**
📝 Управление задачами и привычками
😊 Трекинг настроения
🍅 Техника Помодоро для фокуса
📊 Статистика и аналитика
⏰ Умные напоминания о привычках
💎 Система биллинга с пробным периодом

Для получения подробной информации используйте /menu
      `;
            if (ctx.callbackQuery) {
                await ctx.editMessageTextWithMarkdown(helpMessage);
            }
            else {
                await ctx.replyWithMarkdown(helpMessage);
            }
        });
        this.bot.command('feedback', async (ctx) => {
            try {
                await this.showFeedbackSurvey(ctx);
            }
            catch (error) {
                this.logger.error('Error in feedback command:', error);
                await ctx.replyWithMarkdown('❌ Произошла ошибка. Попробуйте позже.');
            }
        });
        this.bot.command('testnotify', async (ctx) => {
            try {
                const userId = ctx.from.id.toString();
                const habit = await this.prisma.habit.findFirst({
                    where: { userId, isActive: true },
                });
                if (!habit) {
                    await ctx.reply('❌ У вас нет активных привычек для тестирования.');
                    return;
                }
                const message = `⏰ *Тестовое напоминание*\n\n🎯 ${habit.title}\n\nЭто пример уведомления о привычке!`;
                const keyboard = {
                    inline_keyboard: [
                        [
                            {
                                text: '✅ Выполнил',
                                callback_data: `complete_habit_${habit.id}`,
                            },
                            {
                                text: '⏰ Отложить на 15 мин',
                                callback_data: `snooze_habit_${habit.id}_15`,
                            },
                        ],
                        [
                            {
                                text: '📊 Статистика',
                                callback_data: `habit_stats_${habit.id}`,
                            },
                            {
                                text: '❌ Пропустить сегодня',
                                callback_data: `skip_habit_${habit.id}`,
                            },
                        ],
                    ],
                };
                await ctx.reply(message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard,
                });
                this.logger.log(`Test notification sent to user ${userId} for habit ${habit.id}`);
            }
            catch (error) {
                this.logger.error('Error in test notification:', error);
                await ctx.reply('❌ Ошибка при отправке тестового уведомления.');
            }
        });
        this.bot.command('reminders', async (ctx) => {
            try {
                const userId = ctx.from.id.toString();
                const habitsWithReminders = await this.prisma.habit.findMany({
                    where: {
                        userId,
                        isActive: true,
                        reminderTime: { not: null },
                    },
                    orderBy: { title: 'asc' },
                });
                if (habitsWithReminders.length === 0) {
                    await ctx.reply('❌ У вас нет активных напоминаний о привычках.\n\nИспользуйте /habits для настройки напоминаний.');
                    return;
                }
                let message = `⏰ *Активные напоминания*\n\n`;
                for (const habit of habitsWithReminders) {
                    const nextTime = this.calculateNextReminderTime(habit.reminderTime || '');
                    message += `🎯 **${habit.title}**\n`;
                    message += `⏰ Интервал: ${habit.reminderTime}\n`;
                    message += `🕒 Следующее: ${nextTime}\n\n`;
                }
                message += `📱 Используйте /testnotify для тестирования`;
                await ctx.reply(message, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Мои привычки', callback_data: 'habits_list' }],
                            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                        ],
                    },
                });
            }
            catch (error) {
                this.logger.error('Error showing reminders:', error);
                await ctx.reply('❌ Ошибка при получении списка напоминаний.');
            }
        });
        this.bot.command('billing', async (ctx) => {
            const subscriptionStatus = await this.billingService.getSubscriptionStatus(ctx.userId);
            const limitsText = subscriptionStatus.limits.dailyReminders === -1
                ? '∞ (безлимит)'
                : subscriptionStatus.limits.dailyReminders.toString();
            const aiLimitsText = subscriptionStatus.limits.dailyAiQueries === -1
                ? '∞ (безлимит)'
                : subscriptionStatus.limits.dailyAiQueries.toString();
            let statusMessage = '';
            if (subscriptionStatus.isTrialActive) {
                statusMessage = `🎁 **Пробный период:** ${subscriptionStatus.daysRemaining} дней осталось`;
            }
            else {
                statusMessage = `💎 **Подписка:** ${subscriptionStatus.type === 'FREE'
                    ? 'Бесплатная'
                    : subscriptionStatus.type === 'PREMIUM'
                        ? 'Premium'
                        : 'Premium Plus'}`;
            }
            await ctx.replyWithMarkdown(`📊 *Ваши лимиты и использование*

${statusMessage}

**Текущее использование сегодня:**
🔔 Напоминания: ${subscriptionStatus.usage.dailyReminders}/${limitsText}
🧠 ИИ-запросы: ${subscriptionStatus.usage.dailyAiQueries}/${aiLimitsText}
📝 Задачи: ${subscriptionStatus.usage.dailyTasks}/${subscriptionStatus.limits.dailyTasks === -1 ? '∞' : subscriptionStatus.limits.dailyTasks}
🔄 Привычки: ${subscriptionStatus.usage.dailyHabits}/${subscriptionStatus.limits.dailyHabits === -1 ? '∞' : subscriptionStatus.limits.dailyHabits}

**Доступные функции:**
📊 Расширенная аналитика: ${subscriptionStatus.limits.advancedAnalytics ? '✅' : '❌'}
🎨 Кастомные темы: ${subscriptionStatus.limits.customThemes ? '✅' : '❌'}
🚀 Приоритетная поддержка: ${subscriptionStatus.limits.prioritySupport ? '✅' : '❌'}`, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '💎 Обновиться до Premium',
                                callback_data: 'upgrade_premium',
                            },
                        ],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.command('reset_onboarding', async (ctx) => {
            try {
                await this.userService.updateUser(ctx.userId, {
                    onboardingPassed: false,
                });
                await ctx.editMessageTextWithMarkdown('🔄 Онбординг сброшен. Используйте /start для прохождения заново.');
                this.logger.log(`Onboarding reset for user ${ctx.userId}`);
            }
            catch (error) {
                this.logger.error('Error resetting onboarding:', error);
                await ctx.replyWithMarkdown('❌ Ошибка при сбросе онбординга.');
            }
        });
        this.bot.action('onboarding_start', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showOnboardingStep2(ctx);
        });
        this.bot.action('onboarding_examples', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
📋 *Примеры того, что я умею:*

*Задачи:*
• "Купить молоко"
• "Сделать презентацию"
• "Позвонить врачу"

*Привычки:*
• "Пить 2 литра воды"
• "Делать зарядку"
• "Читать 30 минут"

*Отслеживание:*
• Настроение по шкале 1-10
• Прогресс выполнения
• Статистика и достижения
      `);
            setTimeout(async () => {
                await this.showOnboardingStep2(ctx);
            }, 3000);
        });
        this.bot.action('onboarding_add_habit', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
✍️ *Отлично! Напиши название своей первой привычки.*

Например:
• Пить воду каждый час
• Делать зарядку утром
• Читать перед сном

*Напиши название привычки:*
      `);
            ctx.session.step = 'onboarding_waiting_habit';
        });
        this.bot.action('onboarding_skip_habit', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showOnboardingStep3(ctx);
        });
        this.bot.action('onboarding_complete', async (ctx) => {
            await ctx.answerCbQuery();
            try {
                await this.userService.updateUser(ctx.userId, {
                    onboardingPassed: true,
                });
                this.logger.log(`Onboarding completed for user ${ctx.userId}`);
                await ctx.editMessageTextWithMarkdown(`
🎉 *Поздравляем! Онбординг завершен!*

Теперь ты готов к продуктивной работе с Ticky AI!

🚀 Используй /menu для доступа ко всем функциям
        `);
                setTimeout(() => {
                    this.showMainMenu(ctx, false);
                }, 2000);
            }
            catch (error) {
                this.logger.error('Error completing onboarding:', error);
                await ctx.replyWithMarkdown('❌ Ошибка при завершении онбординга. Попробуйте еще раз.');
            }
        });
        this.bot.on('text', async (ctx) => {
            const user = await this.getOrCreateUser(ctx);
            await this.updateUserActivity(ctx.userId);
            if (ctx.message.text.startsWith('/')) {
                return;
            }
            if (ctx.session.aiChatMode) {
                await this.handleAIChatMessage(ctx, ctx.message.text);
                return;
            }
            if (ctx.session.aiHabitCreationMode) {
                await this.handleAIHabitCreationMessage(ctx, ctx.message.text);
                return;
            }
            if (!user.timezone &&
                (ctx.session.step === 'adding_task' ||
                    ctx.session.step === 'adding_habit')) {
                await this.askForTimezone(ctx);
                return;
            }
            if (ctx.session.step === 'waiting_for_city') {
                await this.handleCityInput(ctx, ctx.message.text);
                return;
            }
            if (ctx.session.step === 'waiting_for_task_title') {
                await this.handleTaskCreation(ctx, ctx.message.text);
                return;
            }
            if (ctx.session.step === 'waiting_for_custom_feedback') {
                await this.completeFeedback(ctx, ctx.message.text);
                return;
            }
            if (ctx.session.step === 'waiting_custom_dependency') {
                const dependencyName = ctx.message.text.trim();
                if (!dependencyName || dependencyName.length < 2) {
                    await ctx.replyWithMarkdown('⚠️ Название зависимости должно содержать минимум 2 символа. Попробуйте еще раз:');
                    return;
                }
                ctx.session.step = undefined;
                await ctx.replyWithMarkdown(`
🎯 *Отлично! Начинаем борьбу с зависимостью: "${dependencyName}"*

🤖 Система ИИ настроена и будет отправлять вам персональные мотивационные сообщения каждый день.

� *Ты уже на правильном пути к свободе!*

Что тебе поможет:
• Ежедневные умные напоминания и поддержка
• Персональные советы от ИИ
• Напоминания о твоих целях
• Техники преодоления желаний

✅ *Напоминания активированы!*
        `, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '⬅️ К выбору зависимости',
                                    callback_data: 'choose_dependency',
                                },
                            ],
                        ],
                    },
                });
                try {
                    this.startDailyMotivation(ctx.userId, 'custom');
                    await ctx.replyWithMarkdown(`
✅ *Отлично! Запуск успешно начат!*

🎯 **Зависимость:** ${dependencyName}
📅 **Дата начала:** ${new Date().toLocaleDateString('ru-RU')}

🤖 **ИИ-система активирована:**
• Ежедневные мотивационные сообщения
• Персональные советы и поддержка
• Трекинг прогресса
• Техники преодоления желаний

💪 *Первое мотивационное сообщение придет сегодня в 21:00*

Удачи в борьбе с зависимостью! Ты справишься! 🚀
          `, {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '🏠 Главное меню',
                                        callback_data: 'back_to_menu',
                                    },
                                ],
                            ],
                        },
                    });
                }
                catch (error) {
                    this.logger.error(`Error setting up custom dependency: ${error}`);
                    await ctx.replyWithMarkdown('❌ Произошла ошибка при настройке. Попробуйте позже.', {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '⬅️ К выбору зависимости',
                                        callback_data: 'choose_dependency',
                                    },
                                ],
                            ],
                        },
                    });
                }
                return;
            }
            if (ctx.session.waitingForReminderTime && ctx.session.pendingReminder) {
                await this.handleReminderTimeInput(ctx, ctx.message.text);
                return;
            }
            if (ctx.session.step === 'onboarding_waiting_habit') {
                const habitName = ctx.message.text;
                try {
                    await this.habitService.createHabit({
                        userId: ctx.userId,
                        title: habitName,
                        description: undefined,
                        frequency: 'DAILY',
                        targetCount: 1,
                    });
                    ctx.session.step = undefined;
                    await ctx.replyWithMarkdown(`
✅ *Отличная привычка: "${habitName}"*

Привычка добавлена! Теперь ты можешь отслеживать её выполнение каждый день.

🎯 Продолжим настройку...
        `);
                    setTimeout(async () => {
                        await this.showOnboardingStep3(ctx);
                    }, 2000);
                }
                catch (error) {
                    this.logger.error('Error creating habit during onboarding:', error);
                    await ctx.replyWithMarkdown('❌ Ошибка при создании привычки. Попробуйте еще раз.');
                }
                return;
            }
            if (ctx.session.step === 'adding_habit') {
                const habitTitle = ctx.message.text.trim();
                if (!habitTitle || habitTitle.length < 2) {
                    await ctx.replyWithMarkdown('⚠️ Название привычки должно содержать минимум 2 символа. Попробуйте еще раз:');
                    return;
                }
                try {
                    await this.habitService.createHabit({
                        userId: ctx.userId,
                        title: habitTitle,
                        description: undefined,
                        frequency: 'DAILY',
                        targetCount: 1,
                    });
                    ctx.session.step = undefined;
                    await ctx.replyWithMarkdown(`
✅ *Привычка "${habitTitle}" успешно добавлена!*

🎯 Теперь вы можете отслеживать её выполнение в разделе "Мои привычки".

*Напоминание:* Регулярность - ключ к формированию привычек!
          `, {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔄 Мои привычки', callback_data: 'menu_habits' }],
                                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                            ],
                        },
                    });
                }
                catch (error) {
                    this.logger.error(`Error creating habit: ${error}`);
                    await ctx.replyWithMarkdown('❌ Произошла ошибка при создании привычки. Попробуйте позже.');
                }
                return;
            }
            if (this.isReminderRequest(ctx.message.text)) {
                this.logger.log(`Processing reminder request: "${ctx.message.text}" for user ${ctx.userId}`);
                await this.processReminderFromText(ctx, ctx.message.text);
                return;
            }
            if (ctx.session.step) {
                return;
            }
            if (this.isTaskRequest(ctx.message.text)) {
                this.logger.log(`Processing task from text: "${ctx.message.text}" for user ${ctx.userId}`);
                await this.processTaskFromText(ctx, ctx.message.text);
                return;
            }
            if (this.isGeneralChatMessage(ctx.message.text)) {
                ctx.session.aiChatMode = true;
                await this.handleAIChatMessage(ctx, ctx.message.text);
                return;
            }
            await ctx.replyWithMarkdown(`
🤔 *Не понимаю команду*

Используйте /menu для вызова главного меню или /help для справки.

💡 *Подсказка:* Вы можете написать "напомни мне..." с указанием времени для создания напоминания.
      `);
        });
        this.bot.on('voice', async (ctx) => {
            await this.handleAudioMessage(ctx, 'voice');
        });
        this.bot.on('audio', async (ctx) => {
            await this.handleAudioMessage(ctx, 'audio');
        });
        this.bot.action('menu_tasks', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            if (!user.timezone) {
                ctx.session.step = 'adding_task';
                await this.askForTimezone(ctx);
            }
            else {
                await this.showTasksMenu(ctx);
            }
        });
        this.bot.action('menu_habits', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            if (!user.timezone) {
                ctx.session.step = 'adding_habit';
                await this.askForTimezone(ctx);
            }
            else {
                await this.showHabitsMenu(ctx);
            }
        });
        this.bot.action('habits_list', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showHabitsMenu(ctx);
        });
        this.bot.action('habits_ai_advice', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showHabitsAIAdvice(ctx);
        });
        this.bot.action('habits_add', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            if (!user.timezone) {
                ctx.session.pendingAction = 'adding_habit';
                await this.askForTimezone(ctx);
            }
            else {
                ctx.session.step = 'adding_habit';
                await ctx.editMessageTextWithMarkdown('🔄 *Добавление привычки*\n\nВведите название привычки, которую хотите отслеживать:', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
                        ],
                    },
                });
            }
        });
        this.bot.action(/^habit_set_reminder_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const habitId = ctx.match[1];
            await this.showReminderSetup(ctx, habitId);
        });
        this.bot.action(/^set_reminder_(.+)_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery('⏰ Напоминание настроено!');
            const habitId = ctx.match[1];
            const interval = ctx.match[2];
            await this.setHabitReminder(ctx, habitId, interval);
        });
        this.bot.action(/^habit_complete_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const habitId = ctx.match[1];
            await this.completeHabit(ctx, habitId);
        });
        this.bot.action(/^complete_habit_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery('✅ Отличная работа!');
            const habitId = ctx.match[1];
            await this.completeHabitFromNotification(ctx, habitId);
        });
        this.bot.action(/^snooze_habit_(.+)_(\d+)$/, async (ctx) => {
            const habitId = ctx.match[1];
            const minutes = parseInt(ctx.match[2]);
            await ctx.answerCbQuery(`⏰ Напомним через ${minutes} минут`);
            await this.snoozeHabitFromNotification(ctx, habitId, minutes);
        });
        this.bot.action(/^habit_stats_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const habitId = ctx.match[1];
            await this.showHabitStatsFromNotification(ctx, habitId);
        });
        this.bot.action(/^skip_habit_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery('⏭️ Пропущено на сегодня');
            const habitId = ctx.match[1];
            await this.skipHabitFromNotification(ctx, habitId);
        });
        this.bot.action('habits_list_more', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showAllHabitsList(ctx);
        });
        this.bot.action('habits_manage', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showHabitsManagement(ctx);
        });
        this.bot.action(/^habit_delete_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const habitId = ctx.match[1];
            await this.confirmHabitDeletion(ctx, habitId);
        });
        this.bot.action(/^confirm_delete_habit_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const habitId = ctx.match[1];
            await this.deleteHabit(ctx, habitId);
        });
        this.bot.action(/^cancel_delete_habit_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery('❌ Удаление отменено');
            await this.showHabitsManagement(ctx);
        });
        this.bot.action('menu_mood', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showMoodMenu(ctx);
        });
        this.bot.action('menu_focus', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown('⏰ *Сессия фокуса* - функция в разработке');
        });
        this.bot.action('menu_stats', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown('📊 *Статистика* - функция в разработке');
        });
        this.bot.action('menu_settings', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown('⚙️ *Настройки* - функция в разработке');
        });
        this.bot.action('menu_achievements', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown('🏆 *Достижения* - функция в разработке');
        });
        this.bot.action('menu_ai', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown('💡 *ИИ Помощник* - функция в разработке');
        });
        this.bot.action('add_item', async (ctx) => {
            await ctx.answerCbQuery();
            const keyboard = {
                inline_keyboard: [
                    [{ text: '📝 Добавить задачу', callback_data: 'tasks_add' }],
                    [{ text: '🔄 Добавить привычку', callback_data: 'habits_add' }],
                    [{ text: '🎙️ Отправить голосовое', callback_data: 'voice_message' }],
                    [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
                ],
            };
            await ctx.editMessageTextWithMarkdown('➕ *Что хотите добавить?*', {
                reply_markup: keyboard,
            });
        });
        this.bot.action('voice_message', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`🎙️ *Озвучьте задачу*

Вы можете продиктовать:
• 📝 Новую задачу или напоминание
• 🔄 Новую привычку
• ❓ Любые вопросы или команды

Просто запишите и отправьте голосовое сообщение! 🎤`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'add_item' }],
                    ],
                },
            });
        });
        this.bot.action('my_items', async (ctx) => {
            await ctx.answerCbQuery();
            const keyboard = {
                inline_keyboard: [
                    [{ text: '📝 Мои задачи', callback_data: 'tasks_list' }],
                    [{ text: '🔄 Мои привычки', callback_data: 'habits_list' }],
                    [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
                ],
            };
            await ctx.editMessageTextWithMarkdown('📋 *Что хотите посмотреть?*', {
                reply_markup: keyboard,
            });
        });
        this.bot.action('my_progress', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            const userStats = await this.userService.getUserStats(ctx.userId);
            const currentLevelXp = this.userService.getCurrentLevelXp(user);
            const nextLevelXp = this.userService.getNextLevelXp(user);
            const progressXp = this.userService.getProgressXp(user);
            const xpToNextLevel = this.userService.getXpToNextLevel(user);
            const progressRatio = this.userService.getLevelProgressRatio(user);
            const progressBarLength = 10;
            const filledBars = Math.floor(progressRatio * progressBarLength);
            const emptyBars = progressBarLength - filledBars;
            const progressBar = '█'.repeat(filledBars) + '░'.repeat(emptyBars);
            await ctx.editMessageTextWithMarkdown(`
� *Ваш прогресс*

👤 **Профиль:**
⭐ Опыт: ${user.totalXp} XP
🎖️ Уровень: ${user.level}
⏰ Часовой пояс: ${user.timezone || 'Не указан'}

�📊 **Статистика:**
📋 Всего задач: ${user.totalTasks}
✅ Выполнено: ${user.completedTasks}
📈 Процент выполнения: ${userStats.completionRate}%

🎯 **Прогресс уровня:**
\`${progressBar}\` ${Math.round(progressRatio * 100)}%
${progressXp}/${nextLevelXp - currentLevelXp} XP до ${user.level + 1} уровня

📅 **Аккаунт создан:** ${user.createdAt.toLocaleDateString('ru-RU')}

Продолжайте в том же духе! 🚀
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🎯 Детальная статистика',
                                callback_data: 'progress_stats',
                            },
                            { text: '🏆 Достижения', callback_data: 'achievements' },
                        ],
                        [{ text: '🔙 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('ai_chat', async (ctx) => {
            await ctx.answerCbQuery();
            await this.startAIChat(ctx);
        });
        this.bot.action('more_functions', async (ctx) => {
            await ctx.answerCbQuery();
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '😊 Мое настроение', callback_data: 'menu_mood' },
                        { text: '🍅 Фокусирование', callback_data: 'pomodoro_focus' },
                    ],
                    [
                        { text: '🎭 Зависимости', callback_data: 'dependencies' },
                        { text: '🚀 Челленджи', callback_data: 'challenges' },
                    ],
                    [
                        {
                            text: '💰 Бонусы и рефералы',
                            callback_data: 'bonuses_referrals',
                        },
                        { text: '🛍️ XP Магазин', callback_data: 'shop' },
                    ],
                    [
                        { text: '🥇 Достижения', callback_data: 'achievements' },
                        { text: '🔔 Напоминания', callback_data: 'reminders' },
                    ],
                    [
                        { text: '⬅️', callback_data: 'back_to_menu' },
                        { text: '👤', callback_data: 'user_profile' },
                        { text: '⚙️', callback_data: 'user_settings' },
                    ],
                ],
            };
            await ctx.editMessageTextWithMarkdown(`
🚀 *Дополнительные функции*

Выберите интересующий раздел:
      `, {
                reply_markup: keyboard,
            });
        });
        this.bot.action('progress_stats', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            const userStats = await this.userService.getUserStats(ctx.userId);
            const today = new Date();
            const todayStr = today.toLocaleDateString('ru-RU');
            await ctx.editMessageTextWithMarkdown(`
🎯 *Детальная статистика*

📊 **Общая информация:**
⭐ Опыт: ${user.totalXp} XP
🎖️ Уровень: ${user.level}
📅 Дата регистрации: ${user.createdAt.toLocaleDateString('ru-RU')}

� **Задачи:**
📝 Всего создано: ${user.totalTasks}
✅ Выполнено: ${user.completedTasks}
📈 Процент выполнения: ${userStats.completionRate}%
🎯 Сегодня: ${user.todayTasks}

🔄 **Привычки:**
💪 Всего создано: ${user.totalHabits}
✅ Выполнено: ${user.completedHabits}
� Процент выполнения: ${userStats.habitCompletionRate}%
🎯 Сегодня: ${user.todayHabits}

📈 **Прогресс за сегодня:** ${todayStr}
${user.todayTasks > 0 || user.todayHabits > 0 ? '🟢 Активный день!' : '🔴 Пока без активности'}

🎮 **Скоро появятся игры!**
🌅 Ранняя пташка (подъем до 7:00)
🏃 Спринтер задач (выполнить 5 задач подряд)  
🔥 Серия успехов (выполнить все задачи дня)
🎯 Снайпер целей (попасть в дедлайн)

Продолжайте выполнять задачи для получения XP! 🚀
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '📊 Основная статистика',
                                callback_data: 'my_progress',
                            },
                            { text: '🏆 Достижения', callback_data: 'achievements' },
                        ],
                        [{ text: '🔙 Назад', callback_data: 'more_functions' }],
                    ],
                },
            });
        });
        this.bot.action('user_settings', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await ctx.editMessageTextWithMarkdown(`
⚙️ *Настройки пользователя*

👤 **Профиль:**
🆔 ID: ${user.id}
👤 Имя: ${user.firstName || 'Не указано'}
📧 Username: ${user.username ? `@${user.username}` : 'Не указано'}

🔔 **Уведомления:**
📱 Уведомления: ${user.notifications ? '✅ Включены' : '❌ Отключены'}
⏰ Время напоминаний: ${user.reminderTime}
📊 Еженедельная сводка: ${user.weeklySummary ? '✅ Включена' : '❌ Отключена'}

🎨 **Интерфейс:**
🎭 Тема: ${user.theme}
✨ Анимации: ${user.showAnimations ? '✅ Включены' : '❌ Отключены'}
🎙️ Голосовые команды: ${user.voiceCommands ? '✅ Включены' : '❌ Отключены'}

🤖 **AI и режимы:**
🧠 AI режим: ${user.aiMode ? '✅ Включен' : '❌ Отключен'}
🔧 Режим разработки: ${user.dryMode ? '✅ Включен' : '❌ Отключен'}

🔒 **Приватность:**
👁️ Уровень приватности: ${user.privacyLevel}
🌍 Часовой пояс: ${user.timezone || 'Не установлен'}
🏙️ Город: ${user.city || 'Не указан'}
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🔔 Уведомления',
                                callback_data: 'settings_notifications',
                            },
                            { text: '🎨 Интерфейс', callback_data: 'settings_interface' },
                        ],
                        [
                            { text: '🤖 AI настройки', callback_data: 'settings_ai' },
                            { text: '🔒 Приватность', callback_data: 'settings_privacy' },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('settings_notifications', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await ctx.editMessageTextWithMarkdown(`
🔔 *Настройки уведомлений*

Текущие настройки:
📱 Уведомления: ${user.notifications ? '✅ Включены' : '❌ Отключены'}
⏰ Время напоминаний: ${user.reminderTime}
📊 Еженедельная сводка: ${user.weeklySummary ? '✅ Включена' : '❌ Отключена'}
📅 Ежедневные напоминания: ${user.dailyReminders ? '✅ Включены' : '❌ Отключены'}
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: user.notifications
                                    ? '🔕 Отключить уведомления'
                                    : '🔔 Включить уведомления',
                                callback_data: 'toggle_notifications',
                            },
                        ],
                        [
                            {
                                text: '⏰ Изменить время напоминаний',
                                callback_data: 'change_reminder_time',
                            },
                        ],
                        [
                            {
                                text: user.weeklySummary
                                    ? '📊❌ Отключить сводку'
                                    : '📊✅ Включить сводку',
                                callback_data: 'toggle_weekly_summary',
                            },
                        ],
                        [
                            {
                                text: '⬅️ Назад к настройкам',
                                callback_data: 'user_settings',
                            },
                        ],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('settings_interface', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await ctx.editMessageTextWithMarkdown(`
🎨 *Настройки интерфейса*

Текущие настройки:
🎭 Тема: ${user.theme}
✨ Анимации: ${user.showAnimations ? '✅ Включены' : '❌ Отключены'}
🎙️ Голосовые команды: ${user.voiceCommands ? '✅ Включены' : '❌ Отключены'}
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: user.showAnimations
                                    ? '✨❌ Отключить анимации'
                                    : '✨✅ Включить анимации',
                                callback_data: 'toggle_animations',
                            },
                        ],
                        [
                            {
                                text: user.voiceCommands
                                    ? '🎙️❌ Отключить голос'
                                    : '🎙️✅ Включить голос',
                                callback_data: 'toggle_voice_commands',
                            },
                        ],
                        [{ text: '🎭 Сменить тему', callback_data: 'change_theme' }],
                        [
                            {
                                text: '⬅️ Назад к настройкам',
                                callback_data: 'user_settings',
                            },
                        ],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('settings_ai', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await ctx.editMessageTextWithMarkdown(`
🤖 *AI настройки*

Текущие настройки:
🧠 AI режим: ${user.aiMode ? '✅ Включен' : '❌ Отключен'}
🔧 Режим разработки: ${user.dryMode ? '✅ Включен' : '❌ Отключен'}

💡 AI режим позволяет боту давать умные советы и помогать с планированием.
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: user.aiMode ? '🧠❌ Отключить AI' : '🧠✅ Включить AI',
                                callback_data: 'toggle_ai_mode',
                            },
                        ],
                        [
                            {
                                text: '⬅️ Назад к настройкам',
                                callback_data: 'user_settings',
                            },
                        ],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('settings_privacy', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await ctx.editMessageTextWithMarkdown(`
🔒 *Настройки приватности*

Текущие настройки:
👁️ Уровень приватности: ${user.privacyLevel}
🌍 Часовой пояс: ${user.timezone || 'Не установлен'}
🏙️ Город: ${user.city || 'Не указан'}

💡 Уровень приватности влияет на видимость вашего профиля другим пользователям.
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '👁️ Изменить приватность',
                                callback_data: 'change_privacy_level',
                            },
                        ],
                        [
                            {
                                text: '🌍 Изменить часовой пояс',
                                callback_data: 'change_timezone',
                            },
                        ],
                        [
                            {
                                text: '⬅️ Назад к настройкам',
                                callback_data: 'user_settings',
                            },
                        ],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('toggle_notifications', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await this.userService.updateUser(ctx.userId, {
                notifications: !user.notifications,
            });
            await ctx.editMessageTextWithMarkdown(`✅ Уведомления ${!user.notifications ? 'включены' : 'отключены'}`, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Назад к уведомлениям',
                                callback_data: 'settings_notifications',
                            },
                        ],
                    ],
                },
            });
        });
        this.bot.action('toggle_weekly_summary', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await this.userService.updateUser(ctx.userId, {
                weeklySummary: !user.weeklySummary,
            });
            await ctx.editMessageTextWithMarkdown(`✅ Еженедельная сводка ${!user.weeklySummary ? 'включена' : 'отключена'}`, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Назад к уведомлениям',
                                callback_data: 'settings_notifications',
                            },
                        ],
                    ],
                },
            });
        });
        this.bot.action('toggle_animations', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await this.userService.updateUser(ctx.userId, {
                showAnimations: !user.showAnimations,
            });
            await ctx.editMessageTextWithMarkdown(`✅ Анимации ${!user.showAnimations ? 'включены' : 'отключены'}`, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Назад к интерфейсу',
                                callback_data: 'settings_interface',
                            },
                        ],
                    ],
                },
            });
        });
        this.bot.action('toggle_voice_commands', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await this.userService.updateUser(ctx.userId, {
                voiceCommands: !user.voiceCommands,
            });
            await ctx.editMessageTextWithMarkdown(`✅ Голосовые команды ${!user.voiceCommands ? 'включены' : 'отключены'}`, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Назад к интерфейсу',
                                callback_data: 'settings_interface',
                            },
                        ],
                    ],
                },
            });
        });
        this.bot.action('toggle_ai_mode', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await this.userService.updateUser(ctx.userId, {
                aiMode: !user.aiMode,
            });
            await ctx.editMessageTextWithMarkdown(`✅ AI режим ${!user.aiMode ? 'включен' : 'отключен'}`, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⬅️ Назад к AI настройкам',
                                callback_data: 'settings_ai',
                            },
                        ],
                    ],
                },
            });
        });
        this.bot.action('achievements', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await ctx.editMessageTextWithMarkdown(`
🥇 *Ваши достижения*

**Разблокированные:**
🏆 Первые шаги - Создать первую задачу
⭐ Новичок - Получить 100 XP
📅 Активность - Использовать бот 3 дня

**В процессе:**
 Продуктивный - Выполнить 50 задач (${user.completedTasks}/50)
🚀 Энтузиаст - Получить 1000 XP (${user.totalXp}/1000)
🎯 Целеустремленный - Создать 20 задач (${user.totalTasks}/20)

**Заблокированные:**
⚡ Молния - Выполнить 10 задач за день
🌟 Легенда - Получить 10000 XP
🏅 Мастер - Выполнить 200 задач

Продолжайте выполнять задачи для новых достижений! 🎉
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
                    ],
                },
            });
        });
        this.bot.action('challenges', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
🚀 *Челленджи*

**Активные испытания:**
⏰ 7-дневный марафон продуктивности
📝 Выполнить 21 задачу за неделю

**Еженедельные вызовы:**
🌅 Ранняя пташка - 5 задач до 10:00
🌙 Ночная сова - 3 задачи после 20:00
⚡ Скоростной режим - 10 задач за день

**Награды:**
🏆 Значки достижений
⭐ Дополнительные XP
🎁 Бонусные возможности

*Функция в разработке - скоро новые челленджи!*
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
                    ],
                },
            });
        });
        this.bot.action('bonuses_referrals', async (ctx) => {
            await ctx.answerCbQuery();
            const botUsername = 'test_healthcheck_dev_bot';
            const referralLink = `https://t.me/${botUsername}?start=ref_${ctx.userId}`;
            const referralStats = await this.getReferralStats(ctx.userId);
            const progress = Math.min(referralStats.totalReferrals, 5);
            const progressBar = '█'.repeat(progress) + '░'.repeat(5 - progress);
            let nextMilestone = '';
            if (referralStats.totalReferrals < 1) {
                nextMilestone = '\n🎯 **Следующая цель:** 1 друг = +200 XP бонус!';
            }
            else if (referralStats.totalReferrals < 3) {
                nextMilestone = '\n🎯 **Следующая цель:** 3 друга = +500 XP бонус!';
            }
            else if (referralStats.totalReferrals < 5) {
                nextMilestone = '\n🎯 **Следующая цель:** 5 друзей = +1000 XP бонус!';
            }
            else {
                nextMilestone = '\n🏆 **Все достижения разблокированы!**';
            }
            await ctx.editMessageTextWithMarkdown(`
🤝 *РЕФЕРАЛЬНАЯ СИСТЕМА*

� **ЗАРАБАТЫВАЙТЕ РЕАЛЬНЫЕ ДЕНЬГИ!**
Получайте 40% от всех оплат друзей, которых пригласили!

💡 **ПРИМЕР:**
Ваш друг оплачивает подписку на год за 999₽
→ Вы моментально получаете 399₽ на свой счет! 💸

�🔗 **ВАША ССЫЛКА** 👇
\`${referralLink}\`

💳 **ВАШ РЕФЕРАЛЬНЫЙ БАЛАНС:**
${referralStats.referralBalance}₽

📊 **ПРОГРЕСС ДО 5 ДРУЗЕЙ:**
${progressBar} ${referralStats.totalReferrals}/5${nextMilestone}

**СТАТИСТИКА ПАРТНЕРСТВА:**
👥 Приглашено друзей: ${referralStats.totalReferrals}
💎 Активных пользователей: ${referralStats.activeReferrals}  
🎁 Получено бонусов: ${referralStats.totalBonus} XP
💰 Заработано денег: ${referralStats.referralBalance}₽

**СИСТЕМА ВОЗНАГРАЖДЕНИЙ:**
💸 **Финансовые:**
• За оплату месячной подписки друга (199₽): +79₽
• За оплату годовой подписки друга (999₽): +399₽

🎁 **XP Бонусы:**
• За каждого друга: +500 XP
• 1-й друг: +200 XP дополнительно  
• 3 друга: +500 XP дополнительно
• 5 друзей: +1000 XP дополнительно
• Друг получает: +200 XP при регистрации

**ВАШИ ДРУЗЬЯ:**
${referralStats.topReferrals && referralStats.topReferrals.length > 0
                ? referralStats.topReferrals
                    .map((ref, i) => `${i + 1}. ${ref.name} ${ref.isActive ? '🟢' : '🔴'} (${ref.joinDate})`)
                    .join('\n')
                : 'Пока нет рефералов'}

💡 **Поделитесь ссылкой с друзьями!**
🟢 = активен за неделю, 🔴 = неактивен
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '📋 Копировать ссылку',
                                callback_data: 'copy_referral_link',
                            },
                            {
                                text: '📊 Детальная статистика',
                                callback_data: 'referral_stats',
                            },
                        ],
                        [
                            { text: '💰 Вывести бонусы', callback_data: 'withdraw_bonus' },
                            { text: '💸 Вывести деньги', callback_data: 'withdraw_money' },
                        ],
                        [
                            {
                                text: '🎓 Как работает',
                                callback_data: 'how_referral_works',
                            },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
                    ],
                },
            });
        });
        this.bot.action('copy_referral_link', async (ctx) => {
            await ctx.answerCbQuery('📋 Ссылка скопирована! Поделитесь с друзьями!');
            const botUsername = 'test_healthcheck_dev_bot';
            const referralLink = `https://t.me/${botUsername}?start=ref_${ctx.userId}`;
            await ctx.reply(`🔗 *Ваша реферальная ссылка:*\n\n\`${referralLink}\`\n\n📱 Поделитесь этой ссылкой с друзьями!\n💰 За каждого приглашенного +500 XP + 40% от всех их оплат!`, { parse_mode: 'Markdown' });
        });
        this.bot.action('referral_stats', async (ctx) => {
            await ctx.answerCbQuery();
            const referralStats = await this.getReferralStats(ctx.userId);
            const monthAgo = new Date();
            monthAgo.setMonth(monthAgo.getMonth() - 1);
            const user = await this.userService.findByTelegramId(ctx.userId);
            const monthlyReferrals = await this.prisma.user.count({
                where: {
                    referredBy: user.id,
                    createdAt: {
                        gte: monthAgo,
                    },
                },
            });
            const activityPercent = referralStats.totalReferrals > 0
                ? Math.round((referralStats.activeReferrals / referralStats.totalReferrals) *
                    100)
                : 0;
            await ctx.editMessageTextWithMarkdown(`
📊 *ДЕТАЛЬНАЯ СТАТИСТИКА*

**ЗА ВСЕ ВРЕМЯ:**
👥 Всего приглашений: ${referralStats.totalReferrals}
💎 Активных рефералов: ${referralStats.activeReferrals}
💰 Заработано XP: ${referralStats.totalBonus}

**ЗА ЭТОТ МЕСЯЦ:**
📈 Новые приглашения: ${monthlyReferrals}
⭐ Активность рефералов: ${activityPercent}%
🎁 Получено бонусов: ${monthlyReferrals * 500} XP

**ДОСТИЖЕНИЯ:**
${referralStats.totalReferrals >= 1 ? '🏆 Первый друг (+200 XP)' : '🔒 Первый друг (пригласите 1 друга)'}
${referralStats.totalReferrals >= 3 ? '🏆 Тройка друзей (+500 XP)' : '� Тройка друзей (пригласите 3 друзей)'}
${referralStats.totalReferrals >= 5 ? '🏆 Пятерка друзей (+1000 XP)' : '🔒 Пятерка друзей (пригласите 5 друзей)'}

**АКТИВНОСТЬ ДРУЗЕЙ:**
${referralStats.topReferrals && referralStats.topReferrals.length > 0
                ? referralStats.topReferrals
                    .map((ref, i) => {
                    const status = ref.isActive ? '� Активен' : '🔴 Неактивен';
                    return `${i + 1}. ${ref.name} - ${status}`;
                })
                    .join('\n')
                : 'Пока нет рефералов'}

*💡 Активные друзья - это те, кто пользовался ботом за последние 7 дней*
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ К рефералам', callback_data: 'bonuses_referrals' }],
                    ],
                },
            });
        });
        this.bot.action('how_referral_works', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
🎓 *КАК РАБОТАЕТ РЕФЕРАЛЬНАЯ ПРОГРАММА*

💸 **ЗАРАБАТЫВАЙТЕ РЕАЛЬНЫЕ ДЕНЬГИ!**
Получайте 40% от всех покупок ваших друзей!

**ШАГ 1: ПОДЕЛИТЕСЬ ССЫЛКОЙ**
📱 Скопируйте свою реферальную ссылку
💬 Отправьте друзьям в чат или соцсети
🔗 Ссылка: https://t.me/test_healthcheck_dev_bot?start=ref_ВАШID

**ШАГ 2: ДРУГ РЕГИСТРИРУЕТСЯ**
👤 Друг переходит по вашей ссылке
🚀 Регистрируется в боте через /start
🎁 Получает +200 XP при регистрации

**ШАГ 3: ПОЛУЧАЕТЕ XP БОНУСЫ**
💰 +500 XP сразу за приглашение
🏆 +200 XP дополнительно за 1-го друга
🏆 +500 XP дополнительно за 3-х друзей
🏆 +1000 XP дополнительно за 5-и друзей

**ШАГ 4: ПОЛУЧАЕТЕ ДЕНЬГИ**
💸 Друг покупает подписку 199₽ → Вы получаете 79₽
💸 Друг покупает подписку 999₽ → Вы получаете 399₽
💰 Деньги зачисляются мгновенно на ваш баланс
💳 Вывод от 100₽ на карту/кошелек

**ПРИМЕР ЗАРАБОТКА:**
👥 5 друзей купили годовую подписку
💰 5 × 399₽ = 1,995₽ реальных денег!
🎁 + 4,200 XP бонусов

**УСЛОВИЯ:**
• Самоприглашение не засчитывается
• Выплаты мгновенные и пожизненные
• Минимальный вывод: 100₽

*🚀 Начните зарабатывать уже сегодня!*
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '📋 Копировать ссылку',
                                callback_data: 'copy_referral_link',
                            },
                            { text: '⬅️ К рефералам', callback_data: 'bonuses_referrals' },
                        ],
                    ],
                },
            });
        });
        this.bot.action('withdraw_bonus', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            const referralStats = await this.getReferralStats(ctx.userId);
            await ctx.editMessageTextWithMarkdown(`
💰 *ИСПОЛЬЗОВАНИЕ РЕФЕРАЛЬНЫХ БОНУСОВ*

**ВАШИ БОНУСЫ:**
⭐ Общий XP: ${user.totalXp}
🎁 Заработано с рефералов: ${referralStats.totalBonus} XP
� Уровень: ${user.level}

**КАК ИСПОЛЬЗОВАТЬ БОНУСЫ:**
📱 XP используется автоматически в боте
� Повышает ваш уровень и статус
🔓 Открывает новые функции
⚡ Ускоряет прогресс в задачах

**ПРЕИМУЩЕСТВА ВЫСОКОГО УРОВНЯ:**
🎯 Больше возможностей в боте
⭐ Эксклюзивные функции
🏆 Специальные достижения
👑 VIP статус сообщества

**БУДУЩИЕ ФУНКЦИИ:**
� Магазин наград (в разработке)
🎁 Обмен на премиум подписку
💸 Денежные выплаты (для топ-рефереров)

*� Пока XP работает как игровая валюта бота!*
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ К рефералам', callback_data: 'bonuses_referrals' }],
                    ],
                },
            });
        });
        this.bot.action('withdraw_money', async (ctx) => {
            await ctx.answerCbQuery();
            const referralStats = await this.getReferralStats(ctx.userId);
            if (referralStats.referralBalance < 100) {
                await ctx.editMessageTextWithMarkdown(`
💸 *ВЫВОД РЕФЕРАЛЬНЫХ СРЕДСТВ*

❌ **НЕДОСТАТОЧНО СРЕДСТВ ДЛЯ ВЫВОДА**

💰 Ваш баланс: ${referralStats.referralBalance}₽
💰 Минимальная сумма для вывода: 100₽

📈 **КАК УВЕЛИЧИТЬ БАЛАНС:**
• Пригласите больше друзей по реферальной ссылке
• Друзья должны оплатить подписку:
  - 199₽/месяц → Вы получите 79₽
  - 999₽/год → Вы получите 399₽

💡 **ПРИМЕР:**
Всего 1 друг с годовой подпиской = 399₽ ✅
          `, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '⬅️ К рефералам',
                                    callback_data: 'bonuses_referrals',
                                },
                            ],
                        ],
                    },
                });
                return;
            }
            await ctx.editMessageTextWithMarkdown(`
💸 *ВЫВОД РЕФЕРАЛЬНЫХ СРЕДСТВ*

💰 **К ВЫВОДУ:** ${referralStats.referralBalance}₽

📋 **СПОСОБЫ ПОЛУЧЕНИЯ:**
• Банковская карта (любой банк РФ)
• СБП (Система быстрых платежей)
• ЮMoney (Яндекс.Деньги)
• Qiwi кошелек

⏰ **СРОКИ ВЫПЛАТ:**
• Рабочие дни: 1-3 часа
• Выходные: до 24 часов

❗ **ВАЖНО:**
• Минимальная сумма: 100₽
• Комиссия: 0% (мы берем на себя)
• Налоги: согласно законодательству РФ

*📧 Для вывода средств напишите администратору: @support_bot*
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '📞 Связаться с поддержкой',
                                url: 'https://t.me/support_bot',
                            },
                        ],
                        [{ text: '⬅️ К рефералам', callback_data: 'bonuses_referrals' }],
                    ],
                },
            });
        });
        this.bot.action('user_profile', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await ctx.editMessageTextWithMarkdown(`
👤 *Ваш профиль*

**Основная информация:**
📛 Имя: ${user.firstName || 'Не указано'}
🆔 ID: ${user.id}
📅 Регистрация: ${user.createdAt.toLocaleDateString('ru-RU')}
🌍 Город: ${user.city || 'Не указан'}
⏰ Часовой пояс: ${user.timezone || 'Не указан'}

**Статистика:**
⭐ Общий опыт: ${user.totalXp} XP  
🎖️ Уровень: ${user.level}
📋 Выполнено задач: ${user.completedTasks}

**Настройки:**
🔔 Уведомления: ${user.notifications ? '✅ Включены' : '❌ Отключены'}
🎨 Тема: ${user.theme || 'Стандартная'}
🤖 ИИ-режим: ${user.aiMode ? '✅ Включен' : '❌ Отключен'}
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✏️ Редактировать', callback_data: 'edit_profile' },
                            { text: '⬅️ Назад', callback_data: 'more_functions' },
                        ],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('reminders', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showRemindersMenu(ctx);
        });
        this.bot.action('all_reminders', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showAllReminders(ctx);
        });
        this.bot.action('create_reminder_help', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showCreateReminderHelp(ctx);
        });
        this.bot.action('voice_reminder_help', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showVoiceReminderHelp(ctx);
        });
        this.bot.action('manage_reminders', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showManageReminders(ctx);
        });
        this.bot.action('reminders_stats', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showRemindersStats(ctx);
        });
        this.bot.action(/^delete_reminder_(.+)$/, async (ctx) => {
            const reminderId = ctx.match[1];
            await ctx.answerCbQuery();
            await this.handleDeleteReminder(ctx, reminderId);
        });
        this.bot.action('settings_menu', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
⚙️ *Настройки*

🚧 *Функция в разработке*

Раздел настроек будет доступен в следующем обновлении!

Здесь вы сможете настроить:
• 🔔 Уведомления и напоминания
• 🎨 Тему интерфейса
• 🌍 Часовой пояс
• 🤖 ИИ-консультанта
• 👤 Конфиденциальность профиля
• � Интеграции с другими сервисами

� Оставьте свой email в профиле, чтобы получить уведомление о запуске.
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
                    ],
                },
            });
        });
        this.bot.action('shop', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await ctx.editMessageTextWithMarkdown(`
🛍️ *XP Магазин*

💰 **Ваш баланс:** ${user.totalXp} XP

**🎨 Косметические улучшения:**
• � Эксклюзивная тема "Темная материя" - 2000 XP
• 🏆 Уникальный значок "Мастер продуктивности" - 1500 XP
• ⚡ Анимированные эмодзи набор - 800 XP
• 🌟 Кастомные стикеры - 1200 XP

**🚀 Функциональные улучшения:**
• 📈 Расширенная статистика - 3000 XP
• 🎯 Дополнительные категории задач - 2500 XP
• 🔔 Персональные уведомления - 1800 XP
• 📊 Экспорт данных - 2200 XP

💡 Заработайте XP выполняя задачи и привычки! 
⭐ В будущем здесь появятся ещё больше улучшений!
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🎭 Темы (2000 XP)', callback_data: 'buy_theme_2000' },
                            {
                                text: '🏆 Значки (1500 XP)',
                                callback_data: 'buy_badge_1500',
                            },
                        ],
                        [
                            { text: '⚡ Эмодзи (800 XP)', callback_data: 'buy_emoji_800' },
                            {
                                text: '🌟 Стикеры (1200 XP)',
                                callback_data: 'buy_stickers_1200',
                            },
                        ],
                        [
                            {
                                text: '📈 Статистика (3000 XP)',
                                callback_data: 'buy_stats_3000',
                            },
                            {
                                text: '🎯 Категории (2500 XP)',
                                callback_data: 'buy_categories_2500',
                            },
                        ],
                        [
                            {
                                text: '� Уведомления (1800 XP)',
                                callback_data: 'buy_notifications_1800',
                            },
                            {
                                text: '📊 Экспорт (2200 XP)',
                                callback_data: 'buy_export_2200',
                            },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
                        [{ text: '🏠 Главное меню', callback_data: 'start' }],
                    ],
                },
            });
        });
        this.bot.action('xp_shop', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await ctx.editMessageTextWithMarkdown(`
🛍️ *XP Магазин*

💰 **Ваш баланс:** ${user.totalXp} XP

**🎨 Косметические улучшения:**
• 🎭 Эксклюзивная тема "Темная материя" - 2000 XP
• 🏆 Уникальный значок "Мастер продуктивности" - 1500 XP
• ⚡ Анимированные эмодзи набор - 800 XP
• 🌟 Кастомные стикеры - 1200 XP

**🚀 Функциональные улучшения:**
• 📈 Расширенная статистика - 3000 XP
• 🎯 Дополнительные категории задач - 2500 XP
• 🔔 Персональные уведомления - 1800 XP
• 📊 Экспорт данных - 2200 XP

💡 Заработайте XP выполняя задачи и привычки! 
⭐ В будущем здесь появятся ещё больше улучшений!
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🎭 Темы (2000 XP)', callback_data: 'buy_theme_2000' },
                            {
                                text: '🏆 Значки (1500 XP)',
                                callback_data: 'buy_badge_1500',
                            },
                        ],
                        [
                            { text: '⚡ Эмодзи (800 XP)', callback_data: 'buy_emoji_800' },
                            {
                                text: '🌟 Стикеры (1200 XP)',
                                callback_data: 'buy_stickers_1200',
                            },
                        ],
                        [
                            {
                                text: '📈 Статистика (3000 XP)',
                                callback_data: 'buy_stats_3000',
                            },
                            {
                                text: '🎯 Категории (2500 XP)',
                                callback_data: 'buy_categories_2500',
                            },
                        ],
                        [
                            {
                                text: '🔔 Уведомления (1800 XP)',
                                callback_data: 'buy_notifications_1800',
                            },
                            {
                                text: '📊 Экспорт (2200 XP)',
                                callback_data: 'buy_export_2200',
                            },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
                        [{ text: '🏠 Главное меню', callback_data: 'start' }],
                    ],
                },
            });
        });
        this.bot.action('premium_shop', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
💳 *Премиум подписка*

**Преимущества Premium версии:**
✅ Неограниченные задачи и привычки
✅ Расширенная аналитика и отчеты
✅ Приоритетная поддержка AI
✅ Эксклюзивные темы и значки
✅ Экспорт данных в различных форматах
✅ Персональный менеджер продуктивности
✅ Интеграция с внешними сервисами
✅ Без рекламы
✅ Расширенные возможности ИИ

**Выберите план подписки:**

💰 **Ежемесячно**: 199₽/месяц
💎 **Годовая** (скидка 58%): 999₽/год

*Экономия при годовой подписке: 1389₽!*
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '💰 199₽/месяц', callback_data: 'buy_premium_monthly' },
                            {
                                text: '💎 999₽/год (-58%)',
                                callback_data: 'buy_premium_yearly',
                            },
                        ],
                        [{ text: '⬅️ Назад к XP магазину', callback_data: 'shop' }],
                        [{ text: '🏠 Главное меню', callback_data: 'start' }],
                    ],
                },
            });
        });
        this.bot.action('buy_theme_2000', async (ctx) => {
            await this.handleXPPurchase(ctx, 'theme', 2000, 'Эксклюзивная тема "Темная материя"', 'dark_matter');
        });
        this.bot.action('buy_badge_1500', async (ctx) => {
            await this.handleXPPurchase(ctx, 'badge', 1500, 'Значок "Мастер продуктивности"', 'productivity_master');
        });
        this.bot.action('buy_emoji_800', async (ctx) => {
            await this.handleXPPurchase(ctx, 'emoji', 800, 'Анимированные эмодзи набор', 'animated_emoji_pack');
        });
        this.bot.action('buy_stickers_1200', async (ctx) => {
            await this.handleXPPurchase(ctx, 'sticker', 1200, 'Кастомные стикеры', 'custom_stickers');
        });
        this.bot.action('buy_stats_3000', async (ctx) => {
            await this.handleXPPurchase(ctx, 'feature', 3000, 'Расширенная статистика', 'advanced_stats');
        });
        this.bot.action('buy_categories_2500', async (ctx) => {
            await this.handleXPPurchase(ctx, 'feature', 2500, 'Дополнительные категории задач', 'extra_categories');
        });
        this.bot.action('buy_notifications_1800', async (ctx) => {
            await this.handleXPPurchase(ctx, 'feature', 1800, 'Персональные уведомления', 'personal_notifications');
        });
        this.bot.action('buy_export_2200', async (ctx) => {
            await this.handleXPPurchase(ctx, 'feature', 2200, 'Экспорт данных', 'data_export');
        });
        this.bot.action('show_limits', async (ctx) => {
            await ctx.answerCbQuery();
            const subscriptionStatus = await this.billingService.getSubscriptionStatus(ctx.userId);
            const limitsText = subscriptionStatus.limits.dailyReminders === -1
                ? '∞ (безлимит)'
                : subscriptionStatus.limits.dailyReminders.toString();
            const aiLimitsText = subscriptionStatus.limits.dailyAiQueries === -1
                ? '∞ (безлимит)'
                : subscriptionStatus.limits.dailyAiQueries.toString();
            let statusMessage = '';
            if (subscriptionStatus.isTrialActive) {
                statusMessage = `🎁 **Пробный период:** ${subscriptionStatus.daysRemaining} дней осталось`;
            }
            else {
                statusMessage = `💎 **Подписка:** ${subscriptionStatus.type === 'FREE'
                    ? 'Бесплатная'
                    : subscriptionStatus.type === 'PREMIUM'
                        ? 'Premium'
                        : 'Premium Plus'}`;
            }
            await ctx.editMessageTextWithMarkdown(`
📊 *Ваши лимиты и использование*

${statusMessage}

**Текущее использование сегодня:**
🔔 Напоминания: ${subscriptionStatus.usage.dailyReminders}/${limitsText}
🧠 ИИ-запросы: ${subscriptionStatus.usage.dailyAiQueries}/${aiLimitsText}
📝 Задачи: ${subscriptionStatus.usage.dailyTasks}/${subscriptionStatus.limits.dailyTasks === -1 ? '∞' : subscriptionStatus.limits.dailyTasks}
🔄 Привычки: ${subscriptionStatus.usage.dailyHabits}/${subscriptionStatus.limits.dailyHabits === -1 ? '∞' : subscriptionStatus.limits.dailyHabits}

**Доступные функции:**
📊 Расширенная аналитика: ${subscriptionStatus.limits.advancedAnalytics ? '✅' : '❌'}
🎨 Кастомные темы: ${subscriptionStatus.limits.customThemes ? '✅' : '❌'}
🚀 Приоритетная поддержка: ${subscriptionStatus.limits.prioritySupport ? '✅' : '❌'}
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '💎 Обновиться до Premium',
                                callback_data: 'upgrade_premium',
                            },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('upgrade_premium', async (ctx) => {
            await ctx.answerCbQuery();
            const trialInfo = await this.billingService.getTrialInfo(ctx.userId);
            let trialText = '';
            if (trialInfo.isTrialActive) {
                trialText = `🎁 **У вас есть ${trialInfo.daysRemaining} дней пробного периода!**

`;
            }
            await ctx.editMessageTextWithMarkdown(`
💎 *Обновление до Premium*

${trialText}**Premium подписка включает:**

🔔 **50 напоминаний** в день (сейчас 5)
🧠 **100 ИИ-запросов** в день (сейчас 10)
📝 **100 задач** в день (сейчас 10)
🔄 **20 привычек** в день (сейчас 3)
📊 **Расширенная аналитика**
🎨 **Кастомные темы**
⚡ **20 фокус-сессий** в день

💰 **Стоимость:** 299₽/месяц

**Premium Plus** (безлимитный план):
∞ **Безлимитные** напоминания, задачи, привычки
🚀 **Приоритетная поддержка**
💰 **Стоимость:** 599₽/месяц

Выберите план подписки:
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '💎 Premium - 299₽', callback_data: 'buy_premium' },
                            {
                                text: '🚀 Premium Plus - 599₽',
                                callback_data: 'buy_premium_plus',
                            },
                        ],
                        [{ text: '📊 Мои лимиты', callback_data: 'show_limits' }],
                        [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('buy_premium_monthly', async (ctx) => {
            await ctx.answerCbQuery();
            await this.createPayment(ctx, 'PREMIUM');
        });
        this.bot.action('buy_premium_yearly', async (ctx) => {
            await ctx.answerCbQuery();
            await this.createPayment(ctx, 'PREMIUM_PLUS');
        });
        this.bot.action('buy_premium', async (ctx) => {
            await ctx.answerCbQuery();
            await this.createPayment(ctx, 'PREMIUM');
        });
        this.bot.action('buy_premium_plus', async (ctx) => {
            await ctx.answerCbQuery();
            await this.createPayment(ctx, 'PREMIUM_PLUS');
        });
        this.bot.action(/^check_payment_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const paymentId = ctx.match[1];
            try {
                const status = await this.paymentService.checkPaymentStatus(paymentId);
                if (status === 'succeeded') {
                    await ctx.editMessageTextWithMarkdown('✅ *Платеж успешно завершен!*\n\nВаша подписка активирована.');
                }
                else if (status === 'canceled') {
                    await ctx.editMessageTextWithMarkdown('❌ *Платеж отменен*\n\nПопробуйте оформить подписку заново.');
                }
                else {
                    await ctx.editMessageTextWithMarkdown('⏳ *Платеж в обработке*\n\nПожалуйста, подождите или проверьте позже.');
                }
            }
            catch (error) {
                await ctx.replyWithMarkdown('❌ *Ошибка при проверке платежа*\n\nПопробуйте позже.');
            }
        });
        this.bot.action('dependencies', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
🎭 *Блок зависимостей*

**Система напоминаний, поддержки и мотивации на базе искусственного интеллекта, чтобы ты смог освободиться от любой зависимости.**

      `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🎯 Выбрать зависимость',
                                callback_data: 'choose_dependency',
                            },
                            { text: '⬅️ Назад', callback_data: 'more_functions' },
                        ],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('choose_dependency', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
🎯 *Выбери свою зависимость*

**Популярные зависимости:**
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🚭 Курение', callback_data: 'dep_smoking' },
                            { text: '🍺 Алкоголь', callback_data: 'dep_alcohol' },
                        ],
                        [
                            { text: '📱 Соцсети', callback_data: 'dep_social' },
                            { text: '🎮 Игры', callback_data: 'dep_gaming' },
                        ],
                        [
                            { text: '🛒 Покупки', callback_data: 'dep_shopping' },
                            { text: '🍰 Сладкое', callback_data: 'dep_sweets' },
                        ],
                        [{ text: '✍️ Своя зависимость', callback_data: 'dep_custom' }],
                        [{ text: '⬅️ Назад', callback_data: 'dependencies' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        ['smoking', 'alcohol', 'social', 'gaming', 'shopping', 'sweets'].forEach((type) => {
            this.bot.action(`dep_${type}`, async (ctx) => {
                await ctx.answerCbQuery();
                const dependencyName = type === 'smoking'
                    ? 'курения'
                    : type === 'alcohol'
                        ? 'алкоголя'
                        : type === 'social'
                            ? 'соцсетей'
                            : type === 'gaming'
                                ? 'игр'
                                : type === 'shopping'
                                    ? 'покупок'
                                    : 'сладкого';
                await ctx.editMessageTextWithMarkdown(`
🎯 *Отлично! Начинаем борьбу с зависимостью от ${dependencyName}*

🤖 Система ИИ настроена и будет отправлять вам персональные мотивационные сообщения каждый день.

💪 *Ты уже на правильном пути к свободе!*

Что тебе поможет:
• Ежедневные умные напоминания и поддержка
• Персональные советы от ИИ
• Напоминания о твоих целях
• Техники преодоления желаний

        `, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '� Готов начать',
                                    callback_data: `setup_reminders_${type}`,
                                },
                            ],
                            [
                                {
                                    text: '⬅️ Назад',
                                    callback_data: 'choose_dependency',
                                },
                            ],
                        ],
                    },
                });
            });
        });
        this.bot.action('dep_custom', async (ctx) => {
            await ctx.answerCbQuery();
            ctx.session.step = 'waiting_custom_dependency';
            await ctx.editMessageTextWithMarkdown(`
✍️ *Создание своей зависимости*

Напишите название зависимости, от которой хотите избавиться:

*Например:* "Переедание", "Прокрастинация", "Негативные мысли" и т.д.
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'choose_dependency' }],
                    ],
                },
            });
        });
        ['smoking', 'alcohol', 'social', 'gaming', 'shopping', 'sweets'].forEach((type) => {
            this.bot.action(`setup_reminders_${type}`, async (ctx) => {
                await ctx.answerCbQuery();
                const dependencyName = type === 'smoking'
                    ? 'курения'
                    : type === 'alcohol'
                        ? 'алкоголя'
                        : type === 'social'
                            ? 'соцсетей'
                            : type === 'gaming'
                                ? 'игр'
                                : type === 'shopping'
                                    ? 'покупок'
                                    : 'сладкого';
                try {
                    this.startDailyMotivation(ctx.userId, type);
                    await ctx.editMessageTextWithMarkdown(`
✅ *Отлично! Запуск успешно начат!*

🎯 **Зависимость:** ${dependencyName}
📅 **Дата начала:** ${new Date().toLocaleDateString('ru-RU')}

🤖 **ИИ-система активирована:**
• Ежедневные мотивационные сообщения
• Персональные советы и поддержка
• Трекинг прогресса
• Техники преодоления желаний

💪 *Первое мотивационное сообщение придет сегодня в 21:00*

Удачи в борьбе с зависимостью! Ты справишься! 🚀
            `, {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '🏠 Главное меню',
                                        callback_data: 'back_to_menu',
                                    },
                                ],
                            ],
                        },
                    });
                }
                catch (error) {
                    this.logger.error(`Error setting up dependency reminders: ${error}`);
                    await ctx.editMessageTextWithMarkdown('❌ Произошла ошибка при настройке. Попробуйте позже.', {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '⬅️ Назад',
                                        callback_data: 'choose_dependency',
                                    },
                                ],
                            ],
                        },
                    });
                }
            });
        });
        this.bot.action('pomodoro_focus', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
🍅 *Техника Помодоро*

Техника Pomodoro (метод помидора) — метод тайм-менеджмента, разработанный итальянским студентом Франческо Чирилло в 1980-х годах.

Помогает повысить концентрацию и побороть прокрастинацию

**Как это работает:**
⏰ 25 минут фокуса на задаче
☕ 5 минут отдых
🔄 Повторить 4 раза
🏖️ Большой перерыв 15-30 минут

*Выберите действие:*
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🚀 Начать сессию',
                                callback_data: 'start_pomodoro_session',
                            },
                        ],
                        [
                            {
                                text: '📊 История сессий',
                                callback_data: 'pomodoro_history',
                            },
                            {
                                text: '⚙️ Настройки',
                                callback_data: 'pomodoro_settings',
                            },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
                        [{ text: '🏠 Главное меню', callback_data: 'start' }],
                    ],
                },
            });
        });
        this.bot.action('start_pomodoro_session', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.getOrCreateUser(ctx);
            if (!user.timezone) {
                await this.askForTimezone(ctx);
                return;
            }
            const startTime = new Date();
            const endTime = new Date(startTime.getTime() + 25 * 60 * 1000);
            const endTimeFormatted = this.formatTimeWithTimezone(endTime, user.timezone);
            await ctx.editMessageTextWithMarkdown(`🍅 *Сессия фокуса запущена!*

⏰ **Таймер**: 25 минут (до ${endTimeFormatted})
🎯 Сосредоточьтесь на одной задаче
📱 Уберите отвлекающие факторы
💪 Работайте до уведомления

🔔 **Вы получите уведомление через 25 минут**

*Удачной работы! 💪*`, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⏸️ Пауза',
                                callback_data: 'pause_pomodoro',
                            },
                            {
                                text: '⏹️ Стоп',
                                callback_data: 'stop_pomodoro',
                            },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                        [{ text: '🏠 Главное меню', callback_data: 'start' }],
                    ],
                },
            });
            const existingSession = this.activePomodoroSessions.get(ctx.userId);
            if (existingSession) {
                if (existingSession.focusTimer)
                    clearTimeout(existingSession.focusTimer);
                if (existingSession.breakTimer)
                    clearTimeout(existingSession.breakTimer);
            }
            const focusTimer = setTimeout(async () => {
                try {
                    await ctx.editMessageTextWithMarkdown(`
🔔 *Время фокуса закончилось!*

🎉 Поздравляем! Вы сосредоточенно работали 25 минут.

☕ Время для 5-минутного перерыва:
• Встаньте и разомнитесь
• Посмотрите в окно
• Выпейте воды
• Не проверяйте соцсети!

⏰ Перерыв заканчивается через 5 минут.
          `);
                    const breakTimer = setTimeout(async () => {
                        try {
                            await ctx.editMessageTextWithMarkdown(`
⏰ *Перерыв закончился!*

🍅 5-минутный перерыв завершен. Готовы к следующей сессии фокуса?

💪 Следующий цикл:
• 25 минут фокуса
• 5 минут отдыха  
• После 4 циклов - длинный перерыв 15-30 минут

🎯 Хотите продолжить?
              `, {
                                reply_markup: {
                                    inline_keyboard: [
                                        [
                                            {
                                                text: '🚀 Начать новую сессию',
                                                callback_data: 'start_pomodoro_session',
                                            },
                                        ],
                                        [
                                            {
                                                text: '📊 Посмотреть статистику',
                                                callback_data: 'pomodoro_history',
                                            },
                                        ],
                                        [
                                            {
                                                text: '⬅️ Назад',
                                                callback_data: 'pomodoro_focus',
                                            },
                                        ],
                                    ],
                                },
                            });
                            this.activePomodoroSessions.delete(ctx.userId);
                        }
                        catch (error) {
                            console.log('Failed to send break completion message:', error);
                        }
                    }, 5 * 60 * 1000);
                    const session = this.activePomodoroSessions.get(ctx.userId);
                    if (session) {
                        session.breakTimer = breakTimer;
                    }
                }
                catch (error) {
                    console.log('Failed to send pomodoro completion message:', error);
                }
            }, 25 * 60 * 1000);
            this.activePomodoroSessions.set(ctx.userId, {
                focusTimer,
                startTime,
            });
        });
        this.bot.action('pause_pomodoro', async (ctx) => {
            await ctx.answerCbQuery();
            const session = this.activePomodoroSessions.get(ctx.userId);
            if (session) {
                if (session.focusTimer) {
                    clearTimeout(session.focusTimer);
                    session.focusTimer = undefined;
                }
                session.pausedAt = new Date();
                const totalElapsed = new Date().getTime() -
                    session.startTime.getTime() -
                    (session.totalPausedTime || 0);
                const elapsed = Math.floor(totalElapsed / (1000 * 60));
                const remaining = Math.max(0, 25 - elapsed);
                const remainingMinutes = remaining;
                const remainingSeconds = Math.max(0, Math.floor((25 * 60 * 1000 - totalElapsed) / 1000) % 60);
                await ctx.editMessageTextWithMarkdown(`
⏸️ *Сессия приостановлена*

⏰ Осталось времени: ${remainingMinutes}:${remainingSeconds.toString().padStart(2, '0')}
⚡ Прошло: ${elapsed} мин
🎯 Фокус-сессия в процессе

*Готовы продолжить?*
          `, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '▶️ Продолжить',
                                    callback_data: 'resume_pomodoro',
                                },
                                {
                                    text: '⏹️ Завершить',
                                    callback_data: 'stop_pomodoro',
                                },
                            ],
                            [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                            [{ text: '🏠 Главное меню', callback_data: 'start' }],
                        ],
                    },
                });
            }
            else {
                await ctx.editMessageTextWithMarkdown(`⚠️ *Нет активной сессии*

У вас нет активной сессии для паузы.`, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '🚀 Начать сессию',
                                    callback_data: 'start_pomodoro_session',
                                },
                            ],
                            [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                            [{ text: '🏠 Главное меню', callback_data: 'start' }],
                        ],
                    },
                });
            }
        });
        this.bot.action('resume_pomodoro', async (ctx) => {
            await ctx.answerCbQuery();
            const session = this.activePomodoroSessions.get(ctx.userId);
            if (session) {
                if (session.pausedAt) {
                    const pauseDuration = new Date().getTime() - session.pausedAt.getTime();
                    session.totalPausedTime =
                        (session.totalPausedTime || 0) + pauseDuration;
                    session.pausedAt = undefined;
                }
                const totalElapsed = new Date().getTime() -
                    session.startTime.getTime() -
                    (session.totalPausedTime || 0);
                const elapsed = Math.floor(totalElapsed / (1000 * 60));
                const remaining = Math.max(0, 25 - elapsed);
                const remainingMinutes = remaining;
                const remainingSeconds = Math.max(0, Math.floor((25 * 60 * 1000 - totalElapsed) / 1000) % 60);
                if (session.focusTimer) {
                    clearTimeout(session.focusTimer);
                }
                const remainingMs = Math.max(0, 25 * 60 * 1000 - totalElapsed);
                if (remainingMs > 0) {
                    session.focusTimer = setTimeout(async () => {
                        try {
                            const currentSession = this.activePomodoroSessions.get(ctx.userId);
                            if (currentSession) {
                                await ctx.telegram.sendMessage(ctx.userId, `
🔔 *Время фокус-сессии истекло!*

⏰ 25 минут прошли
🎉 Поздравляем с завершением сессии!

*Что дальше?*

✅ Время для 5-минутного перерыва
🍅 Или начать новую сессию
                  `, {
                                    parse_mode: 'Markdown',
                                    reply_markup: {
                                        inline_keyboard: [
                                            [
                                                {
                                                    text: '☕ Перерыв (5 мин)',
                                                    callback_data: 'start_pomodoro_break',
                                                },
                                            ],
                                            [
                                                {
                                                    text: '🍅 Новая сессия',
                                                    callback_data: 'start_pomodoro_session',
                                                },
                                                {
                                                    text: '📊 История',
                                                    callback_data: 'pomodoro_history',
                                                },
                                            ],
                                            [
                                                {
                                                    text: '🏠 Главное меню',
                                                    callback_data: 'start',
                                                },
                                            ],
                                        ],
                                    },
                                });
                                this.activePomodoroSessions.delete(ctx.userId);
                            }
                        }
                        catch (error) {
                            console.log('Failed to send pomodoro completion message:', error);
                        }
                    }, remainingMs);
                }
                await ctx.editMessageTextWithMarkdown(`▶️ *Сессия возобновлена*

⏰ Продолжаем с ${remainingMinutes}:${remainingSeconds.toString().padStart(2, '0')}
🎯 Фокусируемся на задаче!`, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '⏸️ Пауза',
                                    callback_data: 'pause_pomodoro',
                                },
                                {
                                    text: '⏹️ Стоп',
                                    callback_data: 'stop_pomodoro',
                                },
                            ],
                            [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                            [{ text: '🏠 Главное меню', callback_data: 'start' }],
                        ],
                    },
                });
            }
        });
        this.bot.action('stop_pomodoro', async (ctx) => {
            await ctx.answerCbQuery();
            const session = this.activePomodoroSessions.get(ctx.userId);
            if (session) {
                if (session.focusTimer)
                    clearTimeout(session.focusTimer);
                if (session.breakTimer)
                    clearTimeout(session.breakTimer);
                const elapsed = Math.floor((new Date().getTime() - session.startTime.getTime()) / (1000 * 60));
                const elapsedMinutes = elapsed % 60;
                const elapsedHours = Math.floor(elapsed / 60);
                const timeText = elapsedHours > 0
                    ? `${elapsedHours}:${elapsedMinutes.toString().padStart(2, '0')}`
                    : `${elapsedMinutes}:${(((new Date().getTime() - session.startTime.getTime()) % 60000) / 1000).toFixed(0).padStart(2, '0')}`;
                this.activePomodoroSessions.delete(ctx.userId);
                await ctx.editMessageTextWithMarkdown(`
⏹️ *Сессия остановлена*

⏰ Время работы: ${timeText} из 25:00
📝 Хотите записать, что успели сделать?

*Следующие действия:*
          `, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '📝 Записать прогресс',
                                    callback_data: 'log_pomodoro_progress',
                                },
                            ],
                            [
                                {
                                    text: '🍅 Новая сессия',
                                    callback_data: 'start_pomodoro_session',
                                },
                                {
                                    text: '📊 Статистика',
                                    callback_data: 'pomodoro_history',
                                },
                            ],
                            [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                            [{ text: '🏠 Главное меню', callback_data: 'start' }],
                        ],
                    },
                });
            }
            else {
                await ctx.editMessageTextWithMarkdown(`
⚠️ *Нет активной сессии*

У вас нет активной сессии фокуса для остановки.

*Хотите начать новую?*
          `, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '🚀 Начать сессию',
                                    callback_data: 'start_pomodoro_session',
                                },
                            ],
                            [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                            [{ text: '🏠 Главное меню', callback_data: 'start' }],
                        ],
                    },
                });
            }
        });
        this.bot.action('pomodoro_history', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
📊 *История фокус-сессий*

**Сегодня (19.08.2025):**
🍅 Сессий: 0
⏰ Общее время: 0 мин
🎯 Задач завершено: 0

**На этой неделе:**
📅 Всего сессий: 0
📈 Среднее в день: 0
🏆 Лучший день: 0 сессий

**Общая статистика:**
🎯 Всего сессий: 0
⚡ Общее время фокуса: 0 ч
📚 Самая продуктивная неделя: 0 сессий

*Функция в разработке - данные будут сохраняться!*
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '📈 График прогресса',
                                callback_data: 'pomodoro_chart',
                            },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                        [{ text: '🏠 Главное меню', callback_data: 'start' }],
                    ],
                },
            });
        });
        this.bot.action('pomodoro_settings', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
⚙️ *Настройки Помодоро*

**Текущие настройки:**
⏱️ Время фокуса: 25 мин
☕ Короткий перерыв: 5 мин
🏖️ Длинный перерыв: 15 мин
🔢 Сессий до длинного перерыва: 4

**Уведомления:**
🔔 Звуковые сигналы: ✅
📱 Push-уведомления: ✅
⏰ Напоминания о перерывах: ✅

**Дополнительно:**
🎵 Фоновые звуки: ❌
📊 Автосохранение статистики: ✅
🎯 Выбор задачи перед сессией: ❌

*Функция настроек в разработке!*
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '⏱️ Изменить время',
                                callback_data: 'change_pomodoro_time',
                            },
                        ],
                        [
                            {
                                text: '🔔 Уведомления',
                                callback_data: 'pomodoro_notifications',
                            },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                        [{ text: '🏠 Главное меню', callback_data: 'start' }],
                    ],
                },
            });
        });
        this.bot.action('log_pomodoro_progress', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
📝 *Записать прогресс*

⏰ Время работы: 9:30 из 25:00
📊 Эффективность: 38%

*Что вы успели сделать?*
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '📚 Изучение',
                                callback_data: 'progress_studying',
                            },
                            {
                                text: '💻 Работа',
                                callback_data: 'progress_work',
                            },
                        ],
                        [
                            {
                                text: '📝 Написание',
                                callback_data: 'progress_writing',
                            },
                            {
                                text: '🎨 Творчество',
                                callback_data: 'progress_creative',
                            },
                        ],
                        [
                            {
                                text: '✏️ Другое',
                                callback_data: 'progress_custom',
                            },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                        [{ text: '🏠 Главное меню', callback_data: 'start' }],
                    ],
                },
            });
        });
        this.bot.action('pomodoro_chart', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`📈 *График прогресса*

🚧 *Функция в разработке*

Здесь будет отображаться:
📊 График фокус-сессий по дням
📈 Динамика продуктивности
🎯 Статистика по типам задач
⏰ Лучшие часы для фокуса

📧 Включите уведомления в настройках, чтобы не пропустить запуск!`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'pomodoro_history' }],
                        [{ text: '🏠 Главное меню', callback_data: 'start' }],
                    ],
                },
            });
        });
        this.bot.action('change_pomodoro_time', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
⏱️ *Настройка времени*

**Выберите время фокуса:**
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '15 мин', callback_data: 'set_focus_15' },
                            { text: '25 мин ✅', callback_data: 'set_focus_25' },
                            { text: '30 мин', callback_data: 'set_focus_30' },
                        ],
                        [
                            { text: '45 мин', callback_data: 'set_focus_45' },
                            { text: '60 мин', callback_data: 'set_focus_60' },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'pomodoro_settings' }],
                        [{ text: '🏠 Главное меню', callback_data: 'start' }],
                    ],
                },
            });
        });
        this.bot.action('pomodoro_notifications', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
🔔 *Настройки уведомлений*

**Текущие настройки:**
🔊 Звуковые сигналы: ✅
📱 Push-уведомления: ✅
⏰ Напоминания о перерывах: ✅
🎵 Фоновая музыка: ❌

*Функция в разработке!*
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'pomodoro_settings' }],
                        [{ text: '🏠 Главное меню', callback_data: 'start' }],
                    ],
                },
            });
        });
        this.bot.action('focus_ai_tips', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showFocusAITips(ctx);
        });
        ['studying', 'work', 'writing', 'creative', 'custom'].forEach((category) => {
            this.bot.action(`progress_${category}`, async (ctx) => {
                await ctx.answerCbQuery();
                await ctx.editMessageTextWithMarkdown(`
✅ *Прогресс сохранен!*

📊 Категория: ${category === 'studying'
                    ? 'Изучение'
                    : category === 'work'
                        ? 'Работа'
                        : category === 'writing'
                            ? 'Написание'
                            : category === 'creative'
                                ? 'Творчество'
                                : 'Другое'}
⏰ Время работы: 9:30

🎯 +10 XP за фокус-сессию!
📈 Ваш прогресс учтен в статистике.
          `);
            });
        });
        [15, 25, 30, 45, 60].forEach((minutes) => {
            this.bot.action(`set_focus_${minutes}`, async (ctx) => {
                await ctx.answerCbQuery();
                await ctx.editMessageTextWithMarkdown(`
⏱️ *Время фокуса изменено*

Новое время фокуса: ${minutes} минут
Время перерыва: ${minutes <= 25 ? 5 : 10} минут

✅ Настройки сохранены!
        `, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '⬅️ К настройкам',
                                    callback_data: 'pomodoro_settings',
                                },
                                {
                                    text: '🍅 К Pomodoro',
                                    callback_data: 'pomodoro_focus',
                                },
                            ],
                            [
                                {
                                    text: '🏠 Главное меню',
                                    callback_data: 'start',
                                },
                            ],
                        ],
                    },
                });
            });
        });
        ['excellent', 'good', 'neutral', 'sad', 'angry', 'anxious'].forEach((mood) => {
            this.bot.action(`mood_${mood}`, async (ctx) => {
                await ctx.answerCbQuery();
                const moodEmoji = {
                    excellent: '😄',
                    good: '😊',
                    neutral: '😐',
                    sad: '😔',
                    angry: '😤',
                    anxious: '😰',
                }[mood];
                const moodText = {
                    excellent: 'отличное',
                    good: 'хорошее',
                    neutral: 'нормальное',
                    sad: 'грустное',
                    angry: 'злое',
                    anxious: 'тревожное',
                }[mood];
                await ctx.editMessageTextWithMarkdown(`
${moodEmoji} *Настроение записано!*

Ваше настроение: **${moodText}**
📅 Дата: ${new Date().toLocaleDateString('ru-RU')}

📊 Статистика настроения будет доступна в следующем обновлении!

*Спасибо за то, что делитесь своим настроением. Это поможет лучше понимать ваше эмоциональное состояние.*
        `, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '📈 Посмотреть статистику',
                                    callback_data: 'mood_stats',
                                },
                            ],
                            [
                                {
                                    text: '🏠 Главное меню',
                                    callback_data: 'back_to_menu',
                                },
                            ],
                        ],
                    },
                });
            });
        });
        this.bot.action('mood_ai_analysis', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showMoodAIAnalysis(ctx);
        });
        this.bot.action('mood_stats', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
📊 *Статистика настроения*

**Сегодня:** 😊 (хорошее)
**За неделю:** Средняя оценка 7/10
**За месяц:** Средняя оценка 6.5/10

**Самые частые настроения:**
😊 Хорошее - 45%
😐 Нормальное - 30% 
😄 Отличное - 25%

📈 *Функция подробной статистики в разработке!*
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад к настроению', callback_data: 'menu_mood' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('faq_support', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
❓ *FAQ — ЧАСТО ЗАДАВАЕМЫЕ ВОПРОСЫ*

1. **Как добавить новую задачу?**
Просто нажмите на кнопку «Создать задачу/привычку» или напиши в чат: «Напомнить завтра в 17:00 зайти на почту» и бот автоматически создаст Вам эту задачу.

2. **Что такое XP и уровень?**
XP (опыт) начисляется за выполнение задач. С каждым уровнем открываются новые челленджи и бонусы.

3. **Что значит «отправить голосовое сообщение»?**
Бот умеет распознавать голосовые сообщения и автоматически выполняет задачу которую Вы записали (создает задачу/напоминание/привычку).

4. **Что значит функция ИИ – Помощник?**
Искусственный интеллект анализирует все ваши задачи, привычки, зависимости и дает рекомендации по достижению результата. Представьте что это личный тренер, психолог, наставник, коллега и друг в одном лице.

5. **Как отключить/настроить напоминания?**
В меню "⚙️ Настройки" можно включить, отключить или изменить время напоминаний.

6. **Кто видит мои задачи?**
Ваши задачи видите только вы. Можно делиться отдельными результатами по желанию.

7. **Как работает челлендж?**
Это тематические задания на время — за участие начисляются дополнительные XP и достижения.

8. **Что делать, если бот не отвечает?**
Попробуйте перезапустить Telegram. Если не поможет напишите в "FAQ / Поддержка".

9. **Как связаться с поддержкой?**
В конце любого раздела FAQ есть кнопка "📝 Задать вопрос".

10. **Как быстро перейти к любимой функции?**
Введите "/" — появится быстрый список всех команд и функций.

11. **Как работает реферальная система?**
Вы просто копируете ссылку в меню «Реферальная программа» и отправляете другу. С того кто зарегистрируется по ней и подключит подписку Вы будете ежемесячно получать по 40% с его оплат!

12. **Как работает система бесплатной подписки навсегда при добавлении 5 друзей к боту?**
Вы отправляете ссылку на регистрацию в нашем боте и когда Вы наберете 5 регистраций Вам автоматически придет уведомление о том, что Вы получили бесплатную премиум версию навсегда!

*Если не нашли ответа — напишите нам!*
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📝 Задать вопрос', callback_data: 'ask_question' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('ask_question', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
📝 *Задать вопрос поддержке*

Пожалуйста, опишите ваш вопрос или проблему в следующем сообщении, и наша команда поддержки свяжется с вами в ближайшее время.

Можете также написать команду /feedback для отправки обратной связи.
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Назад к FAQ', callback_data: 'faq_support' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action('add_habit_direct', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown('🔄 *Добавление привычек* - функция в разработке');
        });
        this.bot.action('back_to_menu', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showMainMenu(ctx, true);
        });
        this.bot.action('start', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showMainMenu(ctx, true);
        });
        this.bot.action('back_to_commands', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showMainMenu(ctx, true);
        });
        this.bot.action('commands_menu', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showMainMenu(ctx, true);
        });
        this.bot.action(/^create_task_from_voice:(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const taskName = ctx.match[1];
            await this.createTaskFromVoice(ctx, taskName);
        });
        this.bot.action(/^create_habit_from_voice:(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const habitName = ctx.match[1];
            await this.createHabitFromVoice(ctx, habitName);
        });
        this.bot.action(/^create_reminder_from_voice:(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const reminderText = decodeURIComponent(ctx.match[1]);
            await ctx.editMessageTextWithMarkdown(`⏰ *Создание напоминания из голоса*

Текст: "${reminderText}"

💡 **Как указать время:**
Отправьте сообщение с временем, например:
• "${reminderText} в 17:30"
• "${reminderText} через 2 часа"
• "${reminderText} завтра в 14:00"

Или выберите удобное время:`, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '📝 Написать время',
                                callback_data: 'create_reminder_help',
                            },
                            { text: '� Голосом', callback_data: 'voice_reminder_help' },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action(/^ai_chat_from_voice:(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const text = ctx.match[1];
            await this.handleAIChatMessage(ctx, text);
        });
        this.bot.action('ai_analyze_profile', async (ctx) => {
            await this.handleAIAnalyzeProfile(ctx);
        });
        this.bot.action('ai_task_recommendations', async (ctx) => {
            await this.handleAITaskRecommendations(ctx);
        });
        this.bot.action('ai_time_planning', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
⏰ *Планирование времени*

Функция в разработке! Здесь будут рекомендации по эффективному планированию времени.
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                    ],
                },
            });
        });
        this.bot.action('ai_custom_question', async (ctx) => {
            await this.handleAICustomQuestion(ctx);
        });
        this.bot.action('ai_back_menu', async (ctx) => {
            await ctx.answerCbQuery();
            await this.startAIChat(ctx);
        });
        this.bot.action('ai_analyze_profile', async (ctx) => {
            await ctx.answerCbQuery();
            await this.handleAIAnalyzeProfile(ctx);
        });
        this.bot.action('ai_task_recommendations', async (ctx) => {
            await ctx.answerCbQuery();
            await this.handleAITaskRecommendations(ctx);
        });
        this.bot.action('ai_habit_help', async (ctx) => {
            await ctx.answerCbQuery();
            await this.handleAIHabitHelp(ctx);
        });
        this.bot.action('ai_time_planning', async (ctx) => {
            await ctx.answerCbQuery();
            await this.handleAITimePlanning(ctx);
        });
        this.bot.action('ai_custom_question', async (ctx) => {
            await ctx.answerCbQuery();
            await this.handleAICustomQuestion(ctx);
        });
        this.bot.action('ai_create_habit', async (ctx) => {
            await ctx.answerCbQuery();
            await this.handleAICreateHabit(ctx);
        });
        this.bot.action('tasks_add', async (ctx) => {
            await ctx.answerCbQuery();
            await this.startAddingTask(ctx);
        });
        this.bot.action('tasks_list', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showTasksList(ctx);
        });
        this.bot.action('tasks_list_more', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showAllTasksList(ctx);
        });
        this.bot.action('tasks_today', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showTodayTasks(ctx);
        });
        this.bot.action('tasks_ai_advice', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showTasksAIAdvice(ctx);
        });
        this.bot.action(/^task_complete_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const taskId = ctx.match[1];
            await this.completeTask(ctx, taskId);
        });
        this.bot.action('back_to_tasks', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showTasksMenu(ctx);
        });
        this.bot.action('back_to_main', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showMainMenu(ctx);
        });
        this.bot.action(/^feedback_rating_(\d+)$/, async (ctx) => {
            const rating = parseInt(ctx.match[1]);
            await this.handleFeedbackRating(ctx, rating);
        });
        this.bot.action(/^feedback_like_(.+)$/, async (ctx) => {
            const feature = ctx.match[1];
            if (!ctx.session.feedbackRating) {
                await this.completeFeedbackSurvey(ctx, feature);
            }
            else {
                await this.handleFeedbackImprovement(ctx, feature);
            }
        });
        this.bot.action(/^feedback_improve_(.+)$/, async (ctx) => {
            const improvement = ctx.match[1];
            if (improvement === 'custom') {
                await ctx.answerCbQuery();
                await ctx.editMessageTextWithMarkdown(`
📝 *Напишите, что хотелось бы улучшить:*

Опишите ваши пожелания...
        `);
                ctx.session.step = 'waiting_for_custom_feedback';
            }
            else {
                if (ctx.session.feedbackRating) {
                    await this.completeFeedback(ctx, improvement);
                }
                else {
                    await this.completeFeedbackSurvey(ctx, improvement);
                }
            }
        });
        this.bot.action('feedback_later', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
🕐 *Хорошо, спросим позже!*

Вы всегда можете оставить отзыв командой /feedback
      `);
        });
        this.bot.action(/^confirm_timezone_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const timezone = ctx.match[1];
            await this.confirmTimezone(ctx, timezone);
        });
        this.bot.action('manual_timezone', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showManualTimezoneSelection(ctx);
        });
        this.bot.action('input_city', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
🏙️ *Ввод города*

📍 Напишите название вашего города:
(например: Москва, Санкт-Петербург, Нью-Йорк, Лондон, Астана)
      `);
            ctx.session.step = 'waiting_for_city';
        });
        this.bot.action('select_timezone', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showTimezoneList(ctx);
        });
        this.bot.action('stop_interval_reminder', async (ctx) => {
            await ctx.answerCbQuery();
            const stopped = this.stopIntervalReminder(ctx.userId);
            if (stopped) {
                await ctx.editMessageTextWithMarkdown(`
🛑 *Интервальное напоминание остановлено*

Интервальные напоминания больше не будут отправляться.
        `, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                        ],
                    },
                });
            }
            else {
                await ctx.editMessageTextWithMarkdown(`
❌ *Нет активных интервальных напоминаний*

У вас нет запущенных интервальных напоминаний.
        `, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                        ],
                    },
                });
            }
        });
        this.bot.action('interval_status', async (ctx) => {
            await ctx.answerCbQuery();
            const reminder = this.activeIntervalReminders.get(ctx.userId);
            if (reminder) {
                const runningTime = Math.floor((Date.now() - reminder.startTime.getTime()) / (1000 * 60));
                const intervalText = reminder.intervalMinutes < 60
                    ? `${reminder.intervalMinutes} минут`
                    : `${Math.floor(reminder.intervalMinutes / 60)} час${reminder.intervalMinutes === 60 ? '' : 'а'}`;
                await ctx.editMessageTextWithMarkdown(`
📊 *Статус интервального напоминания*

📝 **Текст:** ${reminder.reminderText}
⏱️ **Интервал:** каждые ${intervalText}
🕐 **Запущено:** ${runningTime} мин назад
📬 **Отправлено:** ${reminder.count} напоминаний

Напоминание работает и будет продолжать отправлять уведомления.
        `, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '🛑 Остановить',
                                    callback_data: 'stop_interval_reminder',
                                },
                            ],
                            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                        ],
                    },
                });
            }
            else {
                await ctx.editMessageTextWithMarkdown(`
❌ *Нет активных интервальных напоминаний*

У вас нет запущенных интервальных напоминаний.
        `, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                        ],
                    },
                });
            }
        });
        this.bot.action('cancel_interval_setup', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageTextWithMarkdown(`
❌ *Настройка отменена*

Новое интервальное напоминание не было создано.
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        });
        this.bot.action(/^replace_interval_(\d+)_(.+)$/, async (ctx) => {
            await ctx.answerCbQuery();
            const intervalMinutes = parseInt(ctx.match[1]);
            const reminderText = Buffer.from(ctx.match[2], 'base64').toString();
            this.stopIntervalReminder(ctx.userId);
            await this.startIntervalReminder(ctx, reminderText, intervalMinutes);
        });
        this.bot.catch((err, ctx) => {
            this.logger.error(`Bot error for ${ctx.updateType}:`, err);
            ctx.reply('🚫 Произошла ошибка. Попробуйте позже или обратитесь к администратору.');
        });
    }
    async handleAITaskRecommendations(ctx) {
        const user = await this.userService.findByTelegramId(ctx.userId);
        const tasks = await this.taskService.findTasksByUserId(ctx.userId);
        const completedTasks = tasks.filter((t) => t.completedAt !== null);
        let recommendation = '';
        if (tasks.length === 0) {
            recommendation =
                '📝 Создайте первую задачу! Начните с чего-то простого на сегодня.';
        }
        else if (completedTasks.length < tasks.length * 0.3) {
            recommendation =
                '🎯 Сфокусируйтесь на завершении текущих задач. Качество важнее количества!';
        }
        else {
            recommendation =
                '🚀 Отличная работа! Попробуйте технику Помодоро для повышения продуктивности.';
        }
        await ctx.editMessageTextWithMarkdown(`
💡 *Рекомендации по задачам*

📊 Статистика: ${completedTasks.length}/${tasks.length} задач выполнено

${recommendation}

*Совет:* Разбивайте большие задачи на маленькие шаги.
      `, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                    [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
            },
        });
    }
    async handleAIHabitHelp(ctx) {
        try {
            const user = await this.userService.findByTelegramId(ctx.userId);
            const habits = await this.habitService.findHabitsByUserId(ctx.userId);
            const completedHabits = habits.filter((h) => h.totalCompletions > 0);
            const userProfile = {
                totalHabits: habits.length,
                activeHabits: habits.filter((h) => h.isActive).length,
                completedHabits: completedHabits.length,
                avgStreak: habits.length > 0
                    ? habits.reduce((sum, h) => sum + h.currentStreak, 0) /
                        habits.length
                    : 0,
            };
            let personalizedRecommendations = [];
            let motivationalMessage = '';
            if (habits.length === 0) {
                personalizedRecommendations = [
                    '💧 Начните с простого: пить 1 стакан воды утром',
                    '🚶‍♂️ 5-минутная прогулка после еды',
                    '📚 Читать 1 страницу книги перед сном',
                    '🧘‍♀️ 2-минутная медитация утром',
                ];
                motivationalMessage =
                    'Отличное время для начала! Выберите одну простую привычку.';
            }
            else if (userProfile.avgStreak < 3) {
                personalizedRecommendations = [
                    '🎯 Сосредоточьтесь на одной привычке до автоматизма',
                    '⏰ Привяжите привычку к существующему действию',
                    '🏆 Отмечайте каждый день в календаре',
                    '📱 Используйте напоминания в одно и то же время',
                ];
                motivationalMessage =
                    'Главное - постоянство! Лучше делать мало, но каждый день.';
            }
            else {
                personalizedRecommendations = [
                    '📈 Усложните существующие привычки постепенно',
                    '🔗 Свяжите привычки в цепочки (habit stacking)',
                    '🎉 Добавьте систему наград за достижения',
                    '📊 Отслеживайте прогресс еженедельно',
                ];
                motivationalMessage =
                    'У вас отличная дисциплина! Время масштабировать успех.';
            }
            let message = `🎯 *Персональные рекомендации по привычкам*\n\n`;
            if (habits.length > 0) {
                message += `📊 *Ваш профиль:*\n`;
                message += `• Привычек: ${userProfile.totalHabits} (активных: ${userProfile.activeHabits})\n`;
                message += `• Средняя серия: ${Math.round(userProfile.avgStreak)} дней\n`;
                message += `• Выполняемых: ${completedHabits.length}\n\n`;
            }
            message += `💡 *${motivationalMessage}*\n\n`;
            message += `🎯 *Рекомендации для вас:*\n`;
            personalizedRecommendations.forEach((rec, index) => {
                message += `${index + 1}. ${rec}\n`;
            });
            message += `\n🧠 *Научно доказанные советы:*\n`;
            message += `• 21 день для простых привычек, 66 дней для сложных\n`;
            message += `• Начинайте с 2-минутного правила\n`;
            message += `• Используйте правило "никогда не пропускайте дважды"\n`;
            message += `• Фокус на процессе, а не на результате`;
            const keyboard = {
                inline_keyboard: [
                    [
                        {
                            text: '📝 Создать привычку',
                            callback_data: 'habits_add',
                        },
                        {
                            text: '🎯 Мои привычки',
                            callback_data: 'habits_list',
                        },
                    ],
                    [
                        {
                            text: '🤖 Создать ИИ-привычку',
                            callback_data: 'ai_create_habit',
                        },
                    ],
                    [
                        {
                            text: '⬅️ Назад к ИИ меню',
                            callback_data: 'ai_back_menu',
                        },
                    ],
                ],
            };
            await ctx.editMessageTextWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        catch (error) {
            this.logger.error('Error in handleAIHabitHelp:', error);
            await ctx.editMessageTextWithMarkdown('❌ Ошибка при анализе привычек. Попробуйте позже.', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                    ],
                },
            });
        }
    }
    async handleAICreateHabit(ctx) {
        await ctx.editMessageTextWithMarkdown(`
🤖 *Создание привычки с помощью ИИ*

Опишите, какую привычку хотите сформировать, и я помогу:
• 📝 Сформулировать её правильно
• ⏰ Подобрать оптимальное время
• 🎯 Разработать план внедрения
• 💡 Дать персональные советы

*Примеры:*
"Хочу больше читать"
"Нужно пить больше воды" 
"Хочу делать зарядку"
"Буду медитировать"

💬 Просто напишите своими словами!
      `, {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '⬅️ Назад к помощи с привычками',
                            callback_data: 'ai_habit_help',
                        },
                    ],
                    [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
            },
        });
        ctx.session.aiHabitCreationMode = true;
    }
    async handleAIHabitCreationMessage(ctx, userInput) {
        try {
            ctx.session.aiHabitCreationMode = false;
            const analysisPrompt = `Пользователь хочет создать привычку: "${userInput}"

Проанализируй запрос и создай структурированный ответ:

1. Конкретная привычка (максимум 50 символов)
2. Рекомендуемое время для выполнения
3. Частота (ежедневно, еженедельно и т.д.)
4. Советы по внедрению (2-3 коротких совета)
5. Мотивирующее сообщение

Отвечай на русском языке в дружественном тоне.`;
            const aiResponse = await this.openaiService.getAIResponse(analysisPrompt);
            const habitData = this.parseAIHabitResponse(aiResponse, userInput);
            const habit = await this.habitService.createHabit({
                userId: ctx.userId,
                title: habitData.title,
                description: habitData.description,
                frequency: 'DAILY',
                reminderTime: habitData.reminderTime,
            });
            let message = `🎉 *Привычка создана с помощью ИИ!*\n\n`;
            message += `📝 **${habit.title}**\n\n`;
            if (habitData.aiAdvice) {
                message += `🤖 *Совет от ИИ:*\n${habitData.aiAdvice}\n\n`;
            }
            if (habitData.implementationTips.length > 0) {
                message += `💡 *Советы по внедрению:*\n`;
                habitData.implementationTips.forEach((tip, index) => {
                    message += `${index + 1}. ${tip}\n`;
                });
                message += `\n`;
            }
            message += `✨ *${habitData.motivationalMessage}*`;
            const keyboard = {
                inline_keyboard: [
                    [
                        {
                            text: '⏰ Настроить напоминание',
                            callback_data: `habit_set_reminder_${habit.id}`,
                        },
                    ],
                    [
                        {
                            text: '🎯 Мои привычки',
                            callback_data: 'habits_list',
                        },
                        {
                            text: '🤖 Создать ещё',
                            callback_data: 'ai_create_habit',
                        },
                    ],
                    [
                        {
                            text: '🏠 Главное меню',
                            callback_data: 'back_to_menu',
                        },
                    ],
                ],
            };
            await ctx.replyWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        catch (error) {
            this.logger.error('Error in handleAIHabitCreationMessage:', error);
            ctx.session.aiHabitCreationMode = false;
            await ctx.replyWithMarkdown('❌ Не удалось создать привычку с помощью ИИ. Попробуйте позже или создайте привычку вручную.', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📝 Создать вручную', callback_data: 'habits_add' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        }
    }
    parseAIHabitResponse(aiResponse, originalInput) {
        const defaultHabit = {
            title: originalInput.length > 50
                ? originalInput.substring(0, 50)
                : originalInput,
            description: `Привычка, созданная с помощью ИИ: ${originalInput}`,
            reminderTime: '09:00',
            implementationTips: [
                'Начните с малого',
                'Будьте постоянны',
                'Отмечайте прогресс',
            ],
            aiAdvice: aiResponse.length > 200
                ? aiResponse.substring(0, 200) + '...'
                : aiResponse,
            motivationalMessage: 'Вы на правильном пути к лучшей версии себя!',
        };
        try {
            const lines = aiResponse.split('\n').filter((line) => line.trim());
            for (const line of lines) {
                if (line.toLowerCase().includes('привычка') && line.includes(':')) {
                    const habitTitle = line.split(':')[1]?.trim();
                    if (habitTitle && habitTitle.length <= 50) {
                        defaultHabit.title = habitTitle;
                    }
                }
                if (line.toLowerCase().includes('время') && line.includes(':')) {
                    const timeMatch = line.match(/\d{1,2}:\d{2}/);
                    if (timeMatch) {
                        defaultHabit.reminderTime = timeMatch[0];
                    }
                }
            }
            return defaultHabit;
        }
        catch (error) {
            this.logger.warn('Failed to parse AI response, using defaults:', error);
            return defaultHabit;
        }
    }
    async handleAITimePlanning(ctx) {
        const user = await this.userService.findByTelegramId(ctx.userId);
        const currentHour = new Date().getHours();
        let timeAdvice = '';
        if (currentHour < 9) {
            timeAdvice =
                '🌅 Утром лучше планировать самые важные дела. Мозг работает эффективнее!';
        }
        else if (currentHour < 14) {
            timeAdvice =
                '☀️ Пик продуктивности! Время для сложных задач и важных решений.';
        }
        else if (currentHour < 18) {
            timeAdvice =
                '🕐 После обеда энергия снижается. Подходящее время для рутинных дел.';
        }
        else {
            timeAdvice =
                '🌆 Вечер - время для планирования завтрашнего дня и легких задач.';
        }
        await ctx.editMessageTextWithMarkdown(`
⏰ *Планирование времени*

🕐 Сейчас ${currentHour}:00

${timeAdvice}

*Методы:*
• 🍅 Помодоро (25 мин работа / 5 мин отдых)
• ⏰ Блокировка времени 
• 🎯 Правило 3-х приоритетов
      `, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                    [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
            },
        });
    }
    async handleAICustomQuestion(ctx) {
        await ctx.editMessageTextWithMarkdown(`
✍️ *Задайте свой вопрос*

Напишите вопрос о:
• Управлении задачами
• Формировании привычек  
• Планировании времени
• Мотивации и целях
• Продуктивности

Я отвечу кратко и по делу!
      `, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                    [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
            },
        });
        ctx.session.aiChatMode = true;
    }
    async handleReferralRegistration(ctx, newUserId, referrerId) {
        try {
            if (newUserId === referrerId) {
                return;
            }
            const referrer = await this.userService
                .findByTelegramId(referrerId)
                .catch(() => null);
            if (!referrer) {
                this.logger.warn(`Referrer ${referrerId} not found`);
                return;
            }
            await this.userService.updateUser(newUserId, {
                referredBy: referrer.id,
            });
            const currentReferralsCount = await this.getReferralsCount(referrerId);
            await this.userService.updateUser(referrerId, {
                referralsCount: currentReferralsCount + 1,
                activeReferrals: currentReferralsCount + 1,
            });
            const referrerUser = await this.userService.findByTelegramId(referrerId);
            let bonusXp = 500;
            const newReferralsCount = currentReferralsCount + 1;
            let achievementMessage = '';
            let achievementType = null;
            if (newReferralsCount === 1) {
                bonusXp += 200;
                achievementMessage =
                    '\n🏆 Достижение "Первый друг" разблокировано! (+200 XP)';
                achievementType = 'first';
            }
            else if (newReferralsCount === 3) {
                bonusXp += 500;
                achievementMessage =
                    '\n🏆 Достижение "Тройка друзей" разблокировано! (+500 XP)';
                achievementType = 'triple';
            }
            else if (newReferralsCount === 5) {
                bonusXp += 1000;
                achievementMessage =
                    '\n🏆 Достижение "Пятерка друзей" разблокировано! (+1000 XP)';
                achievementType = 'five';
            }
            await this.userService.updateUser(referrerId, {
                totalXp: referrerUser.totalXp + bonusXp,
            });
            const newUser = await this.userService.findByTelegramId(newUserId);
            await this.userService.updateUser(newUserId, {
                totalXp: newUser.totalXp + 200,
            });
            try {
                await this.bot.telegram.sendMessage(referrerId, `🎉 *Поздравляем!*

👤 Ваш друг присоединился к Ticky AI!

 **РЕФЕРАЛЬНАЯ СИСТЕМА АКТИВИРОВАНА:**
• Когда друг оплатит месячную подписку (199₽) → Вы получите 79₽
• Когда друг оплатит годовую подписку (999₽) → Вы получите 399₽
• Выплаты поступают мгновенно на ваш баланс!

👥 Всего друзей: ${newReferralsCount}/5${achievementMessage}

🎁 **XP бонусы:**
💰 Вы получили +${bonusXp} XP
✨ Друг получил +200 XP при регистрации

🔗 Поделитесь ссылкой с еще большим количеством друзей и зарабатывайте!`, { parse_mode: 'Markdown' });
                if (achievementType) {
                    setTimeout(async () => {
                        await this.sendReferralAchievementNotification(referrerId, achievementType, bonusXp);
                    }, 2000);
                }
            }
            catch (error) {
                this.logger.warn(`Could not send referral notification to ${referrerId}: ${error.message}`);
            }
            await ctx.replyWithMarkdown(`🎁 *Добро пожаловать!*\n\nВы присоединились по приглашению друга!\n⭐ Получили +200 XP бонус при регистрации\n\n🚀 Давайте начнем знакомство с ботом!`);
            this.logger.log(`Referral registration: ${newUserId} invited by ${referrerId}`);
        }
        catch (error) {
            this.logger.error('Error handling referral registration:', error);
        }
    }
    async sendReferralAchievementNotification(userId, achievement, bonusXp) {
        try {
            let message = '';
            let emoji = '';
            switch (achievement) {
                case 'first':
                    emoji = '🥉';
                    message = `${emoji} *ДОСТИЖЕНИЕ РАЗБЛОКИРОВАНО!*

🎉 **"Первый друг"**
Вы пригласили своего первого друга!

💰 **Получено:** +${bonusXp} XP
🎯 **Следующая цель:** Пригласить 3 друзей`;
                    break;
                case 'triple':
                    emoji = '🥈';
                    message = `${emoji} *ДОСТИЖЕНИЕ РАЗБЛОКИРОВАНО!*

🎉 **"Тройка друзей"**
У вас уже 3 приглашенных друга!

💰 **Получено:** +${bonusXp} XP
🎯 **Следующая цель:** Пригласить 5 друзей`;
                    break;
                case 'five':
                    emoji = '🥇';
                    message = `${emoji} *МАКСИМАЛЬНОЕ ДОСТИЖЕНИЕ!*

🎉 **"Пятерка друзей"**
Вы достигли максимума - 5 друзей!

💰 **Получено:** +${bonusXp} XP
🏆 **Статус:** Мастер рефералов
👑 **Бонус:** Все достижения разблокированы!`;
                    break;
            }
            await this.bot.telegram.sendMessage(userId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '📊 Моя статистика',
                                callback_data: 'referral_stats',
                            },
                            {
                                text: '🔗 Поделиться ссылкой',
                                callback_data: 'copy_referral_link',
                            },
                        ],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.warn(`Could not send achievement notification to ${userId}:`, error);
        }
    }
    async updateUserActivity(userId) {
        try {
            await this.userService.updateUser(userId, {
                lastActivity: new Date(),
            });
        }
        catch (error) {
            this.logger.debug(`Could not update activity for ${userId}:`, error);
        }
    }
    async getReferralsCount(userId) {
        try {
            const user = await this.userService.findByTelegramId(userId);
            const referralsCount = await this.prisma.user.count({
                where: {
                    referredBy: user.id,
                },
            });
            return referralsCount;
        }
        catch (error) {
            this.logger.error(`Error getting referrals count for ${userId}:`, error);
            return 0;
        }
    }
    async getReferralStats(userId) {
        try {
            const user = await this.userService.findByTelegramId(userId);
            const referrals = await this.prisma.user.findMany({
                where: {
                    referredBy: user.id,
                },
                select: {
                    firstName: true,
                    lastName: true,
                    username: true,
                    createdAt: true,
                    lastActivity: true,
                },
                orderBy: {
                    createdAt: 'desc',
                },
            });
            const weekAgo = new Date();
            weekAgo.setDate(weekAgo.getDate() - 7);
            const activeReferrals = referrals.filter((ref) => ref.lastActivity && ref.lastActivity > weekAgo).length;
            const totalReferrals = referrals.length;
            let totalBonus = totalReferrals * 500;
            if (totalReferrals >= 1)
                totalBonus += 200;
            if (totalReferrals >= 3)
                totalBonus += 500;
            if (totalReferrals >= 5)
                totalBonus += 1000;
            const userData = await this.prisma.user.findUnique({
                where: { id: user.id },
                select: { referralBalance: true },
            });
            const topReferrals = referrals.slice(0, 5).map((ref) => ({
                name: ref.firstName || ref.username || 'Пользователь',
                joinDate: ref.createdAt.toLocaleDateString('ru-RU'),
                isActive: !!(ref.lastActivity && ref.lastActivity > weekAgo),
            }));
            return {
                totalReferrals,
                activeReferrals,
                totalBonus,
                referralBalance: userData?.referralBalance || 0,
                topReferrals,
            };
        }
        catch (error) {
            this.logger.error(`Error getting referral stats for ${userId}:`, error);
            return {
                totalReferrals: 0,
                activeReferrals: 0,
                totalBonus: 0,
                referralBalance: 0,
                topReferrals: [],
            };
        }
    }
    async onModuleInit() {
        this.launch().catch((error) => {
            this.logger.error('Failed to launch bot:', error);
        });
        this.startMotivationalMessagesService();
    }
    startMotivationalMessagesService() {
        setInterval(async () => {
            const currentHour = new Date().getHours();
            if (currentHour >= 8 && currentHour <= 22) {
                await this.sendMotivationalMessages();
            }
        }, 60 * 60 * 1000);
        this.logger.log('Motivational messages service started');
    }
    async sendMotivationalMessages() {
        try {
            this.logger.log('Motivational messages sent');
        }
        catch (error) {
            this.logger.error('Error sending motivational messages:', error);
        }
    }
    async onModuleDestroy() {
        await this.stop();
    }
    async startOnboarding(ctx) {
        await this.showOnboardingStep1(ctx);
    }
    async showOnboardingStep1(ctx) {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🚀 Начать', callback_data: 'onboarding_start' },
                    {
                        text: '👀 Посмотреть примеры',
                        callback_data: 'onboarding_examples',
                    },
                ],
            ],
        };
        await ctx.replyWithMarkdown(`🤖 *Привет! Я Ticky AI — твой AI-ассистент по привычкам и задачам с геймификацией.*`, { reply_markup: keyboard });
        ctx.session.step = 'onboarding_welcome';
    }
    async showOnboardingStep2(ctx) {
        const keyboard = {
            inline_keyboard: [
                [
                    {
                        text: '➕ Добавить привычку',
                        callback_data: 'onboarding_add_habit',
                    },
                    { text: '⏭️ Пропустить', callback_data: 'onboarding_skip_habit' },
                ],
            ],
        };
        await ctx.editMessageTextWithMarkdown(`
🚀 *Быстрый старт*

Давай добавим твою первую привычку!
Например: "Пить воду"

*Выбери действие:*
    `, { reply_markup: keyboard });
        ctx.session.step = 'onboarding_quick_start';
    }
    async showOnboardingStep3(ctx) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '✅ Понятно!', callback_data: 'onboarding_complete' }],
            ],
        };
        await ctx.replyWithMarkdown(`
📚 *Мини-FAQ*

*ЧТО УМЕЕТ БОТ?*

• Добавлять задачи и привычки
• Следить за прогрессом
• Вовлекать в челленджи
• Напоминать о важных делах

🎯 Готов начать продуктивный день?
    `, { reply_markup: keyboard });
        ctx.session.step = 'onboarding_faq';
    }
    async showMainMenu(ctx, shouldEdit = false) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '➕ Добавить задачу/привычку', callback_data: 'add_item' }],
                [{ text: '📋 Мои задачи и привычки', callback_data: 'my_items' }],
                [
                    { text: '🟢 Ещё функции', callback_data: 'more_functions' },
                    { text: '🧠 Чат с ИИ', callback_data: 'ai_chat' },
                ],
                [
                    { text: '📊 Лимиты', callback_data: 'show_limits' },
                    { text: '❓ Помощь', callback_data: 'faq_support' },
                    { text: '📊 Прогресс', callback_data: 'my_progress' },
                ],
            ],
        };
        const user = await this.getOrCreateUser(ctx);
        const trialInfo = await this.billingService.getTrialInfo(ctx.userId);
        const subscriptionStatus = await this.billingService.getSubscriptionStatus(ctx.userId);
        let statusText = '';
        if (trialInfo.isTrialActive) {
            statusText = `🎁 **Пробный период:** ${trialInfo.daysRemaining} дней осталось\n`;
        }
        else if (subscriptionStatus.type !== 'FREE') {
            statusText = `💎 **${subscriptionStatus.type === 'PREMIUM' ? 'Premium' : 'Premium Plus'}**\n`;
        }
        const message = `
👋 *Привет, ${this.userService.getDisplayName(user)}!*

${statusText}🤖 Я Ticky AI – твой личный AI помощник для управления задачами и привычками.
    `;
        if (shouldEdit) {
            await ctx.editMessageTextWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        else {
            await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
        }
        setTimeout(() => this.checkAndShowFeedbackRequest(ctx), 2000);
    }
    async launch() {
        try {
            await this.bot.telegram.setMyCommands([
                { command: 'start', description: '🎬 Начать работу с ботом' },
                { command: 'menu', description: '🏠 Главное меню' },
                { command: 'tasks', description: '📝 Мои задачи' },
                { command: 'habits', description: '🔄 Мои привычки' },
                { command: 'reminders', description: '⏰ Активные напоминания' },
                { command: 'mood', description: '😊 Дневник настроения' },
                { command: 'focus', description: '🍅 Режим фокуса' },
                { command: 'billing', description: '💎 Мои лимиты и подписка' },
                { command: 'feedback', description: '💬 Обратная связь' },
                { command: 'help', description: '🆘 Справка' },
            ]);
            this.bot
                .launch()
                .then(() => {
                this.logger.log('🚀 Telegram bot launched successfully');
            })
                .catch((error) => {
                this.logger.error('❌ Failed to launch Telegram bot:', error);
            });
            this.logger.log('🤖 Telegram bot launch initiated');
        }
        catch (error) {
            this.logger.error('❌ Error during bot initialization:', error);
            throw error;
        }
    }
    async stop() {
        for (const [userId, session] of this.activePomodoroSessions.entries()) {
            if (session.focusTimer)
                clearTimeout(session.focusTimer);
            if (session.breakTimer)
                clearTimeout(session.breakTimer);
        }
        this.activePomodoroSessions.clear();
        for (const [userId, reminder] of this.activeIntervalReminders.entries()) {
            clearInterval(reminder.intervalId);
            this.logger.log(`Stopped interval reminder for user ${userId}`);
        }
        this.activeIntervalReminders.clear();
        this.bot.stop('SIGINT');
        this.logger.log('🛑 Telegram bot stopped');
    }
    getBotInstance() {
        return this.bot;
    }
    async showTasksMenu(ctx) {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '➕ Добавить задачу', callback_data: 'tasks_add' },
                    { text: '📋 Все задачи', callback_data: 'tasks_list' },
                ],
                [{ text: '📅 Задачи на сегодня', callback_data: 'tasks_today' }],
                [{ text: '🤖 AI-совет по задачам', callback_data: 'tasks_ai_advice' }],
                [{ text: '🔙 Назад в меню', callback_data: 'back_to_main' }],
            ],
        };
        const message = `
📝 *Управление задачами*

Выберите действие:
    `;
        if (ctx.callbackQuery) {
            await ctx.editMessageTextWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        else {
            await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
        }
    }
    async startAddingTask(ctx) {
        const user = await this.userService.findByTelegramId(ctx.userId);
        if (!user.timezone) {
            ctx.session.pendingAction = 'adding_task';
            await this.askForTimezone(ctx);
            return;
        }
        const limitCheck = await this.billingService.checkUsageLimit(ctx.userId, 'dailyTasks');
        if (!limitCheck.allowed) {
            await ctx.replyWithMarkdown(limitCheck.message || '🚫 Превышен лимит задач', {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '💎 Обновиться до Premium',
                                callback_data: 'upgrade_premium',
                            },
                        ],
                        [{ text: '📊 Мои лимиты', callback_data: 'show_limits' }],
                        [{ text: '⬅️ Назад', callback_data: 'back_to_tasks' }],
                    ],
                },
            });
            return;
        }
        await ctx.replyWithMarkdown(`
➕ *Создание новой задачи*

📊 **Задач сегодня:** ${limitCheck.current}/${limitCheck.limit === -1 ? '∞' : limitCheck.limit}

📝 Напишите или скажите в голосовом сообщении название задачи:
    `);
        ctx.session.step = 'waiting_for_task_title';
    }
    async handleTaskCreation(ctx, taskTitle) {
        try {
            const task = await this.taskService.createTask({
                userId: ctx.userId,
                title: taskTitle.trim(),
                description: '',
                priority: 'MEDIUM',
            });
            await this.billingService.incrementUsage(ctx.userId, 'dailyTasks');
            const user = await this.userService.findByTelegramId(ctx.userId);
            await this.userService.updateUserStats(ctx.userId, {
                totalTasks: user.totalTasks + 1,
            });
            const usageInfo = await this.billingService.checkUsageLimit(ctx.userId, 'dailyTasks');
            await ctx.replyWithMarkdown(`
✅ *Задача создана!*

📝 *${task.title}*
⚡ XP за выполнение: ${task.xpReward}
📊 **Задач сегодня:** ${usageInfo.current}/${usageInfo.limit === -1 ? '∞' : usageInfo.limit}

Задача добавлена в ваш список!
      `);
            ctx.session.step = undefined;
            setTimeout(() => this.showTasksMenu(ctx), 1500);
        }
        catch (error) {
            this.logger.error('Error creating task:', error);
            await ctx.replyWithMarkdown(`
❌ *Ошибка при создании задачи*

Попробуйте еще раз или обратитесь к администратору.
      `);
            ctx.session.step = undefined;
        }
    }
    async showTasksList(ctx) {
        try {
            const tasks = await this.taskService.findTasksByUserId(ctx.userId);
            if (tasks.length === 0) {
                await ctx.editMessageTextWithMarkdown(`
📋 *Список задач пуст*

У вас пока нет задач. Добавьте первую задачу!
        `);
                return;
            }
            const pendingTasks = tasks.filter((task) => task.status === 'PENDING' || task.status === 'IN_PROGRESS');
            const completedTasks = tasks.filter((task) => task.status === 'COMPLETED');
            let message = `📋 *Ваши задачи:*\n\n`;
            message += `🔄 **Активных:** ${pendingTasks.length}\n`;
            message += `✅ **Выполненных:** ${completedTasks.length}\n\n`;
            message += `*Выберите задачу для завершения:*`;
            const keyboard = {
                inline_keyboard: [
                    ...pendingTasks.slice(0, 8).map((task) => [
                        {
                            text: `${this.getPriorityEmoji(task.priority)} ${task.title.substring(0, 30)}${task.title.length > 30 ? '...' : ''} (${task.xpReward} XP)`,
                            callback_data: `task_complete_${task.id}`,
                        },
                    ]),
                    ...(pendingTasks.length > 8
                        ? [
                            [
                                {
                                    text: `... и еще ${pendingTasks.length - 8} задач`,
                                    callback_data: 'tasks_list_more',
                                },
                            ],
                        ]
                        : []),
                    [{ text: '🔙 Назад к задачам', callback_data: 'back_to_tasks' }],
                ],
            };
            await ctx.editMessageTextWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        catch (error) {
            this.logger.error('Error showing tasks list:', error);
            await ctx.editMessageTextWithMarkdown('❌ Ошибка при получении списка задач');
        }
    }
    async showAllTasksList(ctx) {
        try {
            const tasks = await this.taskService.findTasksByUserId(ctx.userId);
            const pendingTasks = tasks.filter((task) => task.status === 'PENDING' || task.status === 'IN_PROGRESS');
            if (pendingTasks.length === 0) {
                await ctx.editMessageTextWithMarkdown(`
📋 *Все активные задачи*

У вас нет активных задач. Все выполнено! 🎉
        `);
                return;
            }
            let message = `📋 *Все активные задачи (${pendingTasks.length}):*\n\n`;
            message += `*Выберите задачу для завершения:*`;
            const keyboard = {
                inline_keyboard: [
                    ...pendingTasks.map((task) => [
                        {
                            text: `${this.getPriorityEmoji(task.priority)} ${task.title.substring(0, 35)}${task.title.length > 35 ? '...' : ''} (${task.xpReward} XP)`,
                            callback_data: `task_complete_${task.id}`,
                        },
                    ]),
                    [{ text: '🔙 Назад к задачам', callback_data: 'back_to_tasks' }],
                ],
            };
            await ctx.editMessageTextWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        catch (error) {
            this.logger.error('Error showing all tasks list:', error);
            await ctx.editMessageTextWithMarkdown('❌ Ошибка при получении списка задач');
        }
    }
    async showTodayTasks(ctx) {
        try {
            const tasks = await this.taskService.getTodayTasks(ctx.userId);
            if (tasks.length === 0) {
                await ctx.editMessageTextWithMarkdown(`
📅 *Задачи на сегодня*

На сегодня задач нет! 🎉
        `);
                return;
            }
            const pendingTasks = tasks.filter((task) => task.status !== 'COMPLETED');
            const completedTasks = tasks.filter((task) => task.status === 'COMPLETED');
            let message = `📅 *Задачи на сегодня:*\n\n`;
            message += `🔄 **К выполнению:** ${pendingTasks.length}\n`;
            message += `✅ **Выполнено:** ${completedTasks.length}\n\n`;
            message += `*Выберите задачу для завершения:*`;
            const keyboard = {
                inline_keyboard: [
                    ...pendingTasks.map((task) => [
                        {
                            text: `${this.getPriorityEmoji(task.priority)} ${task.title.substring(0, 30)}${task.title.length > 30 ? '...' : ''} (${task.xpReward} XP)`,
                            callback_data: `task_complete_${task.id}`,
                        },
                    ]),
                    [{ text: '🔙 Назад к задачам', callback_data: 'back_to_tasks' }],
                ],
            };
            await ctx.editMessageTextWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        catch (error) {
            this.logger.error('Error showing today tasks:', error);
            await ctx.editMessageTextWithMarkdown('❌ Ошибка при получении задач на сегодня');
        }
    }
    async completeTask(ctx, taskId) {
        try {
            const result = await this.taskService.completeTask(taskId, ctx.userId);
            const userBefore = await this.userService.findByTelegramId(ctx.userId);
            const newTotalXp = userBefore.totalXp + result.xpGained;
            await this.userService.updateUserStats(ctx.userId, {
                completedTasks: userBefore.completedTasks + 1,
                todayTasks: userBefore.todayTasks + 1,
                xpGained: result.xpGained,
            });
            const userAfter = await this.userService.findByTelegramId(ctx.userId);
            const leveledUp = userAfter.level > userBefore.level;
            let message = `
🎉 *Задача выполнена!*

✅ ${result.task.title}
🎯 Получено XP: +${result.xpGained}
`;
            if (leveledUp) {
                message += `
🎊 *ПОЗДРАВЛЯЕМ! НОВЫЙ УРОВЕНЬ!*
⭐ Уровень: ${userAfter.level} (было: ${userBefore.level})
🏆 Общий XP: ${userAfter.totalXp}
`;
            }
            else {
                const xpToNext = this.userService.getXpToNextLevel(userAfter);
                const progress = this.userService.getLevelProgressRatio(userAfter);
                const progressBar = this.createProgressBar(progress);
                message += `
📊 Прогресс до следующего уровня:
${progressBar} ${Math.round(progress * 100)}%
🎯 Осталось XP до уровня ${userAfter.level + 1}: ${xpToNext}
`;
            }
            message += '\nОтличная работа! 👏';
            await ctx.editMessageTextWithMarkdown(message);
            setTimeout(() => this.showTasksMenu(ctx), leveledUp ? 3000 : 2000);
        }
        catch (error) {
            this.logger.error('Error completing task:', error);
            if (error.message.includes('already completed')) {
                await ctx.editMessageTextWithMarkdown('ℹ️ Эта задача уже выполнена!');
            }
            else {
                await ctx.editMessageTextWithMarkdown('❌ Ошибка при выполнении задачи');
            }
        }
    }
    getPriorityEmoji(priority) {
        switch (priority) {
            case 'URGENT':
                return '🔴';
            case 'HIGH':
                return '🟠';
            case 'MEDIUM':
                return '🟡';
            case 'LOW':
                return '🟢';
            default:
                return '⚪';
        }
    }
    async askForTimezone(ctx) {
        await ctx.replyWithMarkdown('🔍 *Определяю ваш часовой пояс...*');
        try {
            const ipTimezone = await this.detectTimezoneByIP();
            if (ipTimezone) {
                await ctx.replyWithMarkdown(`
🌍 *Автоматически определен часовой пояс*

🏙️ Регион: ${ipTimezone.city || 'Не определен'}
🕐 Часовой пояс: ${ipTimezone.timezone}

Все верно?`, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '✅ Да, верно',
                                    callback_data: `confirm_timezone_${ipTimezone.timezone}`,
                                },
                                {
                                    text: '❌ Нет, выбрать вручную',
                                    callback_data: 'manual_timezone',
                                },
                            ],
                        ],
                    },
                });
                return;
            }
        }
        catch (error) {
            this.logger.warn('Could not detect timezone by IP:', error);
        }
        await this.showManualTimezoneSelection(ctx);
    }
    async showManualTimezoneSelection(ctx) {
        await ctx.replyWithMarkdown(`
🌍 *Настройка часового пояса*

Выберите удобный способ:`, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🏙️ Ввести город', callback_data: 'input_city' },
                        {
                            text: '🕐 Выбрать из списка',
                            callback_data: 'select_timezone',
                        },
                    ],
                ],
            },
        });
    }
    async detectTimezoneByIP() {
        try {
            const fetch = (await import('node-fetch')).default;
            const response = await fetch('http://worldtimeapi.org/api/ip');
            if (!response.ok) {
                return null;
            }
            const data = await response.json();
            return {
                timezone: data.timezone,
                city: data.timezone.split('/')[1]?.replace(/_/g, ' '),
            };
        }
        catch (error) {
            this.logger.warn('Error detecting timezone by IP:', error);
            return null;
        }
    }
    async handleCityInput(ctx, cityName) {
        await ctx.replyWithMarkdown('🔍 *Определяю часовой пояс...*');
        const result = await this.openaiService.getTimezoneByCity(cityName);
        if (!result) {
            await ctx.replyWithMarkdown(`
❌ *Не удалось определить часовой пояс для города "${cityName}"*

📍 Попробуйте еще раз. Напишите название города более точно:
      `);
            return;
        }
        await this.userService.updateUser(ctx.userId, {
            timezone: result.timezone,
            city: result.normalizedCity,
        });
        await ctx.replyWithMarkdown(`
✅ *Часовой пояс установлен!*

🏙️ Город: ${result.normalizedCity}
🕐 Часовой пояс: ${result.timezone}

Теперь можете продолжить создание задачи или привычки!
    `);
        ctx.session.step = undefined;
        if (ctx.session.pendingAction === 'adding_task') {
            ctx.session.pendingAction = undefined;
            await this.startAddingTask(ctx);
        }
        else if (ctx.session.pendingAction === 'adding_habit') {
            ctx.session.pendingAction = undefined;
            ctx.session.step = 'adding_habit';
            await ctx.replyWithMarkdown('🔄 *Добавление привычки*\n\nВведите название привычки, которую хотите отслеживать:', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        }
        else {
            await this.showMainMenu(ctx);
        }
    }
    createProgressBar(progress, length = 10) {
        const filled = Math.round(progress * length);
        const empty = length - filled;
        return '█'.repeat(filled) + '░'.repeat(empty);
    }
    async checkAndShowFeedbackRequest(ctx) {
        const user = await this.userService.findByTelegramId(ctx.userId);
        const accountAge = Date.now() - user.createdAt.getTime();
        const threeDaysInMs = 3 * 24 * 60 * 60 * 1000;
        if (accountAge >= threeDaysInMs && !user.feedbackGiven) {
            await this.showFeedbackRequest(ctx);
        }
    }
    async showFeedbackSurvey(ctx) {
        try {
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🎯 Удобство', callback_data: 'feedback_like_convenience' },
                        {
                            text: '🚀 Много функций',
                            callback_data: 'feedback_like_features',
                        },
                    ],
                    [
                        {
                            text: '🎮 Геймификация',
                            callback_data: 'feedback_like_gamification',
                        },
                        { text: '🔧 Другое', callback_data: 'feedback_like_other' },
                    ],
                ],
            };
            const message = `
💭 *Мини-опрос*

👍 *Что вам нравится?*

Выберите, что вас больше всего привлекает в боте:
      `;
            if (ctx.callbackQuery) {
                await ctx.editMessageTextWithMarkdown(message, {
                    reply_markup: keyboard,
                });
            }
            else {
                await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
            }
        }
        catch (error) {
            this.logger.error('Error in showFeedbackSurvey:', error);
            await ctx.replyWithMarkdown('❌ Ошибка при загрузке опроса. Попробуйте позже.');
        }
    }
    async showFeedbackRequest(ctx) {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '⭐️', callback_data: 'feedback_rating_5' },
                    { text: '😊', callback_data: 'feedback_rating_4' },
                    { text: '😐', callback_data: 'feedback_rating_3' },
                    { text: '😠', callback_data: 'feedback_rating_2' },
                ],
                [{ text: '⏰ Позже', callback_data: 'feedback_later' }],
            ],
        };
        await ctx.editMessageTextWithMarkdown(`
💭 *Оцените ваш опыт использования бота*

Как вам работа с Ticky AI? Ваше мнение поможет нам стать лучше!
      `, { reply_markup: keyboard });
    }
    async handleFeedbackRating(ctx, rating) {
        await ctx.answerCbQuery();
        ctx.session.feedbackRating = rating;
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🎯 Удобство', callback_data: 'feedback_like_convenience' },
                    { text: '🚀 Много функций', callback_data: 'feedback_like_features' },
                ],
                [
                    {
                        text: '🎮 Геймификация',
                        callback_data: 'feedback_like_gamification',
                    },
                    { text: '🔧 Другое', callback_data: 'feedback_like_other' },
                ],
            ],
        };
        await ctx.editMessageTextWithMarkdown(`
👍 *Что вам больше всего нравится?*

Выберите, что вас привлекает в боте:
      `, { reply_markup: keyboard });
    }
    async handleFeedbackImprovement(ctx, likedFeature) {
        await ctx.answerCbQuery();
        ctx.session.feedbackLiked = likedFeature;
        const keyboard = {
            inline_keyboard: [
                [
                    {
                        text: '🔧 Больше функций',
                        callback_data: 'feedback_improve_features',
                    },
                    { text: '🎨 Интерфейс', callback_data: 'feedback_improve_interface' },
                ],
                [
                    {
                        text: '⚡ Скорость работы',
                        callback_data: 'feedback_improve_speed',
                    },
                    {
                        text: '📝 Написать свое',
                        callback_data: 'feedback_improve_custom',
                    },
                ],
                [
                    {
                        text: '✅ Все устраивает',
                        callback_data: 'feedback_improve_nothing',
                    },
                ],
            ],
        };
        await ctx.editMessageTextWithMarkdown(`
💡 *Что хотелось бы улучшить?*

Выберите, что можно сделать лучше:
      `, { reply_markup: keyboard });
    }
    async completeFeedbackSurvey(ctx, improvement) {
        await ctx.answerCbQuery();
        await this.userService.updateUser(ctx.userId, {
            feedbackGiven: true,
        });
        const improvements = {
            convenience: '🎯 Удобство',
            features: '🚀 Много функций',
            gamification: '🎮 Геймификация',
            other: '🔧 Другое',
        };
        const improvementText = improvements[improvement] || improvement;
        await ctx.editMessageTextWithMarkdown(`
✨ *Спасибо за участие в опросе!*

Вы выбрали: ${improvementText}

Ваше мнение поможет нам стать лучше! 💝

Продолжайте пользоваться ботом и достигайте новых целей! 🚀
    `);
    }
    async completeFeedback(ctx, improvement) {
        await this.userService.updateUser(ctx.userId, {
            feedbackGiven: true,
        });
        const ratingEmojis = ['😠', '😠', '😐', '😊', '⭐️'];
        const rating = ctx.session.feedbackRating || 3;
        const ratingEmoji = ratingEmojis[rating - 1];
        await ctx.replyWithMarkdown(`
🙏 *Спасибо за обратную связь!*

${ratingEmoji} Ваша оценка: ${rating}/5
👍 Нравится: ${ctx.session.feedbackLiked || 'не указано'}
💡 Улучшить: ${improvement}

Ваше мнение очень важно для нас! 💚
    `);
        ctx.session.feedbackRating = undefined;
        ctx.session.feedbackLiked = undefined;
    }
    async startAIChat(ctx) {
        await ctx.editMessageTextWithMarkdown(`
🧠 *ИИ Консультант*

Выберите тему или задайте вопрос:
    `, {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '📊 Анализ профиля',
                            callback_data: 'ai_analyze_profile',
                        },
                    ],
                    [
                        {
                            text: '💡 Советы по задачам',
                            callback_data: 'ai_task_recommendations',
                        },
                    ],
                    [
                        {
                            text: '🎯 Помощь с привычками',
                            callback_data: 'ai_habit_help',
                        },
                    ],
                    [
                        {
                            text: '⏰ Планирование времени',
                            callback_data: 'ai_time_planning',
                        },
                    ],
                    [
                        {
                            text: '✍️ Свой вопрос',
                            callback_data: 'ai_custom_question',
                        },
                    ],
                    [{ text: '⬅️ Назад в меню', callback_data: 'back_to_menu' }],
                ],
            },
        });
        ctx.session.aiChatMode = true;
    }
    async handleAIAnalyzeProfile(ctx) {
        const user = await this.userService.findByTelegramId(ctx.userId);
        const tasks = await this.taskService.findTasksByUserId(ctx.userId);
        const completedTasks = tasks.filter((task) => task.completedAt !== null);
        const accountDays = Math.floor((Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24));
        const completionRate = tasks.length > 0
            ? Math.round((completedTasks.length / tasks.length) * 100)
            : 0;
        let status = '';
        if (user.totalXp < 500) {
            status = '🌱 Новичок - только начинаете путь к продуктивности!';
        }
        else if (user.totalXp < 2000) {
            status = '📈 Развиваетесь - уже видны первые результаты!';
        }
        else {
            status = '🚀 Опытный пользователь - отличные результаты!';
        }
        await ctx.editMessageTextWithMarkdown(`
📊 *Анализ профиля*

${status}

**Статистика:**
⭐ Опыт: ${user.totalXp} XP (уровень ${user.level})
📅 С ботом: ${accountDays} дней
📝 Задач создано: ${tasks.length}
✅ Выполнено: ${completedTasks.length} (${completionRate}%)

**Рекомендация:**
${completionRate > 70
            ? '🎯 Отлично! Попробуйте более сложные цели.'
            : completionRate > 40
                ? '💪 Хорошо! Сфокусируйтесь на завершении задач.'
                : '� Начните с малого - одна задача в день!'}
      `, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                    [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
            },
        });
    }
    async handleAIChatMessage(ctx, message) {
        try {
            const limitCheck = await this.billingService.checkUsageLimit(ctx.userId, 'dailyAiQueries');
            if (!limitCheck.allowed) {
                await ctx.replyWithMarkdown(limitCheck.message || '🚫 Превышен лимит ИИ-запросов', {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '💎 Обновиться до Premium',
                                    callback_data: 'upgrade_premium',
                                },
                            ],
                            [{ text: '📊 Мои лимиты', callback_data: 'show_limits' }],
                            [{ text: '⬅️ Назад в меню', callback_data: 'back_to_menu' }],
                        ],
                    },
                });
                return;
            }
            const absoluteTimePatterns = [
                /напомни\s+мне\s+(.+?)\s+в\s+(\d{1,2}):(\d{2})/i,
                /напомни\s+(.+?)\s+в\s+(\d{1,2}):(\d{2})/i,
                /напоминание\s+(.+?)\s+в\s+(\d{1,2}):(\d{2})/i,
                /поставь\s+напоминание\s+(.+?)\s+на\s+(\d{1,2}):(\d{2})/i,
            ];
            const relativeTimePatterns = [
                /напомни\s+мне\s+(.+?)\s+через\s+(\d+)\s+минут/i,
                /напомни\s+(.+?)\s+через\s+(\d+)\s+минут/i,
                /напоминание\s+(.+?)\s+через\s+(\d+)\s+минут/i,
            ];
            const intervalPatterns = [
                /напоминай\s+(.+?)\s+каждые?\s+(\d+)\s+(минут|час|часа|часов)/i,
                /напомни\s+(.+?)\s+каждые?\s+(\d+)\s+(минут|час|часа|часов)/i,
                /(.+?)\s+каждые?\s+(\d+)\s+(минут|час|часа|часов)/i,
            ];
            let reminderMatch = null;
            for (const pattern of intervalPatterns) {
                reminderMatch = message.match(pattern);
                if (reminderMatch) {
                    const [, reminderText, amount, unit] = reminderMatch;
                    let intervalMinutes = 0;
                    if (unit.includes('минут')) {
                        intervalMinutes = parseInt(amount);
                    }
                    else if (unit.includes('час')) {
                        intervalMinutes = parseInt(amount) * 60;
                    }
                    if (intervalMinutes >= 1 && intervalMinutes <= 1440) {
                        await this.handleIntervalReminder(ctx, reminderText.trim(), intervalMinutes);
                        return;
                    }
                }
            }
            for (const pattern of absoluteTimePatterns) {
                reminderMatch = message.match(pattern);
                if (reminderMatch) {
                    const [, reminderText, hours, minutes] = reminderMatch;
                    await this.handleReminderRequest(ctx, reminderText, hours, minutes);
                    return;
                }
            }
            for (const pattern of relativeTimePatterns) {
                reminderMatch = message.match(pattern);
                if (reminderMatch) {
                    const [, reminderText, minutesFromNow] = reminderMatch;
                    await this.handleRelativeReminderRequest(ctx, reminderText, parseInt(minutesFromNow));
                    return;
                }
            }
            await ctx.replyWithMarkdown('🤔 *Анализирую ваш вопрос...*');
            const personalizedResponse = await this.aiContextService.generatePersonalizedMessage(ctx.userId, 'motivation', `${message}. Ответь кратко, до 100 слов, конкретно и по делу.`);
            await this.billingService.incrementUsage(ctx.userId, 'dailyAiQueries');
            const usageInfo = await this.billingService.checkUsageLimit(ctx.userId, 'dailyAiQueries');
            await ctx.replyWithMarkdown(`
🧠 *ИИ отвечает:*

${personalizedResponse}

📊 ИИ-запросов: ${usageInfo.current}/${usageInfo.limit === -1 ? '∞' : usageInfo.limit}
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        }
        catch (error) {
            await ctx.replyWithMarkdown(`
❌ *Ошибка ИИ-консультанта*

Извините, сейчас не могу ответить на ваш вопрос. Попробуйте позже или задайте другой вопрос.
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                    ],
                },
            });
        }
    }
    async handleRelativeReminderRequest(ctx, reminderText, minutesFromNow) {
        try {
            const user = await this.userService.findByTelegramId(ctx.userId);
            if (minutesFromNow <= 0 || minutesFromNow > 1440) {
                await ctx.editMessageTextWithMarkdown(`
❌ *Неверное время*

Пожалуйста, укажите от 1 до 1440 минут (максимум 24 часа)
        `);
                return;
            }
            const now = new Date();
            const reminderDate = new Date(now.getTime() + minutesFromNow * 60 * 1000);
            setTimeout(async () => {
                try {
                    await ctx.telegram.sendMessage(ctx.userId, `🔔 *Напоминание!*

${reminderText}`, { parse_mode: 'Markdown' });
                }
                catch (error) {
                    this.logger.error('Error sending reminder:', error);
                }
            }, minutesFromNow * 60 * 1000);
            const timeStr = this.formatTimeWithTimezone(reminderDate, user?.timezone);
            await ctx.editMessageTextWithMarkdown(`✅ *Напоминание установлено!*

📝 **Текст:** ${reminderText}
⏰ **Время:** через ${minutesFromNow} минут (в ${timeStr})

Я напомню вам в указанное время! 🔔`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
            await this.userService.updateUser(ctx.userId, {
                totalXp: user.totalXp + 5,
            });
        }
        catch (error) {
            this.logger.error('Error creating relative reminder:', error);
            await ctx.editMessageTextWithMarkdown(`
❌ *Ошибка создания напоминания*

Не удалось создать напоминание. Попробуйте ещё раз.
      `);
        }
    }
    async handleReminderRequest(ctx, reminderText, hours, minutes) {
        try {
            const user = await this.userService.findByTelegramId(ctx.userId);
            const limitCheck = await this.billingService.checkUsageLimit(ctx.userId, 'dailyReminders');
            if (!limitCheck.allowed) {
                await ctx.replyWithMarkdown(limitCheck.message || '🚫 Превышен лимит напоминаний', {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '💎 Обновиться до Premium',
                                    callback_data: 'upgrade_premium',
                                },
                            ],
                            [{ text: '📊 Мои лимиты', callback_data: 'show_limits' }],
                        ],
                    },
                });
                return;
            }
            const hourNum = parseInt(hours);
            const minuteNum = parseInt(minutes);
            if (hourNum < 0 || hourNum > 23 || minuteNum < 0 || minuteNum > 59) {
                await ctx.replyWithMarkdown(`
❌ *Неверное время*

Пожалуйста, укажите корректное время в формате ЧЧ:ММ (например, 17:30)
        `);
                return;
            }
            const now = new Date();
            const reminderDate = new Date();
            reminderDate.setHours(hourNum, minuteNum, 0, 0);
            if (reminderDate <= now) {
                reminderDate.setDate(reminderDate.getDate() + 1);
            }
            const savedReminder = await this.prisma.reminder.create({
                data: {
                    userId: ctx.userId,
                    type: 'GENERAL',
                    title: reminderText,
                    message: reminderText,
                    scheduledTime: reminderDate,
                    status: client_1.ReminderStatus.ACTIVE,
                },
            });
            const delay = reminderDate.getTime() - now.getTime();
            setTimeout(async () => {
                try {
                    await ctx.telegram.sendMessage(ctx.userId, `🔔 *Напоминание!*\n\n${reminderText}`, { parse_mode: 'Markdown' });
                    await this.prisma.reminder.update({
                        where: { id: savedReminder.id },
                        data: { status: client_1.ReminderStatus.COMPLETED },
                    });
                }
                catch (error) {
                    this.logger.error('Error sending reminder:', error);
                }
            }, delay);
            await this.billingService.incrementUsage(ctx.userId, 'dailyReminders');
            const timeStr = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
            const dateStr = reminderDate.toLocaleDateString('ru-RU', {
                day: 'numeric',
                month: 'long',
            });
            const usageInfo = await this.billingService.checkUsageLimit(ctx.userId, 'dailyReminders');
            await ctx.replyWithMarkdown(`
✅ *Напоминание установлено!*

📝 **Текст:** ${reminderText}
⏰ **Время:** ${timeStr}
📅 **Дата:** ${dateStr}

📊 **Использовано сегодня:** ${usageInfo.current}/${usageInfo.limit === -1 ? '∞' : usageInfo.limit} напоминаний

Я напомню вам в указанное время! 🔔
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
            await this.userService.updateUser(ctx.userId, {
                totalXp: user.totalXp + 5,
            });
        }
        catch (error) {
            this.logger.error('Error creating reminder:', error);
            await ctx.replyWithMarkdown(`
❌ *Ошибка создания напоминания*

Не удалось создать напоминание. Попробуйте ещё раз.
      `);
        }
    }
    async handleReminderTimeInput(ctx, timeInput) {
        try {
            const reminderText = ctx.session.pendingReminder;
            if (!reminderText) {
                await ctx.replyWithMarkdown('❌ Ошибка: текст напоминания не найден.');
                return;
            }
            let hours, minutes;
            const timeMatch = timeInput.match(/(\d{1,2}):(\d{2})/);
            if (timeMatch) {
                hours = timeMatch[1];
                minutes = timeMatch[2];
            }
            else {
                const inTimeMatch = timeInput.match(/в\s*(\d{1,2})(?::(\d{2}))?/i);
                if (inTimeMatch) {
                    hours = inTimeMatch[1];
                    minutes = inTimeMatch[2] || '00';
                }
                else {
                    const minutesMatch = timeInput.match(/через\s*(\d+)\s*минут/i);
                    if (minutesMatch) {
                        const minutesToAdd = parseInt(minutesMatch[1]);
                        const futureTime = new Date();
                        futureTime.setMinutes(futureTime.getMinutes() + minutesToAdd);
                        hours = futureTime.getHours().toString();
                        minutes = futureTime.getMinutes().toString().padStart(2, '0');
                    }
                    else {
                        const hoursMatch = timeInput.match(/через\s*(\d+)\s*час/i);
                        if (hoursMatch) {
                            const hoursToAdd = parseInt(hoursMatch[1]);
                            const futureTime = new Date();
                            futureTime.setHours(futureTime.getHours() + hoursToAdd);
                            hours = futureTime.getHours().toString();
                            minutes = futureTime.getMinutes().toString().padStart(2, '0');
                        }
                        else if (timeInput.match(/^\d{1,2}$/) &&
                            parseInt(timeInput) <= 23) {
                            hours = timeInput;
                            minutes = '00';
                        }
                    }
                }
            }
            if (!hours || !minutes) {
                await ctx.editMessageTextWithMarkdown(`
❌ *Не удалось понять время*

Пожалуйста, укажите время в одном из форматов:
• **17:30** - конкретное время
• **в 18:00** - с предлогом
• **через 30 минут** - относительное время
• **через 2 часа** - относительное время
• **18** - целый час (18:00)

_Попробуйте еще раз_
        `);
                return;
            }
            const hourNum = parseInt(hours);
            const minuteNum = parseInt(minutes);
            if (hourNum < 0 || hourNum > 23 || minuteNum < 0 || minuteNum > 59) {
                await ctx.editMessageTextWithMarkdown(`
❌ *Неверное время*

Часы должны быть от 0 до 23, минуты от 0 до 59.
Попробуйте еще раз.
        `);
                return;
            }
            ctx.session.pendingReminder = undefined;
            ctx.session.waitingForReminderTime = false;
            await this.handleReminderRequest(ctx, reminderText, hours, minutes);
        }
        catch (error) {
            this.logger.error('Error processing reminder time input:', error);
            ctx.session.pendingReminder = undefined;
            ctx.session.waitingForReminderTime = false;
            await ctx.editMessageTextWithMarkdown(`
❌ *Ошибка обработки времени*

Попробуйте создать напоминание заново.
      `);
        }
    }
    async handleAudioMessage(ctx, type) {
        try {
            const emoji = type === 'voice' ? '🎤' : '🎵';
            const messageType = type === 'voice' ? 'голосовое сообщение' : 'аудио файл';
            await ctx.replyWithMarkdown(`${emoji} *Обрабатываю ${messageType}...*`);
            const transcribedText = await this.transcribeAudio(ctx, type);
            if (!transcribedText) {
                await ctx.replyWithMarkdown(`❌ Не удалось распознать ${messageType}. Попробуйте еще раз.`);
                return;
            }
            await ctx.replyWithMarkdown(`🎯 *Распознано:* "${transcribedText}"`);
            if (ctx.session.aiChatMode) {
                await this.handleAIChatMessage(ctx, transcribedText);
                return;
            }
            if (this.isReminderRequest(transcribedText)) {
                await this.processReminderFromText(ctx, transcribedText);
                return;
            }
            if (transcribedText.toLowerCase().includes('добавить задачу') ||
                transcribedText.toLowerCase().includes('новая задача') ||
                transcribedText.toLowerCase().includes('создать задачу')) {
                await this.startAddingTask(ctx);
                return;
            }
            if (transcribedText.toLowerCase().includes('меню') ||
                transcribedText.toLowerCase().includes('главное меню') ||
                transcribedText.toLowerCase().includes('показать меню')) {
                await this.showMainMenu(ctx);
                return;
            }
            if (transcribedText.toLowerCase().includes('помощь') ||
                transcribedText.toLowerCase().includes('справка') ||
                transcribedText.toLowerCase().includes('что ты умеешь')) {
                await ctx.editMessageTextWithMarkdown(`
🤖 *Ticky AI - Ваш персональный AI помощник продуктивности*

*Основные команды:*
/start - Начать работу с ботом
/help - Показать эту справку  
/menu - Главное меню
/feedback - Оставить отзыв о боте

*Голосовые команды:*
🎤 "Напомни мне..." - создать напоминание
🎤 "Добавить задачу" - создать новую задачу
🎤 "Показать меню" - открыть главное меню
🎤 "Что ты умеешь?" - показать справку

*Быстрые действия:*
📝 Добавить задачу или напоминание
🧠 Пообщаться с ИИ-консультантом
📊 Посмотреть прогресс

Для получения подробной информации используйте /menu
        `);
                return;
            }
            if (transcribedText.toLowerCase().includes('обратная связь') ||
                transcribedText.toLowerCase().includes('отзыв') ||
                transcribedText.toLowerCase().includes('фидбек')) {
                await this.showFeedbackSurvey(ctx);
                return;
            }
            if (transcribedText.toLowerCase().includes('добавить привычку') ||
                transcribedText.toLowerCase().includes('новая привычка') ||
                transcribedText.toLowerCase().includes('создать привычку')) {
                await this.startAddingHabit(ctx);
                return;
            }
            await this.analyzeAndCreateFromVoice(ctx, transcribedText);
        }
        catch (error) {
            this.logger.error(`${type} message processing error:`, error);
            await ctx.replyWithMarkdown(`❌ Произошла ошибка при обработке ${type === 'voice' ? 'голосового сообщения' : 'аудио файла'}.`);
        }
    }
    async transcribeAudio(ctx, type) {
        try {
            if (!ctx.message) {
                return null;
            }
            let fileId;
            if (type === 'voice' && 'voice' in ctx.message) {
                fileId = ctx.message.voice.file_id;
            }
            else if (type === 'audio' && 'audio' in ctx.message) {
                fileId = ctx.message.audio.file_id;
            }
            else {
                return null;
            }
            const fileLink = await ctx.telegram.getFileLink(fileId);
            const response = await fetch(fileLink.href);
            const buffer = await response.arrayBuffer();
            const fileName = type === 'voice' ? 'voice.ogg' : 'audio.mp3';
            const mimeType = type === 'voice' ? 'audio/ogg' : 'audio/mpeg';
            const file = new File([buffer], fileName, { type: mimeType });
            const transcription = await this.openaiService.transcribeAudio(file);
            return transcription;
        }
        catch (error) {
            this.logger.error(`Error transcribing ${type}:`, error);
            return null;
        }
    }
    async processReminderFromText(ctx, text) {
        this.logger.log(`Processing reminder from text: "${text}"`);
        const intervalMatch = text.match(/каждые?\s*(\d+)\s*(минут|час|часа|часов)/i);
        if (intervalMatch) {
            const intervalAmount = parseInt(intervalMatch[1]);
            const intervalUnit = intervalMatch[2].toLowerCase();
            let intervalMinutes = 0;
            if (intervalUnit.includes('минут')) {
                intervalMinutes = intervalAmount;
            }
            else if (intervalUnit.includes('час')) {
                intervalMinutes = intervalAmount * 60;
            }
            if (intervalMinutes < 1 || intervalMinutes > 1440) {
                await ctx.replyWithMarkdown(`
❌ *Неверный интервал*

Интервал должен быть от 1 минуты до 24 часов.
        `);
                return;
            }
            const reminderText = text
                .replace(/напомни\s*(мне)?/gi, '')
                .replace(/напомню\s*(тебе|вам)?/gi, '')
                .replace(/напоминание/gi, '')
                .replace(/поставь/gi, '')
                .replace(/установи/gi, '')
                .replace(/каждые?\s*\d+\s*(?:минут|час|часа|часов)/gi, '')
                .trim();
            if (!reminderText || reminderText.length < 2) {
                await ctx.replyWithMarkdown(`
🤔 *О чем напоминать каждые ${intervalAmount} ${intervalUnit}?*

Вы указали интервал, но не указали, о чем напоминать.

*Пример:* "напоминай пить воду каждые 30 минут"
        `);
                return;
            }
            await this.handleIntervalReminder(ctx, reminderText, intervalMinutes);
            return;
        }
        const timeMatch = text.match(/в\s*(\d{1,2}):(\d{2})/i) ||
            text.match(/в\s*(\d{1,2})\s*час(?:а|ов)?(?:\s*(\d{2})\s*минут)?/i) ||
            text.match(/на\s*(\d{1,2}):(\d{2})/i) ||
            text.match(/к\s*(\d{1,2}):(\d{2})/i) ||
            text.match(/(\d{1,2}):(\d{2})/i);
        if (timeMatch) {
            const hours = timeMatch[1];
            const minutes = timeMatch[2] || '00';
            this.logger.log(`Time extracted: ${hours}:${minutes}`);
            const reminderText = text
                .replace(/напомни\s*(мне)?/gi, '')
                .replace(/напомню\s*(тебе|вам)?/gi, '')
                .replace(/напоминание/gi, '')
                .replace(/поставь/gi, '')
                .replace(/установи/gi, '')
                .replace(/в\s*\d{1,2}:?\d{0,2}\s*(?:час|минут)?(?:а|ов)?/gi, '')
                .replace(/на\s*\d{1,2}:?\d{0,2}/gi, '')
                .replace(/к\s*\d{1,2}:?\d{0,2}/gi, '')
                .replace(/\d{1,2}:\d{2}/g, '')
                .replace(/(утром|днем|вечером|ночью)/gi, '')
                .trim();
            this.logger.log(`Reminder text extracted: "${reminderText}"`);
            if (!reminderText || reminderText.length < 2) {
                await ctx.replyWithMarkdown(`
🤔 *О чем напомнить?*

Вы указали время ${hours}:${minutes}, но не указали, о чем напомнить.

*Пример:* "напомни мне купить молоко в 17:30"
        `);
                return;
            }
            await this.handleReminderRequest(ctx, reminderText, hours, minutes);
            return;
        }
        const relativeMatch = text.match(/через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i);
        if (relativeMatch) {
            const amount = parseInt(relativeMatch[1]);
            const unit = relativeMatch[2].toLowerCase();
            const now = new Date();
            let targetDate = new Date(now);
            if (unit.includes('минут')) {
                targetDate.setMinutes(targetDate.getMinutes() + amount);
            }
            else if (unit.includes('час')) {
                targetDate.setHours(targetDate.getHours() + amount);
            }
            else if (unit.includes('день') ||
                unit.includes('дня') ||
                unit.includes('дней')) {
                targetDate.setDate(targetDate.getDate() + amount);
            }
            else if (unit.includes('недел')) {
                targetDate.setDate(targetDate.getDate() + amount * 7);
            }
            else if (unit.includes('месяц')) {
                targetDate.setMonth(targetDate.getMonth() + amount);
            }
            else if (unit.includes('год') || unit.includes('лет')) {
                targetDate.setFullYear(targetDate.getFullYear() + amount);
            }
            const hours = targetDate.getHours().toString().padStart(2, '0');
            const minutes = targetDate.getMinutes().toString().padStart(2, '0');
            const reminderText = text
                .replace(/напомни\s*(мне)?/gi, '')
                .replace(/напомню\s*(тебе|вам)?/gi, '')
                .replace(/через\s*\d+\s*(?:минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)(?:а|ов)?/gi, '')
                .trim();
            if (amount > 0 &&
                (unit.includes('день') ||
                    unit.includes('недел') ||
                    unit.includes('месяц') ||
                    unit.includes('год') ||
                    unit.includes('лет'))) {
                await this.handleLongTermReminder(ctx, reminderText, targetDate, amount, unit);
                return;
            }
            await this.handleReminderRequest(ctx, reminderText, hours, minutes);
            return;
        }
        const specificTimeMatch = this.parseSpecificTimeExpressions(text);
        if (specificTimeMatch) {
            const { targetDate, reminderText } = specificTimeMatch;
            targetDate.setHours(9, 0, 0, 0);
            await this.handleLongTermReminder(ctx, reminderText, targetDate, 0, 'specific');
            return;
        }
        const isReminderWithoutTime = this.isReminderWithoutTime(text);
        if (isReminderWithoutTime) {
            const reminderText = text
                .replace(/напомни\s*(мне)?/gi, '')
                .replace(/напомню\s*(мне)?/gi, '')
                .replace(/напоминание/gi, '')
                .replace(/поставь/gi, '')
                .replace(/установи/gi, '')
                .replace(/нужно.*напомнить/gi, '')
                .replace(/не забыть/gi, '')
                .trim();
            if (reminderText && reminderText.length > 1) {
                ctx.session.pendingReminder = reminderText;
                ctx.session.waitingForReminderTime = true;
                await ctx.replyWithMarkdown(`
⏰ *На какое время поставить напоминание?*

О чем напомнить: "${reminderText}"

*Укажите время:*
• В конкретное время: "17:30", "в 18:00"  
• Через некоторое время: "через 30 минут", "через 2 часа"

_Просто напишите время в удобном формате_
        `);
                return;
            }
        }
        await ctx.replyWithMarkdown(`
🤔 *Не удалось определить время напоминания*

Пожалуйста, укажите время в формате:
• "напомни купить молоко в 17:30"
• "напомни позвонить маме через 30 минут"
    `);
    }
    isReminderWithoutTime(text) {
        const reminderPatterns = [
            /напомни(?:\s+мне)?\s+.+/i,
            /напомню(?:\s+мне)?\s+.+/i,
            /напоминание\s+.+/i,
            /поставь\s+напоминание\s+.+/i,
            /установи\s+напоминание\s+.+/i,
            /нужно\s+напомнить\s+.+/i,
            /не\s+забыть\s+.+/i,
        ];
        const hasReminderTrigger = reminderPatterns.some((pattern) => pattern.test(text));
        const hasTimeIndicator = /в\s*\d{1,2}:?\d{0,2}|на\s*\d{1,2}:?\d{0,2}|к\s*\d{1,2}:?\d{0,2}|через\s*\d+\s*(?:минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)|завтра|послезавтра|на\s*следующей\s*неделе|в\s*следующем\s*месяце|в\s*следующем\s*году|на\s*этой\s*неделе|в\s*этом\s*месяце/i.test(text);
        return hasReminderTrigger && !hasTimeIndicator;
    }
    isReminderRequest(text) {
        const explicitReminderPatterns = [
            /напомни.*в\s*(\d{1,2}):(\d{2})/i,
            /напомни.*в\s*(\d{1,2})\s*час/i,
            /напомни.*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
            /напомню.*в\s*(\d{1,2}):(\d{2})/i,
            /напомню.*в\s*(\d{1,2})\s*час/i,
            /напомню.*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
            /напомни.*(завтра|послезавтра|на\s*следующей\s*неделе|в\s*следующем\s*месяце|в\s*следующем\s*году)/i,
            /напомню.*(завтра|послезавтра|на\s*следующей\s*неделе|в\s*следующем\s*месяце|в\s*следующем\s*году)/i,
            /напоминание.*в\s*(\d{1,2}):(\d{2})/i,
            /напоминание.*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
            /поставь.*напоминание.*в\s*(\d{1,2}):(\d{2})/i,
            /установи.*напоминание.*в\s*(\d{1,2}):(\d{2})/i,
            /поставь.*напоминание.*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
            /установи.*напоминание.*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
        ];
        const naturalTimePatterns = [
            /(утром|днем|вечером|ночью|сегодня|завтра|послезавтра).*в\s*(\d{1,2}):(\d{2})/i,
            /(завтра|послезавтра|сегодня).*в\s*(\d{1,2}):(\d{2})/i,
            /в\s*(\d{1,2}):(\d{2}).*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /(утром|днем|вечером|ночью|сегодня|завтра|послезавтра).*в\s*(\d{1,2})\s*час/i,
            /в\s*(\d{1,2})\s*час.*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет).*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
            /(завтра|послезавтра).*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*(завтра|послезавтра)/i,
            /на\s*следующей\s*неделе.*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*на\s*следующей\s*неделе/i,
            /в\s*следующем\s*месяце.*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*в\s*следующем\s*месяце/i,
            /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*(\d{1,2}):(\d{2})/i,
            /(\d{1,2}):(\d{2}).*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /(утром|днем|вечером|ночью).*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*(\d{1,2}):(\d{2})/i,
        ];
        const hasExplicitReminder = explicitReminderPatterns.some((pattern) => pattern.test(text));
        const hasNaturalTime = naturalTimePatterns.some((pattern) => pattern.test(text));
        return hasExplicitReminder || hasNaturalTime;
    }
    isTaskRequest(text) {
        if (this.isReminderRequest(text)) {
            return false;
        }
        const words = text.trim().split(/\s+/);
        if (words.length <= 2) {
            const actionVerbs = [
                'сделать',
                'выполнить',
                'купить',
                'позвонить',
                'написать',
                'отправить',
                'подготовить',
                'организовать',
                'запланировать',
                'пить',
                'делать',
                'читать',
                'встретить',
                'пойти',
                'поехать',
                'забрать',
                'отнести',
                'принести',
                'вернуть',
                'показать',
                'рассказать',
                'заплатить',
                'оплатить',
                'заказать',
                'записаться',
                'посмотреть',
                'проверить',
                'изучить',
                'прочитать',
                'приготовить',
                'почистить',
                'убрать',
                'помыть',
                'постирать',
                'погладить',
                'сходить',
                'съездить',
                'дойти',
                'добраться',
                'доехать',
                'приехать',
                'прийти',
                'заехать',
                'зайти',
                'завернуть',
                'заскочить',
                'навестить',
                'посетить',
                'встретиться',
                'увидеться',
                'поговорить',
                'обсудить',
                'решить',
                'закончить',
                'завершить',
                'начать',
                'приступить',
                'продолжить',
                'остановить',
                'прекратить',
                'открыть',
                'закрыть',
                'включить',
                'выключить',
                'настроить',
                'установить',
                'скачать',
                'загрузить',
                'отправиться',
                'выйти',
                'уйти',
                'вернуться',
                'отдохнуть',
                'поспать',
                'проснуться',
                'встать',
                'лечь',
                'собраться',
                'одеться',
                'переодеться',
            ];
            const hasActionVerb = actionVerbs.some((verb) => text.toLowerCase().includes(verb));
            if (!hasActionVerb) {
                return false;
            }
        }
        const taskPatterns = [
            /^(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /(завтра|послезавтра|сегодня|в понедельник|во вторник|в среду|в четверг|в пятницу|в субботу|в воскресенье)\s+(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /нужно\s+(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить)/i,
            /надо\s+(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить)/i,
            /^пить\s+/i,
            /^делать\s+/i,
            /^читать\s+/i,
            /каждый\s+(день|час|минут)/i,
            /каждые\s+\d+/i,
            /через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)\s*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
            /(завтра|послезавтра)\s*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*(завтра|послезавтра)/i,
            /на\s*следующей\s*неделе\s*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*на\s*следующей\s*неделе/i,
            /в\s*следующем\s*месяце\s*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i,
            /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*в\s*следующем\s*месяце/i,
        ];
        const reminderOnlyExclusions = [
            /(утром|днем|вечером|ночью).*в\s*\d/i,
            /завтра\s+в\s+\d/i,
            /сегодня\s+в\s+\d/i,
        ];
        const reminderTriggers = [/напомни|напомню|напоминание|remind/i];
        const hasReminderOnlyExclusions = reminderOnlyExclusions.some((pattern) => pattern.test(text));
        const hasReminderTriggers = reminderTriggers.some((pattern) => pattern.test(text));
        if (hasReminderOnlyExclusions || hasReminderTriggers) {
            return false;
        }
        const isTask = taskPatterns.some((pattern) => pattern.test(text));
        return isTask;
    }
    isGeneralChatMessage(text) {
        const generalPatterns = [
            /^(привет|здравствуй|добрый день|добрый вечер|хай|hello|hi)$/i,
            /^(пока|до свидания|увидимся|всего хорошего|bye|goodbye)$/i,
            /^ответь на вопрос/i,
            /^что мне делать/i,
            /^как дела\??$/i,
            /^как поживаешь\??$/i,
            /^что нового\??$/i,
            /^расскажи о/i,
            /^объясни мне/i,
            /^помоги понять/i,
            /^что ты думаешь о/i,
            /^твое мнение о/i,
            /^как ты считаешь/i,
            /^посоветуй мне/i,
            /^что ты думаешь\??$/i,
            /^что ты умеешь\??$/i,
            /^помощь$/i,
            /^help$/i,
            /^спасибо$/i,
            /^благодарю$/i,
            /^thanks$/i,
        ];
        const excludePatterns = [
            /\/\w+/,
            /добавить|создать|сделать|выполнить|купить|позвонить|написать|отправить|заказать|записать|встретить|пойти|поехать/i,
            /в\s*\d{1,2}:\d{2}/,
            /через\s+\d+/,
            /в\s*\d{1,2}\s*час/,
            /(утром|днем|вечером|ночью).*в\s*\d/,
            /напомни|напоминание|будильник|таймер/i,
            /задача|дело|план|цель/i,
            /привычка|тренировка|упражнение/i,
            /^\d+/,
            /:\d{2}/,
            /\d+\s*(минут|часов|дней|недель|месяцев)/i,
            /нужно|надо|должен|обязательно/i,
        ];
        const hasExclusions = excludePatterns.some((pattern) => pattern.test(text));
        if (hasExclusions) {
            return false;
        }
        const isGeneral = generalPatterns.some((pattern) => pattern.test(text));
        return isGeneral;
    }
    async processTaskFromText(ctx, text) {
        console.log(`🔍 Processing task from text: "${text}"`);
        const relativeMatch = text.match(/через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i);
        if (relativeMatch) {
            const amount = parseInt(relativeMatch[1]);
            const unit = relativeMatch[2].toLowerCase();
            const now = new Date();
            let targetDate = new Date(now);
            if (unit.includes('минут')) {
                targetDate.setMinutes(targetDate.getMinutes() + amount);
            }
            else if (unit.includes('час')) {
                targetDate.setHours(targetDate.getHours() + amount);
            }
            else if (unit.includes('день') ||
                unit.includes('дня') ||
                unit.includes('дней')) {
                targetDate.setDate(targetDate.getDate() + amount);
            }
            else if (unit.includes('недел')) {
                targetDate.setDate(targetDate.getDate() + amount * 7);
            }
            else if (unit.includes('месяц')) {
                targetDate.setMonth(targetDate.getMonth() + amount);
            }
            else if (unit.includes('год') || unit.includes('лет')) {
                targetDate.setFullYear(targetDate.getFullYear() + amount);
            }
            const taskText = text
                .replace(/через\s*\d+\s*(?:минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)(?:а|ов)?/gi, '')
                .trim();
            if (amount > 0 &&
                (unit.includes('день') ||
                    unit.includes('недел') ||
                    unit.includes('месяц') ||
                    unit.includes('год') ||
                    unit.includes('лет'))) {
                await this.handleLongTermTask(ctx, taskText, targetDate, amount, unit);
                return;
            }
            await this.createTaskWithDeadline(ctx, taskText, targetDate);
            return;
        }
        const specificTimeMatch = this.parseSpecificTimeExpressionsForTasks(text);
        if (specificTimeMatch) {
            const { targetDate, taskText } = specificTimeMatch;
            targetDate.setHours(9, 0, 0, 0);
            await this.handleLongTermTask(ctx, taskText, targetDate, 0, 'specific');
            return;
        }
        const concreteTimeMatch = text.match(/в\s*(\d{1,2}):(\d{2})/i);
        if (concreteTimeMatch) {
            const hours = parseInt(concreteTimeMatch[1]);
            const minutes = parseInt(concreteTimeMatch[2]);
            if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
                const targetDate = new Date();
                targetDate.setHours(hours, minutes, 0, 0);
                if (targetDate.getTime() <= new Date().getTime()) {
                    targetDate.setDate(targetDate.getDate() + 1);
                }
                const taskText = text.replace(/в\s*\d{1,2}:\d{2}/gi, '').trim();
                await this.createTaskWithDeadline(ctx, taskText, targetDate);
                return;
            }
        }
        await this.createTaskFromText(ctx, text);
    }
    async createTaskFromText(ctx, text) {
        try {
            const user = await this.userService.findByTelegramId(ctx.userId);
            if (!user.timezone) {
                ctx.session.step = 'waiting_for_task_title';
                ctx.session.tempData = { taskTitle: text };
                await this.askForTimezone(ctx);
                return;
            }
            const intervalInfo = this.extractTimeIntervalFromText(text.trim());
            if (intervalInfo) {
                const habit = await this.habitService.createHabit({
                    userId: ctx.userId,
                    title: text.trim(),
                    description: `Привычка с интервалом: ${intervalInfo.interval}`,
                    frequency: 'DAILY',
                    reminderTime: intervalInfo.interval,
                });
                let responseMessage = `✅ *Привычка создана!*\n\n📝 **"${habit.title}"**\n\n� **Описание:** ${intervalInfo.interval}\n\n💡 *Подсказка:* Вы можете настроить напоминания для этой привычки в меню привычек.`;
                await ctx.replyWithMarkdown(responseMessage, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '⏰ Настроить напоминание',
                                    callback_data: `habit_set_reminder_${habit.id}`,
                                },
                            ],
                            [{ text: '🎯 Мои привычки', callback_data: 'habits_list' }],
                            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                        ],
                    },
                });
            }
            else {
                const task = await this.taskService.createTask({
                    userId: ctx.userId,
                    title: text.trim(),
                });
                let responseMessage = `✅ *Задача создана!*\n\n📝 **"${task.title}"**\n\nЗадача добавлена в ваш список. Вы можете найти её в разделе "Мои задачи и привычки".`;
                responseMessage += `\n\n💡 *Подсказки:*
• Напоминание: "напомни купить молоко в 17:30"
• Интервальное: "напоминай пить воду каждые 30 минут"`;
                await ctx.replyWithMarkdown(responseMessage, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📝 Мои задачи', callback_data: 'tasks_list' }],
                            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                        ],
                    },
                });
            }
        }
        catch (error) {
            this.logger.error(`Error creating task from text: ${error}`);
            await ctx.replyWithMarkdown('❌ Произошла ошибка при создании задачи. Попробуйте позже.');
        }
    }
    async showTasksAIAdvice(ctx) {
        try {
            await ctx.editMessageTextWithMarkdown('🤔 *Анализирую ваши задачи...*');
            const aiAdvice = await this.aiContextService.generatePersonalizedMessage(ctx.userId, 'task_suggestion', '');
            await ctx.editMessageTextWithMarkdown(`
🤖 *AI-совет по задачам:*

${aiAdvice}

💡 *Хотите ещё советы?* Просто напишите мне в чат!
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📝 Добавить задачу', callback_data: 'tasks_add' }],
                        [{ text: '🔙 Назад к задачам', callback_data: 'back_to_tasks' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error getting AI advice for tasks:', error);
            await ctx.editMessageTextWithMarkdown(`
❌ *Не удалось получить AI-совет*

Попробуйте позже или напишите мне напрямую в чат!
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Назад к задачам', callback_data: 'back_to_tasks' }],
                    ],
                },
            });
        }
    }
    async showHabitsAIAdvice(ctx) {
        try {
            await ctx.editMessageTextWithMarkdown('🤔 *Анализирую ваши привычки...*');
            const aiAdvice = await this.aiContextService.generatePersonalizedMessage(ctx.userId, 'habit_advice', '');
            await ctx.editMessageTextWithMarkdown(`
🤖 *AI-совет по привычкам:*

${aiAdvice}

💡 *Хотите ещё советы?* Просто напишите мне в чат!
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Назад к привычкам', callback_data: 'menu_habits' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error getting AI advice for habits:', error);
            await ctx.editMessageTextWithMarkdown(`
❌ *Не удалось получить AI-совет*

Попробуйте позже или напишите мне напрямую в чат!
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 Назад к привычкам', callback_data: 'menu_habits' }],
                    ],
                },
            });
        }
    }
    async showHabitsMenu(ctx) {
        const user = await this.userService.findByTelegramId(ctx.userId);
        if (!user.timezone) {
            ctx.session.step = 'adding_habit';
            await this.askForTimezone(ctx);
        }
        else {
            try {
                const habits = await this.habitService.findHabitsByUserId(ctx.userId);
                let message = `🔄 *Мои привычки*\n\n`;
                if (habits.length === 0) {
                    message += `У вас пока нет привычек.\n\n💡 Добавьте первую привычку, чтобы начать отслеживание!`;
                    const keyboard = {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '➕ Добавить привычку', callback_data: 'habits_add' }],
                                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                            ],
                        },
                    };
                    if (ctx.callbackQuery) {
                        await ctx.editMessageTextWithMarkdown(message, keyboard);
                    }
                    else {
                        await ctx.replyWithMarkdown(message, keyboard);
                    }
                }
                else {
                    message += `📊 **Всего привычек:** ${habits.length}\n\n`;
                    message += `*Выберите привычку для выполнения:*`;
                    const keyboard = {
                        inline_keyboard: [
                            ...habits.slice(0, 8).map((habit) => [
                                {
                                    text: `✅ ${habit.title.substring(0, 30)}${habit.title.length > 30 ? '...' : ''}`,
                                    callback_data: `habit_complete_${habit.id}`,
                                },
                            ]),
                            ...(habits.length > 8
                                ? [
                                    [
                                        {
                                            text: `... и еще ${habits.length - 8} привычек`,
                                            callback_data: 'habits_list_more',
                                        },
                                    ],
                                ]
                                : []),
                            [{ text: '➕ Добавить привычку', callback_data: 'habits_add' }],
                            [
                                {
                                    text: '🛠️ Управление привычками',
                                    callback_data: 'habits_manage',
                                },
                            ],
                            [
                                {
                                    text: '🤖 AI-совет по привычкам',
                                    callback_data: 'habits_ai_advice',
                                },
                            ],
                            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                        ],
                    };
                    if (ctx.callbackQuery) {
                        await ctx.editMessageTextWithMarkdown(message, {
                            reply_markup: keyboard,
                        });
                    }
                    else {
                        await ctx.replyWithMarkdown(message, {
                            reply_markup: keyboard,
                        });
                    }
                }
            }
            catch (error) {
                this.logger.error(`Error fetching habits: ${error}`);
                const errorMessage = '❌ Произошла ошибка при загрузке привычек. Попробуйте позже.';
                const errorKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                        ],
                    },
                };
                if (ctx.callbackQuery) {
                    await ctx.editMessageTextWithMarkdown(errorMessage, errorKeyboard);
                }
                else {
                    await ctx.replyWithMarkdown(errorMessage, errorKeyboard);
                }
            }
        }
    }
    async showMoodMenu(ctx) {
        const message = `
😊 *Дневник настроения*

Отметьте свое текущее настроение:
      `;
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '😄 Отлично', callback_data: 'mood_excellent' },
                        { text: '😊 Хорошо', callback_data: 'mood_good' },
                    ],
                    [
                        { text: '😐 Нормально', callback_data: 'mood_neutral' },
                        { text: '😔 Грустно', callback_data: 'mood_sad' },
                    ],
                    [
                        { text: '😤 Злой', callback_data: 'mood_angry' },
                        { text: '😰 Тревожно', callback_data: 'mood_anxious' },
                    ],
                    [
                        {
                            text: '🤖 AI-анализ настроения',
                            callback_data: 'mood_ai_analysis',
                        },
                    ],
                    [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
            },
        };
        if (ctx.callbackQuery) {
            await ctx.editMessageTextWithMarkdown(message, keyboard);
        }
        else {
            await ctx.replyWithMarkdown(message, keyboard);
        }
    }
    async showMoodAIAnalysis(ctx) {
        try {
            await ctx.editMessageTextWithMarkdown('🤔 *Анализирую ваше настроение...*');
            const aiAnalysis = await this.aiContextService.generatePersonalizedMessage(ctx.userId, 'mood_analysis', '');
            await ctx.editMessageTextWithMarkdown(`
🤖 *AI-анализ настроения:*

${aiAnalysis}

💡 *Хотите персональные советы?* Просто напишите мне в чат!
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '😊 Отметить настроение', callback_data: 'menu_mood' }],
                        [{ text: '🔙 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error getting AI mood analysis:', error);
            await ctx.editMessageTextWithMarkdown(`
❌ *Не удалось получить AI-анализ*

Попробуйте позже или напишите мне напрямую в чат!
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 К настроению', callback_data: 'menu_mood' }],
                    ],
                },
            });
        }
    }
    async showFocusSession(ctx) {
        const message = `
🍅 *Техника Помодоро*

**Как это работает:**
⏰ 25 минут фокуса на задаче
☕ 5 минут отдых
🔄 Повторить 4 раза
🏖️ Большой перерыв 15-30 минут

**Ваши статистики:**
🎯 Сессий сегодня: 0
⚡ Общее время фокуса: 0 мин
📈 Лучший день: 0 сессий

*Выберите действие:*
      `;
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '🚀 Начать сессию',
                            callback_data: 'start_pomodoro_session',
                        },
                    ],
                    [
                        {
                            text: '📊 История сессий',
                            callback_data: 'pomodoro_history',
                        },
                        {
                            text: '⚙️ Настройки',
                            callback_data: 'pomodoro_settings',
                        },
                    ],
                    [
                        {
                            text: '🤖 AI-советы по фокусу',
                            callback_data: 'focus_ai_tips',
                        },
                    ],
                    [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
            },
        };
        if (ctx.callbackQuery) {
            await ctx.editMessageTextWithMarkdown(message, keyboard);
        }
        else {
            await ctx.replyWithMarkdown(message, keyboard);
        }
    }
    async showRemindersMenu(ctx) {
        try {
            const reminders = await this.prisma.reminder.findMany({
                where: {
                    userId: ctx.userId,
                    status: client_1.ReminderStatus.ACTIVE,
                    scheduledTime: {
                        gte: new Date(),
                    },
                },
                orderBy: {
                    scheduledTime: 'asc',
                },
                take: 10,
            });
            let message = `🔔 *Мои напоминания*\n\n`;
            if (reminders.length === 0) {
                message += `У вас нет активных напоминаний.\n\n💡 Создайте напоминание, написав:\n"напомни мне купить молоко в 17:30"`;
                const keyboard = {
                    inline_keyboard: [
                        [
                            {
                                text: '➕ Создать напоминание',
                                callback_data: 'create_reminder_help',
                            },
                            { text: '🎤 Голосом', callback_data: 'voice_reminder_help' },
                        ],
                        [{ text: '📝 Все напоминания', callback_data: 'all_reminders' }],
                        [
                            { text: '⬅️ Назад', callback_data: 'more_functions' },
                            { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
                        ],
                    ],
                };
                if (ctx.callbackQuery) {
                    await ctx.editMessageTextWithMarkdown(message, {
                        reply_markup: keyboard,
                    });
                }
                else {
                    await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
                }
                return;
            }
            message += `📊 **Активных напоминаний:** ${reminders.length}\n\n`;
            message += `*Ближайшие напоминания:*\n\n`;
            for (let i = 0; i < Math.min(5, reminders.length); i++) {
                const reminder = reminders[i];
                const date = new Date(reminder.scheduledTime);
                const dateStr = date.toLocaleDateString('ru-RU', {
                    day: 'numeric',
                    month: 'short',
                });
                const timeStr = date.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                });
                message += `${i + 1}. 📝 ${reminder.title}\n`;
                message += `    ⏰ ${dateStr} в ${timeStr}\n\n`;
            }
            if (reminders.length > 5) {
                message += `... и еще ${reminders.length - 5} напоминаний`;
            }
            const keyboard = {
                inline_keyboard: [
                    [
                        {
                            text: '➕ Создать напоминание',
                            callback_data: 'create_reminder_help',
                        },
                        { text: '🎤 Голосом', callback_data: 'voice_reminder_help' },
                    ],
                    [{ text: '📝 Все напоминания', callback_data: 'all_reminders' }],
                    [
                        { text: '✏️ Управление', callback_data: 'manage_reminders' },
                        { text: '📊 Статистика', callback_data: 'reminders_stats' },
                    ],
                    [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
                    [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
            };
            if (ctx.callbackQuery) {
                await ctx.editMessageTextWithMarkdown(message, {
                    reply_markup: keyboard,
                });
            }
            else {
                await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
            }
        }
        catch (error) {
            this.logger.error(`Error fetching reminders: ${error}`);
            const errorMessage = '❌ Произошла ошибка при загрузке напоминаний. Попробуйте позже.';
            const errorKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
                            { text: '⬅️ Назад', callback_data: 'more_functions' },
                        ],
                        [],
                    ],
                },
            };
            if (ctx.callbackQuery) {
                await ctx.editMessageTextWithMarkdown(errorMessage, errorKeyboard);
            }
            else {
                await ctx.replyWithMarkdown(errorMessage, errorKeyboard);
            }
        }
    }
    async showAllReminders(ctx) {
        try {
            const activeReminders = await this.prisma.reminder.findMany({
                where: {
                    userId: ctx.userId,
                    status: client_1.ReminderStatus.ACTIVE,
                },
                orderBy: {
                    scheduledTime: 'asc',
                },
            });
            const completedReminders = await this.prisma.reminder.findMany({
                where: {
                    userId: ctx.userId,
                    status: { in: [client_1.ReminderStatus.COMPLETED, client_1.ReminderStatus.DISMISSED] },
                },
                orderBy: {
                    scheduledTime: 'desc',
                },
                take: 5,
            });
            let message = `🔔 *Все напоминания*\n\n`;
            if (activeReminders.length > 0) {
                message += `🟢 **Активные (${activeReminders.length}):**\n\n`;
                activeReminders.forEach((reminder, index) => {
                    const date = new Date(reminder.scheduledTime);
                    const isToday = date.toDateString() === new Date().toDateString();
                    const isTomorrow = date.toDateString() ===
                        new Date(Date.now() + 24 * 60 * 60 * 1000).toDateString();
                    let dateStr;
                    if (isToday) {
                        dateStr = 'сегодня';
                    }
                    else if (isTomorrow) {
                        dateStr = 'завтра';
                    }
                    else {
                        dateStr = date.toLocaleDateString('ru-RU', {
                            day: 'numeric',
                            month: 'short',
                        });
                    }
                    const timeStr = date.toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                    });
                    message += `${index + 1}. 📝 ${reminder.title}\n`;
                    message += `    ⏰ ${dateStr} в ${timeStr}\n\n`;
                });
            }
            else {
                message += `🟢 **Активные:** нет\n\n`;
            }
            if (completedReminders.length > 0) {
                message += `✅ **Недавние (последние ${completedReminders.length}):**\n\n`;
                completedReminders.forEach((reminder, index) => {
                    const date = new Date(reminder.scheduledTime);
                    const dateStr = date.toLocaleDateString('ru-RU', {
                        day: 'numeric',
                        month: 'short',
                    });
                    const timeStr = date.toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                    });
                    const statusIcon = reminder.status === client_1.ReminderStatus.COMPLETED ? '✅' : '❌';
                    message += `${index + 1}. ${statusIcon} ${reminder.title}\n`;
                    message += `    📅 ${dateStr} в ${timeStr}\n\n`;
                });
            }
            else {
                message += `✅ **Завершенные:** нет истории`;
            }
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔔 Активные', callback_data: 'reminders' },
                        { text: '➕ Создать', callback_data: 'create_reminder_help' },
                    ],
                    [{ text: '⬅️ Назад', callback_data: 'reminders' }],
                ],
            };
            await ctx.editMessageTextWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        catch (error) {
            this.logger.error(`Error fetching all reminders: ${error}`);
            await ctx.editMessageTextWithMarkdown('❌ Произошла ошибка при загрузке напоминаний. Попробуйте позже.', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'reminders' }],
                    ],
                },
            });
        }
    }
    async showCreateReminderHelp(ctx) {
        const message = `
➕ *Создание напоминания*

**Как создать напоминание:**

📝 **Примеры команд:**
• "напомни купить молоко в 17:30"
• "напомни позвонить маме через 2 часа"
• "напомни встреча завтра в 14:00"
• "напомни про лекарства в 20:00"

⏰ **Форматы времени:**
• Конкретное время: "в 15:30", "на 18:00"
• Относительное время: "через 30 минут", "через 2 часа"

💡 **Совет:** Просто напишите в чат что и когда нужно напомнить!
    `;
        const keyboard = {
            inline_keyboard: [
                [{ text: '🔔 Мои напоминания', callback_data: 'reminders' }],
                [{ text: '⬅️ Назад', callback_data: 'reminders' }],
            ],
        };
        await ctx.editMessageTextWithMarkdown(message, { reply_markup: keyboard });
    }
    async showVoiceReminderHelp(ctx) {
        const message = `
🎤 *Голосовые напоминания*

**Как записать напоминание голосом:**

1️⃣ **Отправьте голосовое сообщение**
   Запишите что вам напомнить и когда

2️⃣ **Примеры записи:**
   🎙️ "Напомни мне купить молоко завтра в 17:30"
   🎙️ "Напомни позвонить врачу через 2 часа"
   🎙️ "Напомни про встречу в понедельник в 14:00"

⏰ **Форматы времени в голосе:**
• "в 17:30", "в семнадцать тридцать"
• "через час", "через 30 минут"
• "завтра в 15:00", "послезавтра в обед"

🔊 **Просто отправьте голосовое сообщение в чат!**

💡 **Совет:** Говорите четко и указывайте конкретное время
    `;
        const keyboard = {
            inline_keyboard: [
                [{ text: '📝 Текстом', callback_data: 'create_reminder_help' }],
                [{ text: '🔔 Мои напоминания', callback_data: 'reminders' }],
                [
                    { text: '⬅️ Назад', callback_data: 'reminders' },
                    { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
                ],
            ],
        };
        await ctx.editMessageTextWithMarkdown(message, { reply_markup: keyboard });
    }
    async showManageReminders(ctx) {
        try {
            const reminders = await this.prisma.reminder.findMany({
                where: {
                    userId: ctx.userId,
                    status: client_1.ReminderStatus.ACTIVE,
                },
                orderBy: {
                    scheduledTime: 'asc',
                },
            });
            let message = `✏️ *Управление напоминаниями*\n\n`;
            if (reminders.length === 0) {
                message += `У вас нет активных напоминаний для управления.\n\n`;
                message += `💡 Создайте напоминание, чтобы управлять им.`;
                const keyboard = {
                    inline_keyboard: [
                        [
                            {
                                text: '➕ Создать напоминание',
                                callback_data: 'create_reminder_help',
                            },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'reminders' }],
                    ],
                };
                await ctx.editMessageTextWithMarkdown(message, {
                    reply_markup: keyboard,
                });
                return;
            }
            message += `📊 **Активных напоминаний:** ${reminders.length}\n\n`;
            message += `*Выберите напоминание для управления:*\n\n`;
            const keyboard = {
                inline_keyboard: [
                    ...reminders.slice(0, 8).map((reminder) => {
                        const date = new Date(reminder.scheduledTime);
                        const timeStr = date.toLocaleTimeString('ru-RU', {
                            hour: '2-digit',
                            minute: '2-digit',
                        });
                        const title = reminder.title.length > 25
                            ? reminder.title.substring(0, 25) + '...'
                            : reminder.title;
                        return [
                            {
                                text: `🗑️ ${title} (${timeStr})`,
                                callback_data: `delete_reminder_${reminder.id}`,
                            },
                        ];
                    }),
                    [
                        { text: '🔔 К напоминаниям', callback_data: 'reminders' },
                        { text: '⬅️ Назад', callback_data: 'reminders' },
                    ],
                ],
            };
            if (reminders.length > 8) {
                message += `\n... и еще ${reminders.length - 8} напоминаний\n`;
                message += `_Показаны первые 8 напоминаний_`;
            }
            await ctx.editMessageTextWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        catch (error) {
            this.logger.error(`Error showing manage reminders: ${error}`);
            await ctx.editMessageTextWithMarkdown('❌ Произошла ошибка. Попробуйте позже.', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'reminders' }],
                    ],
                },
            });
        }
    }
    async showRemindersStats(ctx) {
        try {
            const totalActive = await this.prisma.reminder.count({
                where: {
                    userId: ctx.userId,
                    status: client_1.ReminderStatus.ACTIVE,
                },
            });
            const totalCompleted = await this.prisma.reminder.count({
                where: {
                    userId: ctx.userId,
                    status: client_1.ReminderStatus.COMPLETED,
                },
            });
            const totalDismissed = await this.prisma.reminder.count({
                where: {
                    userId: ctx.userId,
                    status: client_1.ReminderStatus.DISMISSED,
                },
            });
            const todayCompleted = await this.prisma.reminder.count({
                where: {
                    userId: ctx.userId,
                    status: client_1.ReminderStatus.COMPLETED,
                    scheduledTime: {
                        gte: new Date(new Date().setHours(0, 0, 0, 0)),
                        lte: new Date(new Date().setHours(23, 59, 59, 999)),
                    },
                },
            });
            const nextReminder = await this.prisma.reminder.findFirst({
                where: {
                    userId: ctx.userId,
                    status: client_1.ReminderStatus.ACTIVE,
                    scheduledTime: {
                        gte: new Date(),
                    },
                },
                orderBy: {
                    scheduledTime: 'asc',
                },
            });
            let message = `📊 *Статистика напоминаний*\n\n`;
            message += `**Общая статистика:**\n`;
            message += `🟢 Активных: ${totalActive}\n`;
            message += `✅ Выполнено: ${totalCompleted}\n`;
            message += `❌ Отклонено: ${totalDismissed}\n`;
            message += `📈 Всего: ${totalActive + totalCompleted + totalDismissed}\n\n`;
            message += `**Сегодня:**\n`;
            message += `✅ Выполнено напоминаний: ${todayCompleted}\n\n`;
            if (nextReminder) {
                const nextDate = new Date(nextReminder.scheduledTime);
                const isToday = nextDate.toDateString() === new Date().toDateString();
                const isTomorrow = nextDate.toDateString() ===
                    new Date(Date.now() + 24 * 60 * 60 * 1000).toDateString();
                let dateStr;
                if (isToday) {
                    dateStr = 'сегодня';
                }
                else if (isTomorrow) {
                    dateStr = 'завтра';
                }
                else {
                    dateStr = nextDate.toLocaleDateString('ru-RU', {
                        day: 'numeric',
                        month: 'short',
                    });
                }
                const timeStr = nextDate.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                });
                message += `**Ближайшее напоминание:**\n`;
                message += `📝 ${nextReminder.title}\n`;
                message += `⏰ ${dateStr} в ${timeStr}`;
            }
            else {
                message += `**Ближайшее напоминание:**\n`;
                message += `Нет активных напоминаний`;
            }
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔔 Мои напоминания', callback_data: 'reminders' },
                        { text: '➕ Создать', callback_data: 'create_reminder_help' },
                    ],
                    [
                        { text: '⬅️ Назад', callback_data: 'reminders' },
                        { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
                    ],
                ],
            };
            await ctx.editMessageTextWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        catch (error) {
            this.logger.error(`Error showing reminders stats: ${error}`);
            await ctx.editMessageTextWithMarkdown('❌ Произошла ошибка при загрузке статистики. Попробуйте позже.', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'reminders' }],
                    ],
                },
            });
        }
    }
    async handleDeleteReminder(ctx, reminderId) {
        try {
            const reminder = await this.prisma.reminder.findFirst({
                where: {
                    id: reminderId,
                    userId: ctx.userId,
                },
            });
            if (!reminder) {
                await ctx.editMessageTextWithMarkdown('❌ *Напоминание не найдено*\n\nВозможно, оно уже было удалено.', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔔 К напоминаниям', callback_data: 'reminders' }],
                        ],
                    },
                });
                return;
            }
            await this.prisma.reminder.delete({
                where: {
                    id: reminderId,
                },
            });
            await ctx.editMessageTextWithMarkdown(`✅ *Напоминание удалено*\n\n📝 "${reminder.title}" было успешно удалено из списка напоминаний.`, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✏️ Управление', callback_data: 'manage_reminders' },
                            { text: '🔔 К напоминаниям', callback_data: 'reminders' },
                        ],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error(`Error deleting reminder: ${error}`);
            await ctx.editMessageTextWithMarkdown('❌ Произошла ошибка при удалении напоминания. Попробуйте позже.', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'manage_reminders' }],
                    ],
                },
            });
        }
    }
    async showFocusAITips(ctx) {
        try {
            await ctx.editMessageTextWithMarkdown('🤔 *Анализирую ваши паттерны фокуса...*');
            const aiTips = await this.aiContextService.generatePersonalizedMessage(ctx.userId, 'focus_tips', '');
            await ctx.editMessageTextWithMarkdown(`
🤖 *AI-советы по фокусу:*

${aiTips}

💡 *Хотите персональную помощь?* Просто напишите мне в чат!
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🚀 Начать сессию',
                                callback_data: 'start_pomodoro_session',
                            },
                        ],
                        [{ text: '🔙 К фокус-сессиям', callback_data: 'menu_focus' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error getting AI focus tips:', error);
            await ctx.editMessageTextWithMarkdown(`
❌ *Не удалось получить AI-советы*

Попробуйте позже или напишите мне напрямую в чат!
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 К фокус-сессиям', callback_data: 'menu_focus' }],
                    ],
                },
            });
        }
    }
    async createPayment(ctx, subscriptionType) {
        try {
            const plans = this.paymentService.getSubscriptionPlans();
            const plan = plans[subscriptionType];
            await ctx.editMessageTextWithMarkdown('💳 *Создаю платеж...*');
            const paymentResult = await this.paymentService.createPayment({
                userId: ctx.userId,
                amount: plan.amount,
                description: plan.description,
                subscriptionType: subscriptionType,
                returnUrl: 'https://t.me/daily_check_bot',
            });
            await ctx.editMessageTextWithMarkdown(`
💎 *Оплата ${subscriptionType === 'PREMIUM' ? 'Premium' : 'Premium Plus'}*

💰 **Сумма:** ${plan.amount}₽
📅 **Период:** ${plan.period}

**Что включено:**
${plan.features.map((feature) => `• ${feature}`).join('\n')}

🔗 Для оплаты перейдите по ссылке ниже:
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '💳 Оплатить',
                                url: paymentResult.confirmationUrl,
                            },
                        ],
                        [
                            {
                                text: '🔄 Проверить оплату',
                                callback_data: `check_payment_${paymentResult.paymentId}`,
                            },
                        ],
                        [{ text: '⬅️ Назад', callback_data: 'upgrade_premium' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error creating payment:', error);
            await ctx.editMessageTextWithMarkdown(`
❌ *Ошибка создания платежа*

Попробуйте позже или свяжитесь с поддержкой.
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад', callback_data: 'upgrade_premium' }],
                    ],
                },
            });
        }
    }
    async getOrCreateUser(ctx) {
        try {
            return await this.userService.findByTelegramId(ctx.userId);
        }
        catch (error) {
            const userData = {
                id: ctx.from?.id.toString() || ctx.userId,
                username: ctx.from?.username || undefined,
                firstName: ctx.from?.first_name || undefined,
                lastName: ctx.from?.last_name || undefined,
            };
            return await this.userService.findOrCreateUser(userData);
        }
    }
    async handleXPPurchase(ctx, itemType, cost, itemName, itemId) {
        await ctx.answerCbQuery();
        try {
            const user = await this.userService.findByTelegramId(ctx.userId);
            if (user.totalXp < cost) {
                await ctx.editMessageTextWithMarkdown(`❌ *Недостаточно XP*

Для покупки "${itemName}" нужно ${cost} XP.
У вас: ${user.totalXp} XP
Нужно еще: ${cost - user.totalXp} XP

💪 Выполняйте задачи и привычки для заработка XP!`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⬅️ Назад в магазин', callback_data: 'xp_shop' }],
                        ],
                    },
                });
                return;
            }
            const alreadyOwned = this.checkIfUserOwnsItem(user, itemType, itemId);
            if (alreadyOwned) {
                await ctx.editMessageTextWithMarkdown(`✅ *Уже приобретено*

У вас уже есть "${itemName}".

Выберите что-то другое в магазине!`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⬅️ Назад в магазин', callback_data: 'xp_shop' }],
                        ],
                    },
                });
                return;
            }
            await this.processXPPurchase(user, itemType, itemId);
            await this.userService.updateUserStats(ctx.userId, {
                xpGained: -cost,
            });
            await ctx.editMessageTextWithMarkdown(`🎉 *Покупка успешна!*

Вы приобрели: "${itemName}"
Потрачено: ${cost} XP
Остаток XP: ${user.totalXp - cost}

${this.getItemActivationMessage(itemType)}`, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🛍️ Продолжить покупки', callback_data: 'xp_shop' },
                            { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
                        ],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error(`Error processing XP purchase: ${error}`);
            await ctx.editMessageTextWithMarkdown('❌ Произошла ошибка при покупке. Попробуйте позже.', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад в магазин', callback_data: 'xp_shop' }],
                    ],
                },
            });
        }
    }
    checkIfUserOwnsItem(user, itemType, itemId) {
        switch (itemType) {
            case 'theme':
                return user.unlockedThemes.includes(itemId);
            case 'badge':
            case 'emoji':
            case 'sticker':
                return user.stickers.includes(itemId);
            case 'feature':
                return user.stickers.includes(`feature_${itemId}`);
            default:
                return false;
        }
    }
    async processXPPurchase(user, itemType, itemId) {
        const updateData = {};
        switch (itemType) {
            case 'theme':
                updateData.unlockedThemes = [...user.unlockedThemes, itemId];
                break;
            case 'badge':
            case 'emoji':
            case 'sticker':
                updateData.stickers = [...user.stickers, itemId];
                break;
            case 'feature':
                updateData.stickers = [...user.stickers, `feature_${itemId}`];
                break;
        }
        await this.userService.updateUser(user.id, updateData);
    }
    getItemActivationMessage(itemType) {
        switch (itemType) {
            case 'theme':
                return '🎨 Тема активирована! Вы можете переключиться в настройках.';
            case 'badge':
                return '🏆 Значок добавлен в ваш профиль!';
            case 'emoji':
                return '⚡ Эмодзи доступны в чате!';
            case 'sticker':
                return '🌟 Стикеры добавлены в коллекцию!';
            case 'feature':
                return '🚀 Функция активирована и готова к использованию!';
            default:
                return '✨ Покупка активирована!';
        }
    }
    async completeHabit(ctx, habitId) {
        try {
            await ctx.editMessageTextWithMarkdown(`
✅ *Привычка выполнена!*

🎯 Отличная работа! Вы на пути к формированию полезной привычки.

💡 *Функция выполнения привычек в разработке - скоро будет полноценная система отслеживания!*
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Мои привычки', callback_data: 'habits_list' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error completing habit:', error);
            await ctx.editMessageTextWithMarkdown('❌ Ошибка при выполнении привычки');
        }
    }
    async showAllHabitsList(ctx) {
        try {
            const habits = await this.habitService.findHabitsByUserId(ctx.userId);
            if (habits.length === 0) {
                await ctx.editMessageTextWithMarkdown(`
🔄 *Все привычки*

У вас нет привычек. Добавьте первую! 🎯
        `);
                return;
            }
            let message = `🔄 *Все привычки (${habits.length}):*\n\n`;
            message += `*Выберите привычку для выполнения:*`;
            const keyboard = {
                inline_keyboard: [
                    ...habits.map((habit) => [
                        {
                            text: `✅ ${habit.title.substring(0, 35)}${habit.title.length > 35 ? '...' : ''}`,
                            callback_data: `habit_complete_${habit.id}`,
                        },
                    ]),
                    [{ text: '🔙 Назад к привычкам', callback_data: 'habits_list' }],
                ],
            };
            await ctx.editMessageTextWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        catch (error) {
            this.logger.error('Error showing all habits list:', error);
            await ctx.editMessageTextWithMarkdown('❌ Ошибка при получении списка привычек');
        }
    }
    async showHabitsManagement(ctx) {
        try {
            const habits = await this.habitService.findHabitsByUserId(ctx.userId);
            if (habits.length === 0) {
                await ctx.editMessageTextWithMarkdown(`
🛠️ *Управление привычками*

У вас нет привычек для управления.
        `, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '🔙 Назад к привычкам',
                                    callback_data: 'habits_list',
                                },
                            ],
                        ],
                    },
                });
                return;
            }
            let message = `🛠️ *Управление привычками*\n\n`;
            message += `Выберите привычку для удаления:`;
            const keyboard = {
                inline_keyboard: [
                    ...habits.map((habit) => [
                        {
                            text: `🗑️ ${habit.title.substring(0, 35)}${habit.title.length > 35 ? '...' : ''}`,
                            callback_data: `habit_delete_${habit.id}`,
                        },
                    ]),
                    [{ text: '🔙 Назад к привычкам', callback_data: 'habits_list' }],
                ],
            };
            await ctx.editMessageTextWithMarkdown(message, {
                reply_markup: keyboard,
            });
        }
        catch (error) {
            this.logger.error('Error showing habits management:', error);
            await ctx.editMessageTextWithMarkdown('❌ Ошибка при загрузке управления привычками');
        }
    }
    async confirmHabitDeletion(ctx, habitId) {
        try {
            const habit = await this.habitService.findHabitById(habitId, ctx.userId);
            if (!habit) {
                await ctx.answerCbQuery('❌ Привычка не найдена');
                return;
            }
            await ctx.editMessageTextWithMarkdown(`
⚠️ *Подтвердите удаление*

Вы уверены, что хотите удалить привычку:

📝 *${habit.title}*

⚠️ Это действие нельзя отменить!
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '✅ Да, удалить',
                                callback_data: `confirm_delete_habit_${habitId}`,
                            },
                            {
                                text: '❌ Отмена',
                                callback_data: `cancel_delete_habit_${habitId}`,
                            },
                        ],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error confirming habit deletion:', error);
            await ctx.editMessageTextWithMarkdown('❌ Ошибка при подтверждении удаления');
        }
    }
    async deleteHabit(ctx, habitId) {
        try {
            const habit = await this.habitService.findHabitById(habitId, ctx.userId);
            if (!habit) {
                await ctx.answerCbQuery('❌ Привычка не найдена');
                return;
            }
            await this.habitService.deleteHabit(habitId, ctx.userId);
            await ctx.editMessageTextWithMarkdown(`
✅ *Привычка удалена*

Привычка "${habit.title}" была успешно удалена.
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🔙 К управлению привычками',
                                callback_data: 'habits_manage',
                            },
                        ],
                        [{ text: '🏠 В главное меню', callback_data: 'main_menu' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error deleting habit:', error);
            await ctx.editMessageTextWithMarkdown('❌ Ошибка при удалении привычки', {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🔙 К управлению привычками',
                                callback_data: 'habits_manage',
                            },
                        ],
                    ],
                },
            });
        }
    }
    async confirmTimezone(ctx, timezone) {
        try {
            await this.userService.updateUser(ctx.userId, {
                timezone: timezone,
            });
            await ctx.editMessageTextWithMarkdown(`
✅ *Часовой пояс установлен!*

🕐 Часовой пояс: ${timezone}

Теперь можете создавать задачи и привычки!
      `);
            ctx.session.step = undefined;
            if (ctx.session.pendingAction === 'adding_task') {
                ctx.session.pendingAction = undefined;
                await this.startAddingTask(ctx);
            }
            else if (ctx.session.pendingAction === 'adding_habit') {
                ctx.session.pendingAction = undefined;
                ctx.session.step = 'adding_habit';
                await ctx.editMessageTextWithMarkdown('🔄 *Добавление привычки*\n\nВведите название привычки, которую хотите отслеживать:', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
                        ],
                    },
                });
            }
            else {
                await this.showMainMenu(ctx);
            }
        }
        catch (error) {
            this.logger.error('Error confirming timezone:', error);
            await ctx.editMessageTextWithMarkdown('❌ Ошибка при сохранении часового пояса');
        }
    }
    async showTimezoneList(ctx) {
        const commonTimezones = [
            { name: 'Москва', tz: 'Europe/Moscow' },
            { name: 'СПб', tz: 'Europe/Moscow' },
            { name: 'Екатеринбург', tz: 'Asia/Yekaterinburg' },
            { name: 'Новосибирск', tz: 'Asia/Novosibirsk' },
            { name: 'Владивосток', tz: 'Asia/Vladivostok' },
            { name: 'Астана', tz: 'Asia/Almaty' },
            { name: 'Киев', tz: 'Europe/Kiev' },
            { name: 'Минск', tz: 'Europe/Minsk' },
            { name: 'Лондон', tz: 'Europe/London' },
            { name: 'Париж', tz: 'Europe/Paris' },
            { name: 'Нью-Йорк', tz: 'America/New_York' },
            { name: 'Лос-Анджелес', tz: 'America/Los_Angeles' },
        ];
        await ctx.editMessageTextWithMarkdown(`
🕐 *Выберите часовой пояс*

Выберите ближайший к вам город:`, {
            reply_markup: {
                inline_keyboard: [
                    ...commonTimezones.map((city) => [
                        {
                            text: `🏙️ ${city.name}`,
                            callback_data: `confirm_timezone_${city.tz}`,
                        },
                    ]),
                    [{ text: '🔙 Ввести город вручную', callback_data: 'input_city' }],
                ],
            },
        });
    }
    formatTimeWithTimezone(date, timezone) {
        return date.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timezone || 'Europe/Moscow',
        });
    }
    async startAddingHabit(ctx) {
        const user = await this.userService.findByTelegramId(ctx.userId);
        if (!user.timezone) {
            ctx.session.pendingAction = 'adding_habit';
            await this.askForTimezone(ctx);
            return;
        }
        ctx.session.step = 'adding_habit';
        await ctx.replyWithMarkdown('🔄 *Добавление привычки*\n\nВведите название привычки, которую хотите отслеживать:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
                ],
            },
        });
    }
    async analyzeAndCreateFromVoice(ctx, text) {
        const lowercaseText = text.toLowerCase();
        const isReminder = this.isReminderRequest(text);
        if (isReminder) {
            await this.processReminderFromText(ctx, text);
            return;
        }
        const isHabit = this.isHabitRequest(lowercaseText);
        if (isHabit) {
            const habitName = this.extractHabitName(text);
            await this.createHabitFromVoice(ctx, habitName);
            return;
        }
        const mightBeReminder = /напомни|напоминание|не забыть|вспомнить|помни/i.test(text);
        if (mightBeReminder || text.length > 10) {
            await this.showVoiceAnalysisOptions(ctx, text);
            return;
        }
        const taskName = this.extractTaskName(text);
        await this.createTaskFromVoice(ctx, taskName);
    }
    async showVoiceAnalysisOptions(ctx, text) {
        const encodedText = encodeURIComponent(text);
        await ctx.replyWithMarkdown(`🤔 *Что вы хотели сделать?*

Текст: "${text}"

Выберите действие:`, {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '📝 Создать задачу',
                            callback_data: `create_task_from_voice:${encodedText}`,
                        },
                    ],
                    [
                        {
                            text: '⏰ Создать напоминание',
                            callback_data: `create_reminder_from_voice:${encodedText}`,
                        },
                    ],
                    [
                        {
                            text: '🔄 Создать привычку',
                            callback_data: `create_habit_from_voice:${encodedText}`,
                        },
                    ],
                    [
                        {
                            text: '💬 Спросить у ИИ',
                            callback_data: `ai_chat_from_voice:${encodedText}`,
                        },
                    ],
                    [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
            },
        });
    }
    isHabitRequest(text) {
        const habitPatterns = [
            /привычка/i,
            /каждый\s+(день|час|утро|вечер)/i,
            /ежедневно/i,
            /регулярно/i,
            /постоянно/i,
            /каждое\s+(утро|день|вечер)/i,
            /по\s+\d+\s+раз/i,
            /\d+\s+раз\s+в\s+день/i,
            /утром\s+делать/i,
            /вечером\s+делать/i,
            /каждый\s+час/i,
            /^(пить|делать|читать|заниматься|медитировать|бегать|ходить|спать|просыпаться|есть|готовить|убираться|изучать)\s+.*/i,
        ];
        return habitPatterns.some((pattern) => pattern.test(text));
    }
    extractHabitName(text) {
        return text
            .replace(/добавить\s*(привычку)?/gi, '')
            .replace(/новая\s*привычка/gi, '')
            .replace(/создать\s*(привычку)?/gi, '')
            .replace(/^(делать|пить|читать|заниматься|выполнять)\s+/gi, '')
            .replace(/каждый\s*день/gi, '')
            .replace(/ежедневно/gi, '')
            .replace(/регулярно/gi, '')
            .replace(/каждое\s+(утро|день|вечер)/gi, '')
            .replace(/по\s+\d+\s+раз/gi, '')
            .replace(/\d+\s+раз\s+в\s+день/gi, '')
            .trim();
    }
    extractTaskName(text) {
        return text
            .replace(/добавить\s*(задачу)?/gi, '')
            .replace(/новая\s*задача/gi, '')
            .replace(/создать\s*(задачу)?/gi, '')
            .replace(/^(сделать|выполнить|нужно|надо)\s+/gi, '')
            .replace(/\s+(завтра|послезавтра|сегодня|через\s+\d+\s+\w+|в\s+понедельник|во\s+вторник|в\s+среду|в\s+четверг|в\s+пятницу|в\s+субботу|в\s+воскресенье|на\s+следующей\s+неделе|в\s+следующем\s+месяце|в\s+следующем\s+году)$/gi, '')
            .replace(/(завтра|послезавтра|сегодня)\s+/gi, '')
            .replace(/через\s+\d+\s+\w+\s+/gi, '')
            .replace(/на\s+следующей\s+неделе\s+/gi, '')
            .replace(/в\s+следующем\s+(месяце|году)\s+/gi, '')
            .replace(/в\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)\s+/gi, '')
            .trim();
    }
    async createHabitFromVoice(ctx, habitName) {
        if (!habitName || habitName.length < 2) {
            await ctx.replyWithMarkdown('⚠️ Не удалось извлечь название привычки. Попробуйте еще раз.');
            return;
        }
        try {
            await this.habitService.createHabit({
                userId: ctx.userId,
                title: habitName,
                description: undefined,
                frequency: 'DAILY',
                targetCount: 1,
            });
            await ctx.replyWithMarkdown(`✅ *Привычка "${habitName}" создана!*

🎯 Теперь вы можете отслеживать её выполнение в разделе "Мои привычки".

*Напоминание:* Регулярность - ключ к формированию привычек!`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Мои привычки', callback_data: 'menu_habits' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error(`Error creating habit from voice: ${error}`);
            await ctx.replyWithMarkdown('❌ Произошла ошибка при создании привычки. Попробуйте позже.');
        }
    }
    async createTaskFromVoice(ctx, taskName) {
        if (!taskName || taskName.length < 2) {
            await ctx.replyWithMarkdown('⚠️ Не удалось извлечь название задачи. Попробуйте еще раз.');
            return;
        }
        try {
            const user = await this.getOrCreateUser(ctx);
            const limitCheck = await this.billingService.checkUsageLimit(ctx.userId, 'dailyTasks');
            if (!limitCheck.allowed) {
                await ctx.replyWithMarkdown(limitCheck.message || '🚫 Превышен лимит задач');
                return;
            }
            const task = await this.taskService.createTask({
                userId: ctx.userId,
                title: taskName,
                description: undefined,
                priority: 'MEDIUM',
            });
            await this.billingService.incrementUsage(ctx.userId, 'dailyTasks');
            await ctx.replyWithMarkdown(`✅ *Задача "${taskName}" создана!*

📋 ID: ${task.id}

Задачу можно найти в разделе "Мои задачи".`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📝 Мои задачи', callback_data: 'menu_tasks' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error(`Error creating task from voice: ${error}`);
            await ctx.replyWithMarkdown('❌ Произошла ошибка при создании задачи. Попробуйте позже.');
        }
    }
    startDailyMotivation(userId, dependencyType) {
        const sendTime = '21:00';
        this.logger.log(`Starting daily motivation for user ${userId}, dependency: ${dependencyType}, time: ${sendTime}`);
        setTimeout(async () => {
            try {
                const message = await this.generateMotivationalMessage(dependencyType);
                await this.bot.telegram.sendMessage(userId, message, {
                    parse_mode: 'Markdown',
                });
            }
            catch (error) {
                this.logger.error(`Error sending first motivational message: ${error}`);
            }
        }, 5000);
    }
    async generateMotivationalMessage(dependencyType) {
        const messages = {
            smoking: [
                '🚭 *Каждый день без курения - это победа!*\n\nТвои легкие уже начали очищаться. Продолжай!',
                '💪 *Ты сильнее сигарет!*\n\nВспомни, зачем ты начал этот путь. Твое здоровье важнее временного желания.',
                '🌟 *День за днем ты становишься свободнее!*\n\nКаждый час без курения - это шаг к новой жизни.',
            ],
            alcohol: [
                '🏆 *Трезвость - твоя суперсила!*\n\nТы контролируешь свою жизнь, а не алкоголь контролирует тебя.',
                '💎 *Каждый трезвый день делает тебя сильнее!*\n\nТвой разум становится яснее, а цели ближе.',
                '🌅 *Новый день - новые возможности!*\n\nБез алкоголя ты видишь жизнь в ярких красках.',
            ],
            social: [
                '📚 *Время в соцсетях = время для твоих целей!*\n\nИспользуй это время для саморазвития.',
                '🎯 *Реальная жизнь интереснее виртуальной!*\n\nСосредоточься на том, что действительно важно.',
                '💪 *Ты контролируешь технологии, а не наоборот!*\n\nУстанови границы и живи осознанно.',
            ],
            gaming: [
                '⚡ *Твоя реальная жизнь - самая важная игра!*\n\nРазвивай навыки в реальном мире.',
                '🏆 *Каждый день без игр - это левел ап в жизни!*\n\nТы развиваешься как личность.',
                '🎯 *Направь свою энергию на реальные достижения!*\n\nТы способен на великие дела.',
            ],
            shopping: [
                '💰 *Каждая несделанная покупка = сэкономленные деньги!*\n\nТвои финансы под контролем.',
                '🎯 *Покупай осознанно, а не импульсивно!*\n\nСпроси себя: это нужно или хочется?',
                '💪 *Ты сильнее желания покупать!*\n\nИстинное счастье не в вещах.',
            ],
            sweets: [
                '🍎 *Здоровое питание - здоровое тело!*\n\nКаждый отказ от сладкого делает тебя сильнее.',
                '💪 *Ты контролируешь свои желания!*\n\nТвоя сила воли растет с каждым днем.',
                '⚡ *Энергия от здоровой еды лучше сахарного взрыва!*\n\nПочувствуй разницу.',
            ],
            default: [
                '💪 *Ты на правильном пути!*\n\nКаждый день делает тебя сильнее.',
                '🌟 *Верь в себя!*\n\nТы способен преодолеть любые трудности.',
                '🚀 *Продолжай движение вперед!*\n\nТвои усилия не напрасны.',
            ],
        };
        const messageArray = messages[dependencyType] || messages.default;
        const randomMessage = messageArray[Math.floor(Math.random() * messageArray.length)];
        return `🤖 *Ежедневная мотивация*\n\n${randomMessage}\n\n#МотивацияДня #БорьбаСЗависимостью`;
    }
    async handleLongTermReminder(ctx, reminderText, targetDate, amount, unit) {
        if (!ctx.from) {
            console.error('No user context found for long-term reminder');
            return;
        }
        const userId = ctx.from.id;
        await this.updateUserActivity(userId.toString());
        const now = new Date();
        const timeDifference = targetDate.getTime() - now.getTime();
        const daysUntilReminder = Math.ceil(timeDifference / (1000 * 60 * 60 * 24));
        let reminderMessage = '';
        let confirmationMessage = '';
        if (unit === 'specific') {
            confirmationMessage = `⏰ *Напоминание установлено*\n\n📝 ${reminderText}\n📅 ${targetDate.toLocaleDateString('ru-RU', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            })}`;
        }
        else {
            const unitText = this.getUnitText(amount, unit);
            confirmationMessage = `⏰ *Напоминание установлено*\n\n📝 ${reminderText}\n⏳ Через ${amount} ${unitText}\n📅 ${targetDate.toLocaleDateString('ru-RU', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            })}`;
        }
        await ctx.replyWithMarkdown(confirmationMessage);
        console.log(`Long-term reminder set for user ${userId}:`, {
            text: reminderText,
            targetDate: targetDate.toISOString(),
            amount,
            unit,
            daysUntil: daysUntilReminder,
        });
    }
    parseSpecificTimeExpressions(text) {
        const now = new Date();
        let targetDate = new Date(now);
        let matched = false;
        let matchedPattern = '';
        if (/завтра/i.test(text)) {
            targetDate.setDate(targetDate.getDate() + 1);
            matched = true;
            matchedPattern = 'завтра';
        }
        else if (/послезавтра/i.test(text)) {
            targetDate.setDate(targetDate.getDate() + 2);
            matched = true;
            matchedPattern = 'послезавтра';
        }
        else if (/на\s*следующей\s*неделе/i.test(text)) {
            const daysUntilNextWeek = 7 - now.getDay() + 1;
            targetDate.setDate(targetDate.getDate() + daysUntilNextWeek);
            matched = true;
            matchedPattern = 'на следующей неделе';
        }
        else if (/в\s*следующем\s*месяце/i.test(text)) {
            targetDate.setMonth(targetDate.getMonth() + 1);
            targetDate.setDate(1);
            matched = true;
            matchedPattern = 'в следующем месяце';
        }
        else if (/в\s*следующем\s*году/i.test(text)) {
            targetDate.setFullYear(targetDate.getFullYear() + 1);
            targetDate.setMonth(0);
            targetDate.setDate(1);
            matched = true;
            matchedPattern = 'в следующем году';
        }
        else if (/на\s*этой\s*неделе/i.test(text)) {
            matched = true;
            matchedPattern = 'на этой неделе';
        }
        else if (/в\s*этом\s*месяце/i.test(text)) {
            matched = true;
            matchedPattern = 'в этом месяце';
        }
        if (!matched) {
            return null;
        }
        const reminderText = text
            .replace(/напомни\s*(мне)?/gi, '')
            .replace(/напомню\s*(тебе|вам)?/gi, '')
            .replace(/завтра|послезавтра|на\s*следующей\s*неделе|в\s*следующем\s*месяце|в\s*следующем\s*году|на\s*этой\s*неделе|в\s*этом\s*месяце/gi, '')
            .trim();
        return { targetDate, reminderText };
    }
    getUnitText(amount, unit) {
        const lastDigit = amount % 10;
        const lastTwoDigits = amount % 100;
        if (unit.includes('день')) {
            if (lastTwoDigits >= 11 && lastTwoDigits <= 14)
                return 'дней';
            if (lastDigit === 1)
                return 'день';
            if (lastDigit >= 2 && lastDigit <= 4)
                return 'дня';
            return 'дней';
        }
        if (unit.includes('недел')) {
            if (lastTwoDigits >= 11 && lastTwoDigits <= 14)
                return 'недель';
            if (lastDigit === 1)
                return 'неделю';
            if (lastDigit >= 2 && lastDigit <= 4)
                return 'недели';
            return 'недель';
        }
        if (unit.includes('месяц')) {
            if (lastTwoDigits >= 11 && lastTwoDigits <= 14)
                return 'месяцев';
            if (lastDigit === 1)
                return 'месяц';
            if (lastDigit >= 2 && lastDigit <= 4)
                return 'месяца';
            return 'месяцев';
        }
        if (unit.includes('год') || unit.includes('лет')) {
            if (lastTwoDigits >= 11 && lastTwoDigits <= 14)
                return 'лет';
            if (lastDigit === 1)
                return 'год';
            if (lastDigit >= 2 && lastDigit <= 4)
                return 'года';
            return 'лет';
        }
        return unit;
    }
    async handleLongTermTask(ctx, taskText, targetDate, amount, unit) {
        if (!ctx.from) {
            console.error('No user context found for long-term task');
            return;
        }
        const userId = ctx.from.id;
        await this.updateUserActivity(userId.toString());
        const now = new Date();
        const timeDifference = targetDate.getTime() - now.getTime();
        const daysUntilTask = Math.ceil(timeDifference / (1000 * 60 * 60 * 24));
        let confirmationMessage = '';
        if (unit === 'specific') {
            confirmationMessage = `✅ *Задача с дедлайном создана*\n\n📝 ${taskText}\n📅 Срок: ${targetDate.toLocaleDateString('ru-RU', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            })}`;
        }
        else {
            const unitText = this.getUnitText(amount, unit);
            confirmationMessage = `✅ *Задача с дедлайном создана*\n\n📝 ${taskText}\n⏳ Срок: через ${amount} ${unitText}\n📅 ${targetDate.toLocaleDateString('ru-RU', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            })}`;
        }
        try {
            const user = await this.userService.findByTelegramId(userId.toString());
            if (!user.timezone) {
                ctx.session.step = 'waiting_for_task_title';
                ctx.session.tempData = {
                    taskTitle: taskText,
                    deadline: targetDate.toISOString(),
                    isLongTerm: true,
                };
                await this.askForTimezone(ctx);
                return;
            }
            const task = await this.taskService.createTask({
                userId: userId.toString(),
                title: taskText.trim(),
                dueDate: targetDate,
            });
            await ctx.replyWithMarkdown(confirmationMessage +
                `\n\n💡 *Подсказка:* Задача добавлена в ваш список и будет напоминать о приближении дедлайна.`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📝 Мои задачи', callback_data: 'tasks_list' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        }
        catch (error) {
            console.error(`Error creating long-term task: ${error}`);
            await ctx.replyWithMarkdown('❌ Произошла ошибка при создании задачи. Попробуйте позже.');
        }
        console.log(`Long-term task created for user ${userId}:`, {
            text: taskText,
            targetDate: targetDate.toISOString(),
            amount,
            unit,
            daysUntil: daysUntilTask,
        });
    }
    async createTaskWithDeadline(ctx, taskText, targetDate) {
        if (!ctx.from) {
            console.error('No user context found for task with deadline');
            return;
        }
        const userId = ctx.from.id;
        try {
            const user = await this.userService.findByTelegramId(userId.toString());
            if (!user.timezone) {
                ctx.session.step = 'waiting_for_task_title';
                ctx.session.tempData = {
                    taskTitle: taskText,
                    deadline: targetDate.toISOString(),
                };
                await this.askForTimezone(ctx);
                return;
            }
            const task = await this.taskService.createTask({
                userId: userId.toString(),
                title: taskText.trim(),
                dueDate: targetDate,
            });
            const confirmationMessage = `✅ *Задача с дедлайном создана*\n\n📝 ${taskText}\n⏰ Срок: ${targetDate.toLocaleDateString('ru-RU', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            })}`;
            await ctx.replyWithMarkdown(confirmationMessage, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📝 Мои задачи', callback_data: 'tasks_list' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
            await this.updateUserActivity(userId.toString());
        }
        catch (error) {
            console.error(`Error creating task with deadline: ${error}`);
            await ctx.replyWithMarkdown('❌ Произошла ошибка при создании задачи. Попробуйте позже.');
        }
    }
    parseSpecificTimeExpressionsForTasks(text) {
        const now = new Date();
        let targetDate = new Date(now);
        let matched = false;
        let matchedPattern = '';
        if (/завтра/i.test(text)) {
            targetDate.setDate(targetDate.getDate() + 1);
            matched = true;
            matchedPattern = 'завтра';
        }
        else if (/послезавтра/i.test(text)) {
            targetDate.setDate(targetDate.getDate() + 2);
            matched = true;
            matchedPattern = 'послезавтра';
        }
        else if (/на\s*следующей\s*неделе/i.test(text)) {
            const daysUntilNextWeek = 7 - now.getDay() + 1;
            targetDate.setDate(targetDate.getDate() + daysUntilNextWeek);
            matched = true;
            matchedPattern = 'на следующей неделе';
        }
        else if (/в\s*следующем\s*месяце/i.test(text)) {
            targetDate.setMonth(targetDate.getMonth() + 1);
            targetDate.setDate(1);
            matched = true;
            matchedPattern = 'в следующем месяце';
        }
        else if (/в\s*следующем\s*году/i.test(text)) {
            targetDate.setFullYear(targetDate.getFullYear() + 1);
            targetDate.setMonth(0);
            targetDate.setDate(1);
            matched = true;
            matchedPattern = 'в следующем году';
        }
        if (!matched) {
            return null;
        }
        const taskText = text
            .replace(/завтра|послезавтра|на\s*следующей\s*неделе|в\s*следующем\s*месяце|в\s*следующем\s*году/gi, '')
            .trim();
        return { targetDate, taskText };
    }
    async sendMessageToUser(userId, text, options) {
        try {
            await this.bot.telegram.sendMessage(userId, text, options);
            this.logger.log(`Message sent to user ${userId}`);
        }
        catch (error) {
            this.logger.error(`Failed to send message to user ${userId}:`, error);
            throw error;
        }
    }
    async completeHabitFromNotification(ctx, habitId) {
        try {
            const userId = ctx.from?.id.toString();
            if (!userId)
                return;
            const result = await this.habitService.completeHabit(habitId, userId);
            const message = `✅ Привычка "${result.habit.title}" выполнена!\n\n🔥 Так держать! Продолжайте в том же духе!\n\n⭐ Получено опыта: ${result.xpGained}`;
            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Мои привычки', callback_data: 'habits_list' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error completing habit from notification:', error);
            await ctx.editMessageText('❌ Ошибка при выполнении привычки. Попробуйте позже.');
        }
    }
    async snoozeHabitFromNotification(ctx, habitId, minutes) {
        try {
            const delayMs = minutes * 60 * 1000;
            setTimeout(async () => {
                const habit = await this.prisma.habit.findUnique({
                    where: { id: habitId },
                    include: { user: true },
                });
                if (habit) {
                    const message = `⏰ *Напоминание о привычке*\n\n🎯 ${habit.title}\n\nВремя выполнить вашу привычку!`;
                    const keyboard = {
                        inline_keyboard: [
                            [
                                {
                                    text: '✅ Выполнил',
                                    callback_data: `complete_habit_${habitId}`,
                                },
                                {
                                    text: '⏰ Отложить на 15 мин',
                                    callback_data: `snooze_habit_${habitId}_15`,
                                },
                            ],
                            [
                                {
                                    text: '📊 Статистика',
                                    callback_data: `habit_stats_${habitId}`,
                                },
                                {
                                    text: '❌ Пропустить сегодня',
                                    callback_data: `skip_habit_${habitId}`,
                                },
                            ],
                        ],
                    };
                    await this.sendMessageToUser(parseInt(habit.user.id), message, {
                        parse_mode: 'Markdown',
                        reply_markup: keyboard,
                    });
                }
            }, delayMs);
            await ctx.editMessageText(`⏰ Напоминание отложено на ${minutes} минут.\n\nМы напомним вам позже!`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Мои привычки', callback_data: 'habits_list' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error snoozing habit notification:', error);
            await ctx.editMessageText('❌ Ошибка при отложении напоминания.');
        }
    }
    async showHabitStatsFromNotification(ctx, habitId) {
        try {
            const habit = await this.prisma.habit.findUnique({
                where: { id: habitId },
            });
            if (!habit) {
                await ctx.editMessageText('❌ Привычка не найдена.');
                return;
            }
            const streak = habit.currentStreak || 0;
            const bestStreak = habit.maxStreak || 0;
            const totalCompletions = habit.totalCompletions || 0;
            const message = `📊 *Статистика привычки "${habit.title}"*

✅ Всего выполнений: ${totalCompletions}
🔥 Текущая серия: ${streak} дней
🏆 Лучшая серия: ${bestStreak} дней
📅 Частота: ${habit.frequency}

Продолжайте в том же духе! 💪`;
            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '✅ Выполнить сейчас',
                                callback_data: `complete_habit_${habitId}`,
                            },
                        ],
                        [{ text: '🔄 Мои привычки', callback_data: 'habits_list' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error showing habit stats from notification:', error);
            await ctx.editMessageText('❌ Ошибка при получении статистики.');
        }
    }
    async skipHabitFromNotification(ctx, habitId) {
        try {
            const habit = await this.prisma.habit.findUnique({
                where: { id: habitId },
            });
            if (!habit) {
                await ctx.editMessageText('❌ Привычка не найдена.');
                return;
            }
            const message = `⏭️ Привычка "${habit.title}" пропущена на сегодня.

Не расстраивайтесь! Завтра новый день - новые возможности! 🌅`;
            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Мои привычки', callback_data: 'habits_list' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error skipping habit from notification:', error);
            await ctx.editMessageText('❌ Ошибка при пропуске привычки.');
        }
    }
    async showReminderSetup(ctx, habitId) {
        try {
            const habit = await this.prisma.habit.findUnique({
                where: { id: habitId },
            });
            if (!habit) {
                await ctx.editMessageText('❌ Привычка не найдена.');
                return;
            }
            const message = `⏰ *Настройка напоминаний*\n\n🎯 Привычка: ${habit.title}\n\nВыберите интервал напоминаний:`;
            const keyboard = {
                inline_keyboard: [
                    [
                        {
                            text: '⏰ Каждый час',
                            callback_data: `set_reminder_${habitId}_hourly`,
                        },
                        {
                            text: '🕐 Каждые 2 часа',
                            callback_data: `set_reminder_${habitId}_2hours`,
                        },
                    ],
                    [
                        {
                            text: '🕓 Каждые 3 часа',
                            callback_data: `set_reminder_${habitId}_3hours`,
                        },
                        {
                            text: '🕕 Каждые 6 часов',
                            callback_data: `set_reminder_${habitId}_6hours`,
                        },
                    ],
                    [
                        {
                            text: '🌅 Утром (09:00)',
                            callback_data: `set_reminder_${habitId}_morning`,
                        },
                        {
                            text: '🌆 Вечером (19:00)',
                            callback_data: `set_reminder_${habitId}_evening`,
                        },
                    ],
                    [
                        {
                            text: '📅 Каждый день (12:00)',
                            callback_data: `set_reminder_${habitId}_daily`,
                        },
                        {
                            text: '🗓️ Каждую неделю',
                            callback_data: `set_reminder_${habitId}_weekly`,
                        },
                    ],
                    [{ text: '🔙 Назад к привычкам', callback_data: 'habits_list' }],
                ],
            };
            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard,
            });
        }
        catch (error) {
            this.logger.error('Error showing reminder setup:', error);
            await ctx.editMessageText('❌ Ошибка при настройке напоминаний.');
        }
    }
    async setHabitReminder(ctx, habitId, interval) {
        try {
            let reminderTime = '';
            let intervalText = '';
            let nextReminder = '';
            const now = new Date();
            const currentTime = now.toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
            });
            switch (interval) {
                case 'hourly':
                    reminderTime = 'каждый час';
                    intervalText = 'каждый час';
                    const nextHour = new Date(now);
                    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
                    nextReminder = nextHour.toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                    });
                    break;
                case '2hours':
                    reminderTime = 'каждые 2 часа';
                    intervalText = 'каждые 2 часа';
                    const next2Hours = new Date(now);
                    next2Hours.setHours(next2Hours.getHours() + 2, 0, 0, 0);
                    nextReminder = next2Hours.toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                    });
                    break;
                case '3hours':
                    reminderTime = 'каждые 3 часа';
                    intervalText = 'каждые 3 часа';
                    const next3Hours = new Date(now);
                    next3Hours.setHours(next3Hours.getHours() + 3, 0, 0, 0);
                    nextReminder = next3Hours.toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                    });
                    break;
                case '6hours':
                    reminderTime = 'каждые 6 часов';
                    intervalText = 'каждые 6 часов';
                    const next6Hours = new Date(now);
                    next6Hours.setHours(next6Hours.getHours() + 6, 0, 0, 0);
                    nextReminder = next6Hours.toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                    });
                    break;
                case 'morning':
                    reminderTime = '09:00';
                    intervalText = 'утром в 9:00';
                    const tomorrow = new Date(now);
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    tomorrow.setHours(9, 0, 0, 0);
                    nextReminder = `завтра в ${tomorrow.toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                    })}`;
                    break;
                case 'evening':
                    reminderTime = '19:00';
                    intervalText = 'вечером в 19:00';
                    const evening = new Date(now);
                    if (now.getHours() >= 19) {
                        evening.setDate(evening.getDate() + 1);
                    }
                    evening.setHours(19, 0, 0, 0);
                    const isToday = evening.getDate() === now.getDate();
                    nextReminder = `${isToday ? 'сегодня' : 'завтра'} в 19:00`;
                    break;
                case 'daily':
                    reminderTime = '12:00';
                    intervalText = 'каждый день в 12:00';
                    const noon = new Date(now);
                    if (now.getHours() >= 12) {
                        noon.setDate(noon.getDate() + 1);
                    }
                    noon.setHours(12, 0, 0, 0);
                    const isTodayNoon = noon.getDate() === now.getDate();
                    nextReminder = `${isTodayNoon ? 'сегодня' : 'завтра'} в 12:00`;
                    break;
                case 'weekly':
                    reminderTime = '12:00';
                    intervalText = 'каждую неделю в понедельник в 12:00';
                    const nextMonday = new Date(now);
                    const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
                    nextMonday.setDate(now.getDate() + daysUntilMonday);
                    nextMonday.setHours(12, 0, 0, 0);
                    nextReminder = `в понедельник в 12:00`;
                    break;
            }
            const habit = await this.prisma.habit.update({
                where: { id: habitId },
                data: { reminderTime },
            });
            const message = `✅ *Напоминание настроено!*\n\n🎯 Привычка: ${habit.title}\n⏰ Интервал: ${intervalText}\n\n🕒 Следующее уведомление: **${nextReminder}**\n\nТеперь вы будете получать напоминания о выполнении этой привычки!`;
            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🧪 Тест напоминания',
                                callback_data: `complete_habit_${habitId}`,
                            },
                        ],
                        [{ text: '🔄 Мои привычки', callback_data: 'habits_list' }],
                    ],
                },
            });
            try {
                const notificationService = require('../services/notification.service').NotificationService;
                if (notificationService) {
                    this.logger.log(`Starting notifications for habit ${habitId} with interval ${intervalText}`);
                }
            }
            catch (error) {
                this.logger.warn('Could not start notifications immediately:', error.message);
            }
            this.logger.log(`Reminder set for habit ${habitId}: ${intervalText} - Next: ${nextReminder}`);
        }
        catch (error) {
            this.logger.error('Error setting habit reminder:', error);
            await ctx.editMessageText('❌ Ошибка при настройке напоминания.');
        }
    }
    calculateNextReminderTime(reminderTime) {
        const now = new Date();
        if (reminderTime.includes('каждый час') || reminderTime === 'hourly') {
            const nextHour = new Date(now);
            nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
            return nextHour.toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
            });
        }
        if (reminderTime.includes('каждые 2 часа') || reminderTime === '2hours') {
            const next2Hours = new Date(now);
            next2Hours.setHours(next2Hours.getHours() + 2, 0, 0, 0);
            return next2Hours.toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
            });
        }
        if (reminderTime.includes('каждые 3 часа') || reminderTime === '3hours') {
            const next3Hours = new Date(now);
            next3Hours.setHours(next3Hours.getHours() + 3, 0, 0, 0);
            return next3Hours.toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
            });
        }
        if (reminderTime.includes('каждые 6 часов') || reminderTime === '6hours') {
            const next6Hours = new Date(now);
            next6Hours.setHours(next6Hours.getHours() + 6, 0, 0, 0);
            return next6Hours.toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
            });
        }
        const timeMatch = reminderTime.match(/(\d{1,2}):(\d{2})/);
        if (timeMatch) {
            const [, hours, minutes] = timeMatch;
            const targetTime = new Date(now);
            targetTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
            if (targetTime <= now) {
                targetTime.setDate(targetTime.getDate() + 1);
                return `завтра в ${targetTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
            }
            else {
                return `сегодня в ${targetTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
            }
        }
        return 'время не определено';
    }
    extractTimeIntervalFromText(text) {
        const now = new Date();
        const lowerText = text.toLowerCase();
        if (lowerText.includes('каждый час') || lowerText.includes('ежечасно')) {
            const nextHour = new Date(now);
            nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
            return {
                interval: 'каждый час',
                nextTime: nextHour.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждые два часа') ||
            lowerText.includes('каждые 2 часа')) {
            const next2Hours = new Date(now);
            next2Hours.setHours(next2Hours.getHours() + 2, 0, 0, 0);
            return {
                interval: 'каждые 2 часа',
                nextTime: next2Hours.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждые три часа') ||
            lowerText.includes('каждые 3 часа')) {
            const next3Hours = new Date(now);
            next3Hours.setHours(next3Hours.getHours() + 3, 0, 0, 0);
            return {
                interval: 'каждые 3 часа',
                nextTime: next3Hours.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждые четыре часа') ||
            lowerText.includes('каждые 4 часа')) {
            const next4Hours = new Date(now);
            next4Hours.setHours(next4Hours.getHours() + 4, 0, 0, 0);
            return {
                interval: 'каждые 4 часа',
                nextTime: next4Hours.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждые пять часов') ||
            lowerText.includes('каждые 5 часов')) {
            const next5Hours = new Date(now);
            next5Hours.setHours(next5Hours.getHours() + 5, 0, 0, 0);
            return {
                interval: 'каждые 5 часов',
                nextTime: next5Hours.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждые шесть часов') ||
            lowerText.includes('каждые 6 часов')) {
            const next6Hours = new Date(now);
            next6Hours.setHours(next6Hours.getHours() + 6, 0, 0, 0);
            return {
                interval: 'каждые 6 часов',
                nextTime: next6Hours.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждую минуту') ||
            lowerText.includes('каждая минута')) {
            const nextMin = new Date(now);
            nextMin.setMinutes(nextMin.getMinutes() + 1);
            return {
                interval: 'каждую минуту',
                nextTime: nextMin.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждые две минуты') ||
            lowerText.includes('каждые 2 минуты')) {
            const next2Min = new Date(now);
            next2Min.setMinutes(next2Min.getMinutes() + 2);
            return {
                interval: 'каждые 2 минуты',
                nextTime: next2Min.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждые три минуты') ||
            lowerText.includes('каждые 3 минуты')) {
            const next3Min = new Date(now);
            next3Min.setMinutes(next3Min.getMinutes() + 3);
            return {
                interval: 'каждые 3 минуты',
                nextTime: next3Min.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждые пять минут') ||
            lowerText.includes('каждые 5 минут')) {
            const next5Min = new Date(now);
            next5Min.setMinutes(next5Min.getMinutes() + 5);
            return {
                interval: 'каждые 5 минут',
                nextTime: next5Min.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждые десять минут') ||
            lowerText.includes('каждые 10 минут')) {
            const next10Min = new Date(now);
            next10Min.setMinutes(next10Min.getMinutes() + 10);
            return {
                interval: 'каждые 10 минут',
                nextTime: next10Min.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждые 15 минут') ||
            lowerText.includes('каждую четверть часа')) {
            const next15Min = new Date(now);
            next15Min.setMinutes(next15Min.getMinutes() + 15);
            return {
                interval: 'каждые 15 минут',
                nextTime: next15Min.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждые 30 минут') ||
            lowerText.includes('каждые полчаса')) {
            const next30Min = new Date(now);
            next30Min.setMinutes(next30Min.getMinutes() + 30);
            return {
                interval: 'каждые 30 минут',
                nextTime: next30Min.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
            };
        }
        if (lowerText.includes('каждый день') || lowerText.includes('ежедневно')) {
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9, 0, 0, 0);
            return {
                interval: 'каждый день',
                nextTime: `завтра в ${tomorrow.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`,
            };
        }
        return null;
    }
    async handleIntervalReminder(ctx, reminderText, intervalMinutes) {
        try {
            const limitCheck = await this.billingService.checkUsageLimit(ctx.userId, 'dailyReminders');
            if (!limitCheck.allowed) {
                await ctx.replyWithMarkdown(limitCheck.message || '🚫 Превышен лимит напоминаний', {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '💎 Обновиться до Premium',
                                    callback_data: 'upgrade_premium',
                                },
                            ],
                            [{ text: '📊 Мои лимиты', callback_data: 'show_limits' }],
                        ],
                    },
                });
                return;
            }
            const existingReminder = this.activeIntervalReminders.get(ctx.userId);
            if (existingReminder) {
                await ctx.replyWithMarkdown(`
⚠️ *У вас уже активно интервальное напоминание*

📝 Текущее: "${existingReminder.reminderText}"
⏱️ Интервал: каждые ${existingReminder.intervalMinutes} мин
📊 Отправлено: ${existingReminder.count} раз

Хотите заменить его новым?
          `, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '✅ Заменить',
                                    callback_data: `replace_interval_${intervalMinutes}_${Buffer.from(reminderText).toString('base64')}`,
                                },
                                {
                                    text: '❌ Отменить',
                                    callback_data: 'cancel_interval_setup',
                                },
                            ],
                            [
                                {
                                    text: '🛑 Остановить текущее',
                                    callback_data: 'stop_interval_reminder',
                                },
                            ],
                        ],
                    },
                });
                return;
            }
            await this.startIntervalReminder(ctx, reminderText, intervalMinutes);
        }
        catch (error) {
            this.logger.error('Error handling interval reminder:', error);
            await ctx.replyWithMarkdown(`
❌ *Ошибка создания интервального напоминания*

Не удалось создать интервальное напоминание. Попробуйте ещё раз.
      `);
        }
    }
    async startIntervalReminder(ctx, reminderText, intervalMinutes) {
        try {
            const startTime = new Date();
            let count = 0;
            const intervalId = setInterval(async () => {
                count++;
                try {
                    await ctx.telegram.sendMessage(ctx.userId, `🔔 *Интервальное напоминание #${count}*\n\n${reminderText}\n\n⏱️ Следующее через ${intervalMinutes} мин`, { parse_mode: 'Markdown' });
                    const reminder = this.activeIntervalReminders.get(ctx.userId);
                    if (reminder) {
                        reminder.count = count;
                    }
                }
                catch (error) {
                    this.logger.error('Error sending interval reminder:', error);
                    this.stopIntervalReminder(ctx.userId);
                }
            }, intervalMinutes * 60 * 1000);
            this.activeIntervalReminders.set(ctx.userId, {
                intervalId,
                reminderText,
                intervalMinutes,
                startTime,
                count: 0,
            });
            await this.billingService.incrementUsage(ctx.userId, 'dailyReminders');
            const usageInfo = await this.billingService.checkUsageLimit(ctx.userId, 'dailyReminders');
            const intervalText = intervalMinutes < 60
                ? `${intervalMinutes} минут`
                : `${Math.floor(intervalMinutes / 60)} час${intervalMinutes === 60 ? '' : 'а'}`;
            await ctx.replyWithMarkdown(`
🔄 *Интервальное напоминание запущено!*

📝 **Текст:** ${reminderText}
⏱️ **Интервал:** каждые ${intervalText}
🕐 **Начато:** ${startTime.toLocaleTimeString('ru-RU')}

📊 **Использовано:** ${usageInfo.current}/${usageInfo.limit === -1 ? '∞' : usageInfo.limit} напоминаний

🔔 Первое напоминание через ${intervalText}!
        `, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🛑 Остановить',
                                callback_data: 'stop_interval_reminder',
                            },
                            {
                                text: '📊 Статус',
                                callback_data: 'interval_status',
                            },
                        ],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                    ],
                },
            });
        }
        catch (error) {
            this.logger.error('Error starting interval reminder:', error);
            throw error;
        }
    }
    stopIntervalReminder(userId) {
        const reminder = this.activeIntervalReminders.get(userId);
        if (reminder) {
            clearInterval(reminder.intervalId);
            this.activeIntervalReminders.delete(userId);
            return true;
        }
        return false;
    }
};
exports.TelegramBotService = TelegramBotService;
exports.TelegramBotService = TelegramBotService = TelegramBotService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(9, (0, common_1.Inject)((0, common_1.forwardRef)(() => notification_service_1.NotificationService))),
    __metadata("design:paramtypes", [config_1.ConfigService,
        user_service_1.UserService,
        openai_service_1.OpenAIService,
        task_service_1.TaskService,
        habit_service_1.HabitService,
        billing_service_1.BillingService,
        ai_context_service_1.AiContextService,
        payment_service_1.PaymentService,
        prisma_service_1.PrismaService,
        notification_service_1.NotificationService])
], TelegramBotService);
//# sourceMappingURL=telegram-bot.service.js.map