import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, session } from 'telegraf';
import { BotContext } from './bot-context.interface';
import { UserService } from '../services/user.service';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Telegraf<BotContext>;

  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
  ) {
    const token = this.configService.get<string>('bot.token');
    if (!token) {
      throw new Error('BOT_TOKEN is not provided');
    }

    this.bot = new Telegraf<BotContext>(token);
    this.setupMiddleware();
    this.setupHandlers();
  }

  private setupMiddleware() {
    // Session middleware
    this.bot.use(
      session({
        defaultSession: () => ({
          step: undefined,
          data: {},
          waitingForInput: false,
          currentAction: undefined,
          tempData: {},
        }),
      }),
    );

    // User context middleware
    this.bot.use(async (ctx, next) => {
      if (ctx.from) {
        ctx.userId = ctx.from.id.toString();

        // Ensure user exists in database
        await this.userService.findOrCreateUser({
          id: ctx.from.id.toString(),
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
        });
      }

      // Add helper methods
      ctx.replyWithMarkdown = (text: string, extra: any = {}) => {
        return ctx.reply(text, { parse_mode: 'Markdown', ...extra });
      };

      ctx.editMessageTextWithMarkdown = (text: string, extra: any = {}) => {
        return ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra });
      };

      return next();
    });
  }

  private setupHandlers() {
    // Start command
    this.bot.start(async (ctx) => {
      const user = await this.userService.findByTelegramId(ctx.userId);

      if (!user.onboardingPassed) {
        await this.startOnboarding(ctx);
      } else {
        await this.showMainMenu(ctx);
      }
    }); // Help command
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

    // Main menu command
    this.bot.command('menu', async (ctx) => {
      await this.showMainMenu(ctx);
    });

    // Error handling
    this.bot.catch((err, ctx) => {
      this.logger.error(`Bot error for ${ctx.updateType}:`, err);
      ctx.reply(
        '🚫 Произошла ошибка. Попробуйте позже или обратитесь к администратору.',
      );
    });
  }

  async onModuleInit() {
    await this.launch();
  }

  async onModuleDestroy() {
    await this.stop();
  }

  private async startOnboarding(ctx: BotContext) {
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

  private async showMainMenu(ctx: BotContext) {
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

    await ctx.replyWithMarkdown(
      `
🎯 *Главное меню DailyCheck*

Привет, ${this.userService.getDisplayName(user)}! 👋

*Ваша статистика сегодня:*
📝 Задач выполнено: ${user.todayTasks}
🔄 Привычек выполнено: ${user.todayHabits}
⚡ Уровень: ${user.level} (XP: ${user.totalXp})
🔥 Стрик: ${user.currentStreak} дней

Что будем делать?
    `,
      { reply_markup: keyboard },
    );
  }

  async launch() {
    try {
      await this.bot.launch();
      this.logger.log('🚀 Telegram bot launched successfully');
    } catch (error) {
      this.logger.error('❌ Failed to launch Telegram bot:', error);
      throw error;
    }
  }

  async stop() {
    this.bot.stop('SIGINT');
    this.logger.log('🛑 Telegram bot stopped');
  }

  getBotInstance(): Telegraf<BotContext> {
    return this.bot;
  }
}
