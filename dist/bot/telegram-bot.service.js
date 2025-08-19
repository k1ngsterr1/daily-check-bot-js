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
var TelegramBotService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramBotService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const telegraf_1 = require("telegraf");
const user_service_1 = require("../services/user.service");
const openai_service_1 = require("../services/openai.service");
const task_service_1 = require("../services/task.service");
let TelegramBotService = TelegramBotService_1 = class TelegramBotService {
    configService;
    userService;
    openaiService;
    taskService;
    logger = new common_1.Logger(TelegramBotService_1.name);
    bot;
    constructor(configService, userService, openaiService, taskService) {
        this.configService = configService;
        this.userService = userService;
        this.openaiService = openaiService;
        this.taskService = taskService;
        const token = this.configService.get('bot.token');
        if (!token) {
            throw new Error('BOT_TOKEN is not provided');
        }
        this.bot = new telegraf_1.Telegraf(token);
        this.setupMiddleware();
        this.setupHandlers();
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
                await this.userService.findOrCreateUser({
                    id: ctx.from.id.toString(),
                    username: ctx.from.username,
                    firstName: ctx.from.first_name,
                    lastName: ctx.from.last_name,
                });
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
    setupHandlers() {
        this.bot.start(async (ctx) => {
            const user = await this.userService.findByTelegramId(ctx.userId);
            if (!user.onboardingPassed) {
                await this.startOnboarding(ctx);
            }
            else {
                await this.showMainMenu(ctx);
            }
        });
        this.bot.help(async (ctx) => {
            await ctx.replyWithMarkdown(`
🤖 *DailyCheck Bot - Ваш персональный помощник продуктивности*

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
        this.bot.action('onboarding_start', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showOnboardingStep2(ctx);
        });
        this.bot.action('onboarding_examples', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown(`
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
            await ctx.replyWithMarkdown(`
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
            await this.userService.updateUser(ctx.userId, {
                onboardingPassed: true,
            });
            await ctx.replyWithMarkdown(`
🎉 *Поздравляем! Онбординг завершен!*

Теперь ты готов к продуктивной работе с Ticky AI!

🚀 Используй /menu для доступа ко всем функциям
      `);
            setTimeout(async () => {
                await this.showMainMenu(ctx);
            }, 2000);
        });
        this.bot.on('text', async (ctx) => {
            const user = await this.userService.findByTelegramId(ctx.userId);
            if (ctx.session.aiChatMode) {
                await this.handleAIChatMessage(ctx, ctx.message.text);
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
            if (ctx.session.step === 'onboarding_waiting_habit') {
                const habitName = ctx.message.text;
                await ctx.replyWithMarkdown(`
✅ *Отличная привычка: "${habitName}"*

Привычка добавлена! Теперь ты можешь отслеживать её выполнение каждый день.

🎯 Продолжим настройку...
        `);
                setTimeout(async () => {
                    await this.showOnboardingStep3(ctx);
                }, 2000);
                return;
            }
            if (this.isReminderRequest(ctx.message.text)) {
                await this.processReminderFromText(ctx, ctx.message.text);
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
                await ctx.replyWithMarkdown('🔄 *Управление привычками* - функция в разработке');
            }
        });
        this.bot.action('menu_mood', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown('😊 *Отметить настроение* - функция в разработке');
        });
        this.bot.action('menu_focus', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown('⏰ *Сессия фокуса* - функция в разработке');
        });
        this.bot.action('menu_stats', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown('📊 *Статистика* - функция в разработке');
        });
        this.bot.action('menu_settings', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown('⚙️ *Настройки* - функция в разработке');
        });
        this.bot.action('menu_achievements', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown('🏆 *Достижения* - функция в разработке');
        });
        this.bot.action('menu_ai', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown('💡 *ИИ Помощник* - функция в разработке');
        });
        this.bot.action('add_item', async (ctx) => {
            await ctx.answerCbQuery();
            const keyboard = {
                inline_keyboard: [
                    [{ text: '📝 Добавить задачу', callback_data: 'tasks_add' }],
                    [{ text: '🔄 Добавить привычку', callback_data: 'habits_add' }],
                    [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
                ],
            };
            await ctx.replyWithMarkdown('➕ *Что хотите добавить?*', {
                reply_markup: keyboard,
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
            await ctx.replyWithMarkdown('📋 *Что хотите посмотреть?*', {
                reply_markup: keyboard,
            });
        });
        this.bot.action('my_progress', async (ctx) => {
            await ctx.answerCbQuery();
            const user = await this.userService.findByTelegramId(ctx.userId);
            await ctx.replyWithMarkdown(`
📈 *Ваш прогресс*

👤 **Профиль:**
⭐ Опыт: ${user.totalXp} XP

📊 **Статистика:**

 Текущий стрик: ${user.currentStreak} дней
📅 Аккаунт создан: ${user.createdAt.toLocaleDateString('ru-RU')}

Продолжайте в том же духе! 🚀
      `);
        });
        this.bot.action('ai_chat', async (ctx) => {
            await ctx.answerCbQuery();
            await this.startAIChat(ctx);
        });
        this.bot.action('more_functions', async (ctx) => {
            await ctx.answerCbQuery();
            const keyboard = {
                inline_keyboard: [
                    [{ text: '😊 Настроение', callback_data: 'menu_mood' }],
                    [{ text: '⏰ Сессия фокуса', callback_data: 'menu_focus' }],
                    [{ text: '🏆 Достижения', callback_data: 'menu_achievements' }],
                    [{ text: '⚙️ Настройки', callback_data: 'menu_settings' }],
                    [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
                ],
            };
            await ctx.replyWithMarkdown('⚙️ *Дополнительные функции:*', {
                reply_markup: keyboard,
            });
        });
        this.bot.action('faq_support', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown(`
❓ *FAQ / Поддержка*

*Часто задаваемые вопросы:*

**Как добавить задачу?**
Нажмите "➕ Добавить задачу/привычку" → "📝 Добавить задачу"

**Как отметить выполнение?**
Перейдите в "📋 Мои задачи" и нажмите ✅ рядом с задачей

**Как работает система XP?**
За выполнение задач вы получаете опыт и повышаете уровень

**Нужна помощь?**
Напишите /feedback для связи с разработчиками
      `);
        });
        this.bot.action('add_habit_direct', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown('🔄 *Добавление привычек* - функция в разработке');
        });
        this.bot.action('back_to_menu', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showMainMenu(ctx);
        });
        this.bot.action('ai_analyze_profile', async (ctx) => {
            await this.handleAIAnalyzeProfile(ctx);
        });
        this.bot.action('ai_task_recommendations', async (ctx) => {
            await this.handleAITaskRecommendations(ctx);
        });
        this.bot.action('ai_habit_help', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown(`
🎯 *Помощь с привычками*

Функция в разработке! Скоро здесь будут персональные рекомендации по формированию полезных привычек.
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                    ],
                },
            });
        });
        this.bot.action('ai_time_planning', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.replyWithMarkdown(`
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
        this.bot.action('exit_ai_chat', async (ctx) => {
            await ctx.answerCbQuery();
            ctx.session.aiChatMode = false;
            await ctx.replyWithMarkdown(`
✅ *Чат с ИИ завершён*

Спасибо за общение! Вы всегда можете вернуться к ИИ-консультанту через главное меню.
      `);
            await this.showMainMenu(ctx);
        });
        this.bot.action('tasks_add', async (ctx) => {
            await ctx.answerCbQuery();
            await this.startAddingTask(ctx);
        });
        this.bot.action('tasks_list', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showTasksList(ctx);
        });
        this.bot.action('tasks_today', async (ctx) => {
            await ctx.answerCbQuery();
            await this.showTodayTasks(ctx);
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
        this.bot.command('feedback', async (ctx) => {
            await this.showFeedbackSurvey(ctx);
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
                await ctx.replyWithMarkdown(`
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
            await ctx.replyWithMarkdown(`
🕐 *Хорошо, спросим позже!*

Вы всегда можете оставить отзыв командой /feedback
      `);
        });
        this.bot.catch((err, ctx) => {
            this.logger.error(`Bot error for ${ctx.updateType}:`, err);
            ctx.reply('🚫 Произошла ошибка. Попробуйте позже или обратитесь к администратору.');
        });
    }
    async onModuleInit() {
        this.launch().catch((error) => {
            this.logger.error('Failed to launch bot:', error);
        });
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
        await ctx.replyWithMarkdown(`
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
    async showMainMenu(ctx) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '➕ Добавить задачу/привычку', callback_data: 'add_item' }],
                [{ text: '� Мои задачи и привычки', callback_data: 'my_items' }],
                [{ text: '� Мой прогресс', callback_data: 'my_progress' }],
                [{ text: '🧠 Чат с ИИ', callback_data: 'ai_chat' }],
                [{ text: '⚙️ Ещё функции', callback_data: 'more_functions' }],
                [{ text: '❓ FAQ / Поддержка', callback_data: 'faq_support' }],
                [{ text: '➕ Добавить привычку', callback_data: 'add_habit_direct' }],
            ],
        };
        const user = await this.userService.findByTelegramId(ctx.userId);
        await ctx.replyWithMarkdown(`
👋 *Привет, ${this.userService.getDisplayName(user)}!*

🤖 Я DailyCheck Bot - твой личный помощник для управления привычками и задачами.
    `, { reply_markup: keyboard });
        setTimeout(() => this.checkAndShowFeedbackRequest(ctx), 2000);
    }
    async launch() {
        try {
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
                [{ text: '🔙 Назад в меню', callback_data: 'back_to_main' }],
            ],
        };
        await ctx.replyWithMarkdown(`
📝 *Управление задачами*

Выберите действие:
    `, { reply_markup: keyboard });
    }
    async startAddingTask(ctx) {
        await ctx.replyWithMarkdown(`
➕ *Создание новой задачи*

📝 Напишите название задачи:
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
            const user = await this.userService.findByTelegramId(ctx.userId);
            await this.userService.updateUserStats(ctx.userId, {
                totalTasks: user.totalTasks + 1,
            });
            await ctx.replyWithMarkdown(`
✅ *Задача создана!*

📝 *${task.title}*
 XP за выполнение: ${task.xpReward}

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
                await ctx.replyWithMarkdown(`
📋 *Список задач пуст*

У вас пока нет задач. Добавьте первую задачу!
        `);
                return;
            }
            const pendingTasks = tasks.filter((task) => task.status === 'PENDING' || task.status === 'IN_PROGRESS');
            const completedTasks = tasks.filter((task) => task.status === 'COMPLETED');
            let message = '📋 *Ваши задачи:*\n\n';
            if (pendingTasks.length > 0) {
                message += '*🔄 Активные задачи:*\n';
                for (const task of pendingTasks) {
                    const priorityEmoji = this.getPriorityEmoji(task.priority);
                    message += `${priorityEmoji} ${task.title}\n`;
                    message += `    ${task.xpReward} XP\n\n`;
                }
            }
            if (completedTasks.length > 0) {
                message += '*✅ Выполненные задачи:*\n';
                for (const task of completedTasks.slice(0, 5)) {
                    message += `✅ ~~${task.title}~~\n`;
                }
                if (completedTasks.length > 5) {
                    message += `   ... и еще ${completedTasks.length - 5} задач\n`;
                }
            }
            const keyboard = {
                inline_keyboard: [
                    ...pendingTasks.slice(0, 5).map((task) => [
                        {
                            text: `✅ ${task.title.substring(0, 25)}${task.title.length > 25 ? '...' : ''}`,
                            callback_data: `task_complete_${task.id}`,
                        },
                    ]),
                    [{ text: '🔙 Назад к задачам', callback_data: 'back_to_tasks' }],
                ],
            };
            await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
        }
        catch (error) {
            this.logger.error('Error showing tasks list:', error);
            await ctx.replyWithMarkdown('❌ Ошибка при получении списка задач');
        }
    }
    async showTodayTasks(ctx) {
        try {
            const tasks = await this.taskService.getTodayTasks(ctx.userId);
            if (tasks.length === 0) {
                await ctx.replyWithMarkdown(`
📅 *Задачи на сегодня*

На сегодня задач нет! 🎉
        `);
                return;
            }
            let message = '📅 *Задачи на сегодня:*\n\n';
            for (const task of tasks) {
                const statusEmoji = task.status === 'COMPLETED' ? '✅' : '🔄';
                const priorityEmoji = this.getPriorityEmoji(task.priority);
                message += `${statusEmoji} ${priorityEmoji} ${task.title}\n`;
                if (task.status !== 'COMPLETED') {
                    message += `   🎯 ${task.xpReward} XP\n`;
                }
                message += '\n';
            }
            const pendingTasks = tasks.filter((task) => task.status !== 'COMPLETED');
            const keyboard = {
                inline_keyboard: [
                    ...pendingTasks.slice(0, 3).map((task) => [
                        {
                            text: `✅ ${task.title.substring(0, 25)}${task.title.length > 25 ? '...' : ''}`,
                            callback_data: `task_complete_${task.id}`,
                        },
                    ]),
                    [{ text: '🔙 Назад к задачам', callback_data: 'back_to_tasks' }],
                ],
            };
            await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
        }
        catch (error) {
            this.logger.error('Error showing today tasks:', error);
            await ctx.replyWithMarkdown('❌ Ошибка при получении задач на сегодня');
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
            await ctx.replyWithMarkdown(message);
            setTimeout(() => this.showTasksMenu(ctx), leveledUp ? 3000 : 2000);
        }
        catch (error) {
            this.logger.error('Error completing task:', error);
            if (error.message.includes('already completed')) {
                await ctx.replyWithMarkdown('ℹ️ Эта задача уже выполнена!');
            }
            else {
                await ctx.replyWithMarkdown('❌ Ошибка при выполнении задачи');
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
        await ctx.replyWithMarkdown(`
🌍 *Для корректной работы с задачами и привычками мне нужно знать ваш часовой пояс.*

📍 Пожалуйста, напишите название вашего города:
(например: Москва, Санкт-Петербург, Нью-Йорк, Лондон)
    `);
        ctx.session.step = 'waiting_for_city';
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
        await this.showMainMenu(ctx);
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
        await ctx.replyWithMarkdown(`
💭 *Мини-опрос*

👍 *Что вам нравится?*

Выберите, что вас больше всего привлекает в боте:
      `, { reply_markup: keyboard });
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
        await ctx.replyWithMarkdown(`
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
        await ctx.replyWithMarkdown(`
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
        await ctx.replyWithMarkdown(`
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
        await ctx.replyWithMarkdown(`
✨ *Спасибо за участие в опросе!*

Вы выбрали: ${improvementText}

Ваше мнение поможет нам стать лучше! 💝

Продолжайте пользоваться ботом и достигайте новых целей! 🚀
    `);
    }
    async completeFeedback(ctx, improvement) {
        await ctx.answerCbQuery();
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
        await ctx.replyWithMarkdown(`
🧠 *ИИ Консультант активирован!*

Привет! Я ваш персональный ИИ-помощник по продуктивности. 

Я проанализировал ваш профиль и готов дать персональные рекомендации по:
📝 Управлению задачами
🔄 Формированию привычек  
⏰ Планированию времени
🎯 Достижению целей
📊 Повышению продуктивности

*Задайте мне любой вопрос или выберите тему:*
    `, {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '📊 Анализ моего профиля',
                            callback_data: 'ai_analyze_profile',
                        },
                    ],
                    [
                        {
                            text: '💡 Рекомендации по задачам',
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
                            text: '✍️ Задать свой вопрос',
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
        await ctx.answerCbQuery();
        const user = await this.userService.findByTelegramId(ctx.userId);
        const tasks = await this.taskService.findTasksByUserId(ctx.userId);
        const profileData = {
            totalXp: user.totalXp,
            currentStreak: user.currentStreak,
            accountAge: Math.floor((Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
            totalTasks: tasks.length,
            completedTasks: tasks.filter((task) => task.completedAt !== null).length,
            timezone: user.timezone,
            city: user.city,
        };
        const analysisPrompt = `
Проанализируй профиль пользователя и дай персональные рекомендации:

Данные пользователя:
- Опыт: ${profileData.totalXp} XP
- Текущий стрик: ${profileData.currentStreak} дней
- Дней с ботом: ${profileData.accountAge}
- Всего задач: ${profileData.totalTasks}
- Выполнено задач: ${profileData.completedTasks}
- Часовой пояс: ${profileData.timezone || 'не указан'}
- Город: ${profileData.city || 'не указан'}

Дай краткий анализ (до 300 слов) с конкретными рекомендациями по улучшению продуктивности.
`;
        try {
            const analysis = await this.openaiService.getAIResponse(analysisPrompt);
            await ctx.replyWithMarkdown(`
🧠 *Анализ вашего профиля:*

${analysis}

💡 *Хотите обсудить что-то конкретное?* Просто напишите мне!
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
❌ *Ошибка при анализе профиля*

Извините, сейчас ИИ-анализ временно недоступен. Попробуйте позже.
      `);
        }
    }
    async handleAITaskRecommendations(ctx) {
        await ctx.answerCbQuery();
        const tasks = await this.taskService.findTasksByUserId(ctx.userId);
        const activeTasks = tasks.filter((task) => task.completedAt === null);
        const taskPrompt = `
У пользователя ${activeTasks.length} активных задач: ${activeTasks.map((t) => t.title).join(', ')}

Дай рекомендации по:
1. Приоритизации задач
2. Планированию времени выполнения  
3. Разбивке сложных задач
4. Повышению мотивации

Ответ до 250 слов.
`;
        try {
            const recommendations = await this.openaiService.getAIResponse(taskPrompt);
            await ctx.replyWithMarkdown(`
💡 *Рекомендации по вашим задачам:*

${recommendations}

*Есть вопросы?* Напишите мне!
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                    ],
                },
            });
        }
        catch (error) {
            await ctx.replyWithMarkdown(`
❌ *Ошибка получения рекомендаций*

ИИ-консультант временно недоступен. Попробуйте позже.
      `);
        }
    }
    async handleAICustomQuestion(ctx) {
        await ctx.answerCbQuery();
        await ctx.replyWithMarkdown(`
✍️ *Режим свободного общения*

Напишите мне любой вопрос о продуктивности, управлении временем, мотивации или планировании. 

Я учту ваш профиль и дам персональный совет!

*Пример вопросов:*
• "Как мне лучше планировать утро?"
• "Почему я прокрастинирую?"
• "Как выработать привычку рано вставать?"
    `, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                ],
            },
        });
        ctx.session.aiChatMode = true;
    }
    async handleAIChatMessage(ctx, message) {
        try {
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
            let reminderMatch = null;
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
            const user = await this.userService.findByTelegramId(ctx.userId);
            const tasks = await this.taskService.findTasksByUserId(ctx.userId);
            const activeTasks = tasks.filter((task) => task.completedAt === null);
            const userContext = `
Контекст пользователя:
- Опыт: ${user.totalXp} XP
- Стрик: ${user.currentStreak} дней
- Активных задач: ${activeTasks.length}
- Часовой пояс: ${user.timezone || 'не указан'}
- Город: ${user.city || 'не указан'}

Вопрос пользователя: ${message}

Дай персональный совет, учитывая этот контекст.
      `;
            const response = await this.openaiService.getAIResponse(userContext);
            await ctx.replyWithMarkdown(`
🧠 *ИИ-консультант отвечает:*

${response}

💡 *Есть ещё вопросы?* Просто напишите мне!
      `, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
                        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                        [{ text: '❌ Выйти из чата', callback_data: 'exit_ai_chat' }],
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
                await ctx.replyWithMarkdown(`
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
            const timeStr = reminderDate.toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
            });
            await ctx.replyWithMarkdown(`
✅ *Напоминание установлено!*

📝 **Текст:** ${reminderText}
⏰ **Время:** через ${minutesFromNow} минут (в ${timeStr})

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
            this.logger.error('Error creating relative reminder:', error);
            await ctx.replyWithMarkdown(`
❌ *Ошибка создания напоминания*

Не удалось создать напоминание. Попробуйте ещё раз.
      `);
        }
    }
    async handleReminderRequest(ctx, reminderText, hours, minutes) {
        try {
            const user = await this.userService.findByTelegramId(ctx.userId);
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
            const delay = reminderDate.getTime() - now.getTime();
            setTimeout(async () => {
                try {
                    await ctx.telegram.sendMessage(ctx.userId, `🔔 *Напоминание!*\n\n${reminderText}`, { parse_mode: 'Markdown' });
                }
                catch (error) {
                    this.logger.error('Error sending reminder:', error);
                }
            }, delay);
            const timeStr = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
            const dateStr = reminderDate.toLocaleDateString('ru-RU', {
                day: 'numeric',
                month: 'long',
            });
            await ctx.replyWithMarkdown(`
✅ *Напоминание установлено!*

📝 **Текст:** ${reminderText}
⏰ **Время:** ${timeStr}
📅 **Дата:** ${dateStr}

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
                transcribedText.toLowerCase().includes('новая задача')) {
                await this.startAddingTask(ctx);
                return;
            }
            if (transcribedText.toLowerCase().includes('меню') ||
                transcribedText.toLowerCase().includes('главное меню')) {
                await this.showMainMenu(ctx);
                return;
            }
            await this.handleAIChatMessage(ctx, transcribedText);
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
        const timeMatch = text.match(/в\s*(\d{1,2}):(\d{2})/i) ||
            text.match(/в\s*(\d{1,2})\s*час(?:а|ов)?(?:\s*(\d{2})\s*минут)?/i);
        if (timeMatch) {
            const hours = timeMatch[1];
            const minutes = timeMatch[2] || '00';
            const reminderText = text
                .replace(/напомни\s*(мне)?/gi, '')
                .replace(/в\s*\d{1,2}:?\d{0,2}\s*(?:час|минут)?(?:а|ов)?/gi, '')
                .trim();
            await this.handleReminderRequest(ctx, reminderText, hours, minutes);
            return;
        }
        const relativeMatch = text.match(/через\s*(\d+)\s*(минут|час)/i);
        if (relativeMatch) {
            const amount = parseInt(relativeMatch[1]);
            const unit = relativeMatch[2];
            const now = new Date();
            if (unit.includes('час')) {
                now.setHours(now.getHours() + amount);
            }
            else {
                now.setMinutes(now.getMinutes() + amount);
            }
            const hours = now.getHours().toString().padStart(2, '0');
            const minutes = now.getMinutes().toString().padStart(2, '0');
            const reminderText = text
                .replace(/напомни\s*(мне)?/gi, '')
                .replace(/через\s*\d+\s*(?:минут|час)(?:а|ов)?/gi, '')
                .trim();
            await this.handleReminderRequest(ctx, reminderText, hours, minutes);
            return;
        }
        await ctx.replyWithMarkdown(`
🤔 *Не удалось определить время напоминания*

Пожалуйста, укажите время в формате:
• "напомни купить молоко в 17:30"
• "напомни позвонить маме через 30 минут"
    `);
    }
    isReminderRequest(text) {
        const reminderPatterns = [
            /напомни.*в\s*(\d{1,2}):(\d{2})/i,
            /напомни.*в\s*(\d{1,2})\s*час/i,
            /напомни.*через\s*(\d+)\s*(минут|час)/i,
            /напоминание.*в\s*(\d{1,2}):(\d{2})/i,
            /добавь.*напоминание/i,
            /создай.*напоминание/i,
        ];
        return reminderPatterns.some((pattern) => pattern.test(text));
    }
};
exports.TelegramBotService = TelegramBotService;
exports.TelegramBotService = TelegramBotService = TelegramBotService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        user_service_1.UserService,
        openai_service_1.OpenAIService,
        task_service_1.TaskService])
], TelegramBotService);
//# sourceMappingURL=telegram-bot.service.js.map