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
let TelegramBotService = TelegramBotService_1 = class TelegramBotService {
    configService;
    userService;
    logger = new common_1.Logger(TelegramBotService_1.name);
    bot;
    constructor(configService, userService) {
        this.configService = configService;
        this.userService = userService;
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
        this.bot.catch((err, ctx) => {
            this.logger.error(`Bot error for ${ctx.updateType}:`, err);
            ctx.reply('🚫 Произошла ошибка. Попробуйте позже или обратитесь к администратору.');
        });
    }
    async onModuleInit() {
        await this.launch();
    }
    async onModuleDestroy() {
        await this.stop();
    }
    async startOnboarding(ctx) {
        await ctx.replyWithMarkdown(`
🎉 *Добро пожаловать в DailyCheck!*

Я помогу вам организовать ваш день и достичь целей через:
• 📝 Управление задачами
• 🔄 Отслеживание привычек  
• 😊 Мониторинг настроения
• ⏰ Сессии фокуса
• 🏆 Систему достижений

Давайте начнем настройку! Как вас зовут?
    `);
        ctx.session.step = 'onboarding_name';
    }
    async showMainMenu(ctx) {
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📝 Задачи', callback_data: 'menu_tasks' },
                    { text: '🔄 Привычки', callback_data: 'menu_habits' },
                ],
                [
                    { text: '😊 Настроение', callback_data: 'menu_mood' },
                    { text: '⏰ Фокус', callback_data: 'menu_focus' },
                ],
                [
                    { text: '📊 Статистика', callback_data: 'menu_stats' },
                    { text: '⚙️ Настройки', callback_data: 'menu_settings' },
                ],
                [
                    { text: '🏆 Достижения', callback_data: 'menu_achievements' },
                    { text: '💡 ИИ Помощник', callback_data: 'menu_ai' },
                ],
            ],
        };
        const user = await this.userService.findByTelegramId(ctx.userId);
        await ctx.replyWithMarkdown(`
🎯 *Главное меню DailyCheck*

Привет, ${this.userService.getDisplayName(user)}! 👋

*Ваша статистика сегодня:*
📝 Задач выполнено: ${user.todayTasks}
🔄 Привычек выполнено: ${user.todayHabits}
⚡ Уровень: ${user.level} (XP: ${user.totalXp})
🔥 Стрик: ${user.currentStreak} дней

Что будем делать?
    `, { reply_markup: keyboard });
    }
    async launch() {
        try {
            await this.bot.launch();
            this.logger.log('🚀 Telegram bot launched successfully');
        }
        catch (error) {
            this.logger.error('❌ Failed to launch Telegram bot:', error);
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
};
exports.TelegramBotService = TelegramBotService;
exports.TelegramBotService = TelegramBotService = TelegramBotService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        user_service_1.UserService])
], TelegramBotService);
//# sourceMappingURL=telegram-bot.service.js.map