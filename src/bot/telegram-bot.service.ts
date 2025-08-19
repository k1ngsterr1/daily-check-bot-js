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
import { OpenAIService } from '../services/openai.service';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Telegraf<BotContext>;

  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
    private readonly openaiService: OpenAIService,
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

    // Onboarding callback handlers
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

      // Mark onboarding as completed
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

    // Handle text input during onboarding
    this.bot.on('text', async (ctx) => {
      const user = await this.userService.findByTelegramId(ctx.userId);

      // Check if user needs to provide timezone first
      if (
        !user.timezone &&
        (ctx.session.step === 'adding_task' ||
          ctx.session.step === 'adding_habit')
      ) {
        await this.askForTimezone(ctx);
        return;
      }

      // Handle timezone setting
      if (ctx.session.step === 'waiting_for_city') {
        await this.handleCityInput(ctx, ctx.message.text);
        return;
      }

      if (ctx.session.step === 'onboarding_waiting_habit') {
        const habitName = ctx.message.text;

        // Here you would typically save the habit to database
        // For now, just acknowledge and continue

        await ctx.replyWithMarkdown(`
✅ *Отличная привычка: "${habitName}"*

Привычка добавлена! Теперь ты можешь отслеживать её выполнение каждый день.

🎯 Продолжим настройку...
        `);

        setTimeout(async () => {
          await this.showOnboardingStep3(ctx);
        }, 2000);
      }
    });

    // Main menu callback handlers
    this.bot.action('menu_tasks', async (ctx) => {
      await ctx.answerCbQuery();

      const user = await this.userService.findByTelegramId(ctx.userId);
      if (!user.timezone) {
        ctx.session.step = 'adding_task';
        await this.askForTimezone(ctx);
      } else {
        await ctx.replyWithMarkdown(
          '📝 *Управление задачами* - функция в разработке',
        );
      }
    });

    this.bot.action('menu_habits', async (ctx) => {
      await ctx.answerCbQuery();

      const user = await this.userService.findByTelegramId(ctx.userId);
      if (!user.timezone) {
        ctx.session.step = 'adding_habit';
        await this.askForTimezone(ctx);
      } else {
        await ctx.replyWithMarkdown(
          '🔄 *Управление привычками* - функция в разработке',
        );
      }
    });

    this.bot.action('menu_mood', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.replyWithMarkdown(
        '😊 *Отметить настроение* - функция в разработке',
      );
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

    // Error handling
    this.bot.catch((err, ctx) => {
      this.logger.error(`Bot error for ${ctx.updateType}:`, err);
      ctx.reply(
        '🚫 Произошла ошибка. Попробуйте позже или обратитесь к администратору.',
      );
    });
  }

  async onModuleInit() {
    // Запускаем бота асинхронно, не дожидаясь завершения
    this.launch().catch((error) => {
      this.logger.error('Failed to launch bot:', error);
    });
  }

  async onModuleDestroy() {
    await this.stop();
  }

  private async startOnboarding(ctx: BotContext) {
    // Step 1: Welcome
    await this.showOnboardingStep1(ctx);
  }

  private async showOnboardingStep1(ctx: BotContext) {
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

    await ctx.replyWithMarkdown(
      `🤖 *Привет! Я Ticky AI — твой AI-ассистент по привычкам и задачам с геймификацией.*`,
      { reply_markup: keyboard },
    );

    ctx.session.step = 'onboarding_welcome';
  }

  private async showOnboardingStep2(ctx: BotContext) {
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

    await ctx.replyWithMarkdown(
      `
🚀 *Быстрый старт*

Давай добавим твою первую привычку!
Например: "Пить воду"

*Выбери действие:*
    `,
      { reply_markup: keyboard },
    );

    ctx.session.step = 'onboarding_quick_start';
  }

  private async showOnboardingStep3(ctx: BotContext) {
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Понятно!', callback_data: 'onboarding_complete' }],
      ],
    };

    await ctx.replyWithMarkdown(
      `
📚 *Мини-FAQ*

*ЧТО УМЕЕТ БОТ?*

• Добавлять задачи и привычки
• Следить за прогрессом
• Вовлекать в челленджи
• Напоминать о важных делах

🎯 Готов начать продуктивный день?
    `,
      { reply_markup: keyboard },
    );

    ctx.session.step = 'onboarding_faq';
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
      // Запускаем бота без ожидания
      this.bot
        .launch()
        .then(() => {
          this.logger.log('🚀 Telegram bot launched successfully');
        })
        .catch((error) => {
          this.logger.error('❌ Failed to launch Telegram bot:', error);
        });

      // Возвращаем управление сразу
      this.logger.log('🤖 Telegram bot launch initiated');
    } catch (error) {
      this.logger.error('❌ Error during bot initialization:', error);
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

  private async askForTimezone(ctx: BotContext) {
    await ctx.replyWithMarkdown(`
🌍 *Для корректной работы с задачами и привычками мне нужно знать ваш часовой пояс.*

📍 Пожалуйста, напишите название вашего города:
(например: Москва, Санкт-Петербург, Нью-Йорк, Лондон)
    `);

    ctx.session.step = 'waiting_for_city';
  }

  private async handleCityInput(ctx: BotContext, cityName: string) {
    await ctx.replyWithMarkdown('🔍 *Определяю часовой пояс...*');

    const result = await this.openaiService.getTimezoneByCity(cityName);

    if (!result) {
      await ctx.replyWithMarkdown(`
❌ *Не удалось определить часовой пояс для города "${cityName}"*

📍 Попробуйте еще раз. Напишите название города более точно:
      `);
      return;
    }

    // Save timezone and city to database
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

    // Reset session step
    ctx.session.step = undefined;

    // Show main menu or continue with the original action
    await this.showMainMenu(ctx);
  }
}
