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
import { TaskService } from '../services/task.service';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Telegraf<BotContext>;

  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
    private readonly openaiService: OpenAIService,
    private readonly taskService: TaskService,
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

      // Handle task creation
      if (ctx.session.step === 'waiting_for_task_title') {
        await this.handleTaskCreation(ctx, ctx.message.text);
        return;
      }

      // Handle custom feedback
      if (ctx.session.step === 'waiting_for_custom_feedback') {
        await this.completeFeedback(ctx, ctx.message.text);
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
        await this.showTasksMenu(ctx);
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

    // New main menu handlers
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
      await ctx.replyWithMarkdown('🧠 *Чат с ИИ* - функция в разработке');
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
      await ctx.replyWithMarkdown(
        '🔄 *Добавление привычек* - функция в разработке',
      );
    });

    this.bot.action('back_to_menu', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMainMenu(ctx);
    });

    // Task management handlers
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

    // Handle task completion
    this.bot.action(/^task_complete_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      await this.completeTask(ctx, taskId);
    });

    // Handle back to tasks menu
    this.bot.action('back_to_tasks', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showTasksMenu(ctx);
    });

    // Handle back to main menu
    this.bot.action('back_to_main', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMainMenu(ctx);
    });

    // Feedback system handlers
    this.bot.command('feedback', async (ctx) => {
      await this.showFeedbackSurvey(ctx);
    });

    this.bot.action(/^feedback_rating_(\d+)$/, async (ctx) => {
      const rating = parseInt(ctx.match[1]);
      await this.handleFeedbackRating(ctx, rating);
    });

    this.bot.action(/^feedback_like_(.+)$/, async (ctx) => {
      const feature = ctx.match[1];
      await this.handleFeedbackImprovement(ctx, feature);
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
      } else {
        // Check if this is from /feedback command (no rating) or automatic request (with rating)
        if (ctx.session.feedbackRating) {
          await this.completeFeedback(ctx, improvement);
        } else {
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

    await ctx.replyWithMarkdown(
      `
👋 *Привет, ${this.userService.getDisplayName(user)}!*

🤖 Я DailyCheck Bot - твой личный помощник для управления привычками и задачами.
    `,
      { reply_markup: keyboard },
    );

    // Check if we should show feedback request
    setTimeout(() => this.checkAndShowFeedbackRequest(ctx), 2000);
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

  // Task management methods
  private async showTasksMenu(ctx: BotContext) {
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

    await ctx.replyWithMarkdown(
      `
📝 *Управление задачами*

Выберите действие:
    `,
      { reply_markup: keyboard },
    );
  }

  private async startAddingTask(ctx: BotContext) {
    await ctx.replyWithMarkdown(`
➕ *Создание новой задачи*

📝 Напишите название задачи:
    `);

    ctx.session.step = 'waiting_for_task_title';
  }

  private async handleTaskCreation(ctx: BotContext, taskTitle: string) {
    try {
      const task = await this.taskService.createTask({
        userId: ctx.userId,
        title: taskTitle.trim(),
        description: '',
        priority: 'MEDIUM' as any,
      });

      // Get current user stats to increment
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
    } catch (error) {
      this.logger.error('Error creating task:', error);
      await ctx.replyWithMarkdown(`
❌ *Ошибка при создании задачи*

Попробуйте еще раз или обратитесь к администратору.
      `);
      ctx.session.step = undefined;
    }
  }

  private async showTasksList(ctx: BotContext) {
    try {
      const tasks = await this.taskService.findTasksByUserId(ctx.userId);

      if (tasks.length === 0) {
        await ctx.replyWithMarkdown(`
📋 *Список задач пуст*

У вас пока нет задач. Добавьте первую задачу!
        `);
        return;
      }

      const pendingTasks = tasks.filter(
        (task) => task.status === 'PENDING' || task.status === 'IN_PROGRESS',
      );
      const completedTasks = tasks.filter(
        (task) => task.status === 'COMPLETED',
      );

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

      // Create keyboard with task completion buttons
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
    } catch (error) {
      this.logger.error('Error showing tasks list:', error);
      await ctx.replyWithMarkdown('❌ Ошибка при получении списка задач');
    }
  }

  private async showTodayTasks(ctx: BotContext) {
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
    } catch (error) {
      this.logger.error('Error showing today tasks:', error);
      await ctx.replyWithMarkdown('❌ Ошибка при получении задач на сегодня');
    }
  }

  private async completeTask(ctx: BotContext, taskId: string) {
    try {
      const result = await this.taskService.completeTask(taskId, ctx.userId);

      // Get current user stats to increment and check level up
      const userBefore = await this.userService.findByTelegramId(ctx.userId);
      const newTotalXp = userBefore.totalXp + result.xpGained;

      await this.userService.updateUserStats(ctx.userId, {
        completedTasks: userBefore.completedTasks + 1,
        todayTasks: userBefore.todayTasks + 1,
        xpGained: result.xpGained,
      });

      // Get updated user to check for level up
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
      } else {
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
    } catch (error) {
      this.logger.error('Error completing task:', error);
      if (error.message.includes('already completed')) {
        await ctx.replyWithMarkdown('ℹ️ Эта задача уже выполнена!');
      } else {
        await ctx.replyWithMarkdown('❌ Ошибка при выполнении задачи');
      }
    }
  }

  private getPriorityEmoji(priority: string): string {
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

  // Gamification helpers
  private createProgressBar(progress: number, length: number = 10): string {
    const filled = Math.round(progress * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  // Feedback system methods
  private async checkAndShowFeedbackRequest(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    const accountAge = Date.now() - user.createdAt.getTime();
    const threeDaysInMs = 3 * 24 * 60 * 60 * 1000;

    // Show feedback request after 3 days
    if (accountAge >= threeDaysInMs && !user.feedbackGiven) {
      await this.showFeedbackRequest(ctx);
    }
  }

  private async showFeedbackSurvey(ctx: BotContext) {
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

    await ctx.replyWithMarkdown(
      `
💭 *Мини-опрос*

👍 *Что вам нравится?*

Выберите, что вас больше всего привлекает в боте:
      `,
      { reply_markup: keyboard },
    );
  }

  private async showFeedbackRequest(ctx: BotContext) {
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

    await ctx.replyWithMarkdown(
      `
💭 *Оцените ваш опыт использования бота*

Как вам работа с Ticky AI? Ваше мнение поможет нам стать лучше!
      `,
      { reply_markup: keyboard },
    );
  }

  private async handleFeedbackRating(ctx: BotContext, rating: number) {
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

    await ctx.replyWithMarkdown(
      `
👍 *Что вам больше всего нравится?*

Выберите, что вас привлекает в боте:
      `,
      { reply_markup: keyboard },
    );
  }

  private async handleFeedbackImprovement(
    ctx: BotContext,
    likedFeature: string,
  ) {
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

    await ctx.replyWithMarkdown(
      `
💡 *Что хотелось бы улучшить?*

Выберите, что можно сделать лучше:
      `,
      { reply_markup: keyboard },
    );
  }

  private async completeFeedbackSurvey(ctx: BotContext, improvement: string) {
    await ctx.answerCbQuery();

    // Save feedback to database (survey-only, no rating)
    await this.userService.updateUser(ctx.userId, {
      feedbackGiven: true,
    });

    // Prepare improvement text
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

  private async completeFeedback(ctx: BotContext, improvement: string) {
    await ctx.answerCbQuery();

    // Save feedback to database
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

    // Clear feedback session data
    ctx.session.feedbackRating = undefined;
    ctx.session.feedbackLiked = undefined;
  }
}
