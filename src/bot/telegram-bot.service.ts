import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, session } from 'telegraf';
import { User, Reminder, ReminderStatus } from '@prisma/client';
import { BotContext } from './bot-context.interface';
import { UserService } from '../services/user.service';
import { OpenAIService } from '../services/openai.service';
import { TaskService } from '../services/task.service';
import { HabitService } from '../services/habit.service';
import { BillingService } from '../services/billing.service';
import { AiContextService } from '../services/ai-context.service';
import { PaymentService } from '../services/payment.service';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Telegraf<BotContext>;
  private activePomodoroSessions: Map<
    string,
    {
      focusTimer?: NodeJS.Timeout;
      breakTimer?: NodeJS.Timeout;
      startTime: Date;
    }
  > = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
    private readonly openaiService: OpenAIService,
    private readonly taskService: TaskService,
    private readonly habitService: HabitService,
    private readonly billingService: BillingService,
    private readonly aiContextService: AiContextService,
    private readonly paymentService: PaymentService,
    private readonly prisma: PrismaService,
  ) {
    const token = this.configService.get<string>('bot.token');
    if (!token) {
      throw new Error('BOT_TOKEN is not provided');
    }

    this.bot = new Telegraf<BotContext>(token);
    this.setupMiddleware();
    this.setupHandlers();
    this.setupErrorHandling();
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
        const existingUser = await this.userService
          .findByTelegramId(ctx.from.id.toString())
          .catch(() => null);

        if (!existingUser) {
          // Create new user
          await this.userService.findOrCreateUser({
            id: ctx.from.id.toString(),
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name,
          });

          // Initialize trial period for new user
          await this.billingService.initializeTrialForUser(
            ctx.from.id.toString(),
          );
        }
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

  private setupErrorHandling() {
    // Global error handler for bot
    this.bot.catch(async (err, ctx) => {
      this.logger.error('Bot error for message:', err);

      try {
        const error = err as Error;
        if (
          error.message &&
          error.message.includes("message can't be edited")
        ) {
          // If the error is about message editing, try to send a new message
          await ctx.replyWithMarkdown(
            '❌ Произошла ошибка. Попробуйте позже или обратитесь к администратору.',
          );
        } else {
          await ctx.replyWithMarkdown(
            '❌ Произошла ошибка. Попробуйте позже или обратитесь к администратору.',
          );
        }
      } catch (responseError) {
        this.logger.error('Failed to send error response:', responseError);
      }
    });
  }

  private setupHandlers() {
    // Start command
    this.bot.start(async (ctx) => {
      try {
        // Проверяем реферальный параметр
        const startPayload = ctx.startPayload;
        let referrerId: string | undefined;

        if (startPayload && startPayload.startsWith('ref_')) {
          referrerId = startPayload.replace('ref_', '');
          this.logger.log(`User started with referral from: ${referrerId}`);
        }

        // Создаем или находим пользователя
        const userData = {
          id: ctx.from?.id.toString() || ctx.userId,
          username: ctx.from?.username || undefined,
          firstName: ctx.from?.first_name || undefined,
          lastName: ctx.from?.last_name || undefined,
        };

        const user = await this.userService.findOrCreateUser(userData);

        // Если это новый пользователь с реферальным кодом
        if (referrerId && referrerId !== user.id) {
          await this.handleReferralRegistration(ctx, user.id, referrerId);
        }

        this.logger.log(
          `User ${user.id} started bot. Onboarding passed: ${user.onboardingPassed}`,
        );

        // Проверяем, прошел ли пользователь онбординг
        if (!user.onboardingPassed) {
          this.logger.log(`Starting onboarding for user ${user.id}`);
          await this.startOnboarding(ctx);
        } else {
          this.logger.log(`Showing main menu for user ${user.id}`);
          await this.showMainMenu(ctx);
        }
      } catch (error) {
        this.logger.error('Error in start command:', error);
        await ctx.replyWithMarkdown(
          '❌ Произошла ошибка при запуске бота. Попробуйте еще раз.',
        );
      }
    }); // Help command
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

    // Main menu command
    this.bot.command('menu', async (ctx) => {
      await this.showMainMenu(ctx);
    });

    // Tasks command
    this.bot.command('tasks', async (ctx) => {
      await this.showTasksMenu(ctx);
    });

    // Habits command
    this.bot.command('habits', async (ctx) => {
      await this.showHabitsMenu(ctx);
    });

    // Mood command
    this.bot.command('mood', async (ctx) => {
      await this.showMoodMenu(ctx);
    });

    // Focus command
    this.bot.command('focus', async (ctx) => {
      await this.showFocusSession(ctx);
    });

    // Help command
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

**Основные функции:**
📝 Управление задачами и привычками
😊 Трекинг настроения
🍅 Техника Помодоро для фокуса
📊 Статистика и аналитика
💎 Система биллинга с пробным периодом

Для получения подробной информации используйте /menu
      `;

      // Check if this is a callback query (can edit) or command (need to reply)
      if (ctx.callbackQuery) {
        await ctx.editMessageTextWithMarkdown(helpMessage);
      } else {
        await ctx.replyWithMarkdown(helpMessage);
      }
    });

    // Feedback command
    this.bot.command('feedback', async (ctx) => {
      try {
        await this.showFeedbackSurvey(ctx);
      } catch (error) {
        this.logger.error('Error in feedback command:', error);
        await ctx.replyWithMarkdown('❌ Произошла ошибка. Попробуйте позже.');
      }
    });

    // Billing command
    this.bot.command('billing', async (ctx) => {
      // Redirect to show_limits handler
      const subscriptionStatus =
        await this.billingService.getSubscriptionStatus(ctx.userId);

      const limitsText =
        subscriptionStatus.limits.dailyReminders === -1
          ? '∞ (безлимит)'
          : subscriptionStatus.limits.dailyReminders.toString();
      const aiLimitsText =
        subscriptionStatus.limits.dailyAiQueries === -1
          ? '∞ (безлимит)'
          : subscriptionStatus.limits.dailyAiQueries.toString();

      let statusMessage = '';
      if (subscriptionStatus.isTrialActive) {
        statusMessage = `🎁 **Пробный период:** ${subscriptionStatus.daysRemaining} дней осталось`;
      } else {
        statusMessage = `💎 **Подписка:** ${
          subscriptionStatus.type === 'FREE'
            ? 'Бесплатная'
            : subscriptionStatus.type === 'PREMIUM'
              ? 'Premium'
              : 'Premium Plus'
        }`;
      }

      await ctx.editMessageTextWithMarkdown(
        `
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
        `,
        {
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
        },
      );
    });

    // Reset onboarding command (for testing)
    this.bot.command('reset_onboarding', async (ctx) => {
      try {
        await this.userService.updateUser(ctx.userId, {
          onboardingPassed: false,
        });
        await ctx.editMessageTextWithMarkdown(
          '🔄 Онбординг сброшен. Используйте /start для прохождения заново.',
        );
        this.logger.log(`Onboarding reset for user ${ctx.userId}`);
      } catch (error) {
        this.logger.error('Error resetting onboarding:', error);
        await ctx.replyWithMarkdown('❌ Ошибка при сбросе онбординга.');
      }
    });

    // Onboarding callback handlers
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
        // Mark onboarding as completed
        await this.userService.updateUser(ctx.userId, {
          onboardingPassed: true,
        });

        this.logger.log(`Onboarding completed for user ${ctx.userId}`);

        await ctx.editMessageTextWithMarkdown(`
🎉 *Поздравляем! Онбординг завершен!*

Теперь ты готов к продуктивной работе с Ticky AI!

🚀 Используй /menu для доступа ко всем функциям
        `);

        // Показываем главное меню
        setTimeout(() => {
          this.showMainMenu(ctx, false); // false = создать новое сообщение
        }, 2000);
      } catch (error) {
        this.logger.error('Error completing onboarding:', error);
        await ctx.replyWithMarkdown(
          '❌ Ошибка при завершении онбординга. Попробуйте еще раз.',
        );
      }
    });

    // Handle text input during onboarding
    this.bot.on('text', async (ctx) => {
      const user = await this.getOrCreateUser(ctx);

      // Skip if this is a command (starts with /) - FIRST CHECK
      if (ctx.message.text.startsWith('/')) {
        return; // Let command handlers process it
      }

      // Handle AI Chat mode
      if (ctx.session.aiChatMode) {
        await this.handleAIChatMessage(ctx, ctx.message.text);
        return;
      }

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

      // Handle custom dependency creation
      if (ctx.session.step === 'waiting_custom_dependency') {
        const dependencyName = ctx.message.text.trim();

        if (!dependencyName || dependencyName.length < 2) {
          await ctx.replyWithMarkdown(
            '⚠️ Название зависимости должно содержать минимум 2 символа. Попробуйте еще раз:',
          );
          return;
        }

        ctx.session.step = undefined;

        await ctx.replyWithMarkdown(
          `
🎯 *Отлично! Начинаем борьбу с зависимостью: "${dependencyName}"*

🤖 Система ИИ настроена и будет отправлять вам персональные мотивационные сообщения каждый день.

� *Ты уже на правильном пути к свободе!*

Что тебе поможет:
• Ежедневные умные напоминания и поддержка
• Персональные советы от ИИ
• Напоминания о твоих целях
• Техники преодоления желаний

✅ *Напоминания активированы!*
        `,
          {
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
          },
        );

        try {
          // Сохраняем информацию о кастомной зависимости
          // await this.userService.updateUser(ctx.userId, {
          //   dependencyType: 'custom',
          //   customDependencyName: dependencyName,
          //   dependencyStartDate: new Date(),
          // });

          // Запускаем ежедневные мотивационные сообщения
          this.startDailyMotivation(ctx.userId, 'custom');

          await ctx.replyWithMarkdown(
            `
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
          `,
            {
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
            },
          );
        } catch (error) {
          this.logger.error(`Error setting up custom dependency: ${error}`);
          await ctx.replyWithMarkdown(
            '❌ Произошла ошибка при настройке. Попробуйте позже.',
            {
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
            },
          );
        }
        return;
      }

      // Handle waiting for reminder time
      if (ctx.session.waitingForReminderTime && ctx.session.pendingReminder) {
        await this.handleReminderTimeInput(ctx, ctx.message.text);
        return;
      }

      if (ctx.session.step === 'onboarding_waiting_habit') {
        const habitName = ctx.message.text;

        try {
          // Создаем привычку в базе данных
          await this.habitService.createHabit({
            userId: ctx.userId,
            title: habitName,
            description: undefined,
            frequency: 'DAILY',
            targetCount: 1,
          });

          // Сбрасываем шаг
          ctx.session.step = undefined;

          await ctx.replyWithMarkdown(`
✅ *Отличная привычка: "${habitName}"*

Привычка добавлена! Теперь ты можешь отслеживать её выполнение каждый день.

🎯 Продолжим настройку...
        `);

          // Переходим к следующему шагу
          setTimeout(async () => {
            await this.showOnboardingStep3(ctx);
          }, 2000);
        } catch (error) {
          this.logger.error('Error creating habit during onboarding:', error);
          await ctx.replyWithMarkdown(
            '❌ Ошибка при создании привычки. Попробуйте еще раз.',
          );
        }
        return;
      }

      // Handle regular habit creation
      if (ctx.session.step === 'adding_habit') {
        const habitTitle = ctx.message.text.trim();

        if (!habitTitle || habitTitle.length < 2) {
          await ctx.replyWithMarkdown(
            '⚠️ Название привычки должно содержать минимум 2 символа. Попробуйте еще раз:',
          );
          return;
        }

        try {
          // Create the habit using the habit service
          await this.habitService.createHabit({
            userId: ctx.userId,
            title: habitTitle,
            description: undefined,
            frequency: 'DAILY' as const,
            targetCount: 1,
          });

          ctx.session.step = undefined;

          await ctx.replyWithMarkdown(
            `
✅ *Привычка "${habitTitle}" успешно добавлена!*

🎯 Теперь вы можете отслеживать её выполнение в разделе "Мои привычки".

*Напоминание:* Регулярность - ключ к формированию привычек!
          `,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Мои привычки', callback_data: 'menu_habits' }],
                  [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
              },
            },
          );
        } catch (error) {
          this.logger.error(`Error creating habit: ${error}`);
          await ctx.replyWithMarkdown(
            '❌ Произошла ошибка при создании привычки. Попробуйте позже.',
          );
        }
        return;
      }

      // Handle reminder requests in regular text mode (only with specific time)
      if (this.isReminderRequest(ctx.message.text)) {
        await this.processReminderFromText(ctx, ctx.message.text);
        return;
      }

      // Skip if user is in a setup process (timezone, etc.)
      if (ctx.session.step) {
        // User is in the middle of some process, don't treat as task
        return;
      }

      // Handle task creation from text (when no specific time mentioned)
      if (this.isTaskRequest(ctx.message.text)) {
        this.logger.log(
          `Creating task from text: "${ctx.message.text}" for user ${ctx.userId}`,
        );
        await this.createTaskFromText(ctx, ctx.message.text);
        return;
      }

      // Check if this is a general question/chat message that should trigger AI
      if (this.isGeneralChatMessage(ctx.message.text)) {
        // Enable AI chat mode and handle the message
        ctx.session.aiChatMode = true;
        await this.handleAIChatMessage(ctx, ctx.message.text);
        return;
      }

      // Default: show help or main menu
      await ctx.replyWithMarkdown(`
🤔 *Не понимаю команду*

Используйте /menu для вызова главного меню или /help для справки.

💡 *Подсказка:* Вы можете написать "напомни мне..." с указанием времени для создания напоминания.
      `);
    });

    // Handle voice messages
    this.bot.on('voice', async (ctx) => {
      await this.handleAudioMessage(ctx, 'voice');
    });

    // Handle audio files
    this.bot.on('audio', async (ctx) => {
      await this.handleAudioMessage(ctx, 'audio');
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
        await this.showHabitsMenu(ctx);
      }
    });

    this.bot.action('habits_list', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showHabitsMenu(ctx);
    });

    // Handle AI advice for habits
    this.bot.action('habits_ai_advice', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showHabitsAIAdvice(ctx);
    });

    // Handle adding habits
    this.bot.action('habits_add', async (ctx) => {
      await ctx.answerCbQuery();

      const user = await this.userService.findByTelegramId(ctx.userId);
      if (!user.timezone) {
        ctx.session.pendingAction = 'adding_habit';
        await this.askForTimezone(ctx);
      } else {
        ctx.session.step = 'adding_habit';
        await ctx.editMessageTextWithMarkdown(
          '🔄 *Добавление привычки*\n\nВведите название привычки, которую хотите отслеживать:',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      }
    });

    // Handle habit completion
    this.bot.action(/^habit_complete_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.completeHabit(ctx, habitId);
    });

    // Handle showing more habits
    this.bot.action('habits_list_more', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showAllHabitsList(ctx);
    });

    this.bot.action('menu_mood', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMoodMenu(ctx);
    });

    this.bot.action('menu_focus', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        '⏰ *Сессия фокуса* - функция в разработке',
      );
    });

    this.bot.action('menu_stats', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        '📊 *Статистика* - функция в разработке',
      );
    });

    this.bot.action('menu_settings', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        '⚙️ *Настройки* - функция в разработке',
      );
    });

    this.bot.action('menu_achievements', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        '🏆 *Достижения* - функция в разработке',
      );
    });

    this.bot.action('menu_ai', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        '💡 *ИИ Помощник* - функция в разработке',
      );
    });

    // New main menu handlers
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
      await ctx.editMessageTextWithMarkdown(
        `🎙️ *Озвучьте задачу*

Вы можете продиктовать:
• 📝 Новую задачу или напоминание
• 🔄 Новую привычку
• ❓ Любые вопросы или команды

Просто запишите и отправьте голосовое сообщение! 🎤`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'add_item' }],
            ],
          },
        },
      );
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

      // Calculate level progress
      const currentLevelXp = this.userService.getCurrentLevelXp(user);
      const nextLevelXp = this.userService.getNextLevelXp(user);
      const progressXp = this.userService.getProgressXp(user);
      const xpToNextLevel = this.userService.getXpToNextLevel(user);
      const progressRatio = this.userService.getLevelProgressRatio(user);

      // Create progress bar
      const progressBarLength = 10;
      const filledBars = Math.floor(progressRatio * progressBarLength);
      const emptyBars = progressBarLength - filledBars;
      const progressBar = '█'.repeat(filledBars) + '░'.repeat(emptyBars);

      await ctx.editMessageTextWithMarkdown(
        `
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
      `,
        {
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
        },
      );
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
            { text: '📊 Мой прогресс', callback_data: 'progress_stats' },
            { text: '🔔 Напоминания', callback_data: 'reminders' },
          ],
          [
            { text: '🥇 Достижения', callback_data: 'achievements' },
            { text: '🚀 Челленджи', callback_data: 'challenges' },
          ],
          [
            {
              text: '💰 Бонусы и рефералы',
              callback_data: 'bonuses_referrals',
            },
            { text: '🛍️ Магазин', callback_data: 'shop' },
          ],
          [
            { text: '🎭 Зависимости', callback_data: 'dependencies' },
            { text: '🍅 Фокусирование', callback_data: 'pomodoro_focus' },
          ],
          [
            { text: '⬅️', callback_data: 'back_to_menu' },
            { text: '👤', callback_data: 'user_profile' },
            { text: '⚙️', callback_data: 'user_settings' },
          ],
        ],
      };
      await ctx.editMessageTextWithMarkdown(
        `
🚀 *Дополнительные функции*

Выберите интересующий раздел:
      `,
        {
          reply_markup: keyboard,
        },
      );
    });

    // Additional functions handlers
    this.bot.action('progress_stats', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);
      const userStats = await this.userService.getUserStats(ctx.userId);

      // Get today's date for progress display
      const today = new Date();
      const todayStr = today.toLocaleDateString('ru-RU');

      await ctx.editMessageTextWithMarkdown(
        `
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
      `,
        {
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
        },
      );
    });

    this.bot.action('user_settings', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
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
        `,
        {
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
        },
      );
    });

    // Settings handlers
    this.bot.action('settings_notifications', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
🔔 *Настройки уведомлений*

Текущие настройки:
📱 Уведомления: ${user.notifications ? '✅ Включены' : '❌ Отключены'}
⏰ Время напоминаний: ${user.reminderTime}
📊 Еженедельная сводка: ${user.weeklySummary ? '✅ Включена' : '❌ Отключена'}
📅 Ежедневные напоминания: ${user.dailyReminders ? '✅ Включены' : '❌ Отключены'}
        `,
        {
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
        },
      );
    });

    this.bot.action('settings_interface', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
🎨 *Настройки интерфейса*

Текущие настройки:
🎭 Тема: ${user.theme}
✨ Анимации: ${user.showAnimations ? '✅ Включены' : '❌ Отключены'}
🎙️ Голосовые команды: ${user.voiceCommands ? '✅ Включены' : '❌ Отключены'}
        `,
        {
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
        },
      );
    });

    this.bot.action('settings_ai', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
🤖 *AI настройки*

Текущие настройки:
🧠 AI режим: ${user.aiMode ? '✅ Включен' : '❌ Отключен'}
🔧 Режим разработки: ${user.dryMode ? '✅ Включен' : '❌ Отключен'}

💡 AI режим позволяет боту давать умные советы и помогать с планированием.
        `,
        {
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
        },
      );
    });

    this.bot.action('settings_privacy', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
🔒 *Настройки приватности*

Текущие настройки:
👁️ Уровень приватности: ${user.privacyLevel}
🌍 Часовой пояс: ${user.timezone || 'Не установлен'}
🏙️ Город: ${user.city || 'Не указан'}

💡 Уровень приватности влияет на видимость вашего профиля другим пользователям.
        `,
        {
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
        },
      );
    });

    // Toggle handlers for settings
    this.bot.action('toggle_notifications', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await this.userService.updateUser(ctx.userId, {
        notifications: !user.notifications,
      });

      await ctx.editMessageTextWithMarkdown(
        `✅ Уведомления ${!user.notifications ? 'включены' : 'отключены'}`,
        {
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
        },
      );
    });

    this.bot.action('toggle_weekly_summary', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await this.userService.updateUser(ctx.userId, {
        weeklySummary: !user.weeklySummary,
      });

      await ctx.editMessageTextWithMarkdown(
        `✅ Еженедельная сводка ${!user.weeklySummary ? 'включена' : 'отключена'}`,
        {
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
        },
      );
    });

    this.bot.action('toggle_animations', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await this.userService.updateUser(ctx.userId, {
        showAnimations: !user.showAnimations,
      });

      await ctx.editMessageTextWithMarkdown(
        `✅ Анимации ${!user.showAnimations ? 'включены' : 'отключены'}`,
        {
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
        },
      );
    });

    this.bot.action('toggle_voice_commands', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await this.userService.updateUser(ctx.userId, {
        voiceCommands: !user.voiceCommands,
      });

      await ctx.editMessageTextWithMarkdown(
        `✅ Голосовые команды ${!user.voiceCommands ? 'включены' : 'отключены'}`,
        {
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
        },
      );
    });

    this.bot.action('toggle_ai_mode', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await this.userService.updateUser(ctx.userId, {
        aiMode: !user.aiMode,
      });

      await ctx.editMessageTextWithMarkdown(
        `✅ AI режим ${!user.aiMode ? 'включен' : 'отключен'}`,
        {
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
        },
      );
    });

    this.bot.action('achievements', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
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
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    });

    this.bot.action('challenges', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
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
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    });

    this.bot.action('bonuses_referrals', async (ctx) => {
      await ctx.answerCbQuery();

      // Генерируем реферальную ссылку с ID пользователя
      const botUsername =
        this.configService.get<string>('bot.username') || 'TickyAIBot';
      const referralLink = `https://t.me/${botUsername}?start=ref_${ctx.userId}`;

      // Получаем статистику пользователя
      const user = await this.userService.findByTelegramId(ctx.userId);

      // Временные данные, пока не добавим в UserService
      const referralStats = {
        totalReferrals: 0,
        activeReferrals: 0,
        totalBonus: 0,
        topReferrals: [],
      };

      await ctx.editMessageTextWithMarkdown(
        `
� *РЕФЕРАЛЬНАЯ СИСТЕМА*

🔗 **ВАША ССЫЛКА** 👇
\`${referralLink}\`

**СТАТИСТИКА ПАРТНЕРСТВА:**
👥 Приглашено друзей: ${referralStats.totalReferrals || 0}
💎 Активных пользователей: ${referralStats.activeReferrals || 0}  
🎁 Получено бонусов: ${referralStats.totalBonus || 0} XP

**УСЛОВИЯ:**
• За каждого друга: +500 XP
• Друг получает: +200 XP при регистрации
• Бонус за активного друга: +100 XP/неделю

**ТОП-5 ваших рефералов:**
${
  referralStats.topReferrals && referralStats.topReferrals.length > 0
    ? referralStats.topReferrals
        .map(
          (ref: any, i: number) =>
            `${i + 1}. ${ref.firstName || 'Пользователь'} - ${ref.xpEarned || 0} XP`,
        )
        .join('\n')
    : 'Пока нет рефералов'
}

💡 **Поделитесь ссылкой с друзьями!**
      `,
        {
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
                {
                  text: '🎓 Как работает',
                  callback_data: 'how_referral_works',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    });

    // Referral system handlers
    this.bot.action('copy_referral_link', async (ctx) => {
      await ctx.answerCbQuery('📋 Ссылка скопирована! Поделитесь с друзьями!');
      const botUsername =
        this.configService.get<string>('bot.username') || 'TickyAIBot';
      const referralLink = `https://t.me/${botUsername}?start=ref_${ctx.userId}`;

      await ctx.reply(
        `🔗 *Ваша реферальная ссылка:*\n\n\`${referralLink}\`\n\n📱 Поделитесь этой ссылкой с друзьями!\n💰 За каждого приглашенного +500 XP`,
        { parse_mode: 'Markdown' },
      );
    });

    this.bot.action('referral_stats', async (ctx) => {
      await ctx.answerCbQuery();
      // Временно показываем базовую статистику, пока не добавим в UserService
      await ctx.editMessageTextWithMarkdown(
        `
📊 *ДЕТАЛЬНАЯ СТАТИСТИКА*

**ЗА ВСЕ ВРЕМЯ:**
👥 Всего приглашений: 0
💎 Активных рефералов: 0
💰 Заработано XP: 0

**ЗА ЭТОТ МЕСЯЦ:**
📈 Новые приглашения: 0
⭐ Активность рефералов: 0%
🎁 Получено бонусов: 0 XP

**КОНВЕРСИЯ:**
📋 Переходы по ссылке: 0
✅ Регистрации: 0
🔥 Коэффициент конверсии: 0%

*💡 Приглашайте больше друзей для увеличения статистики!*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ К рефералам', callback_data: 'bonuses_referrals' }],
            ],
          },
        },
      );
    });

    this.bot.action('how_referral_works', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
🎓 *КАК РАБОТАЕТ РЕФЕРАЛЬНАЯ ПРОГРАММА*

**ШАГ 1: ПОДЕЛИТЕСЬ ССЫЛКОЙ**
📱 Скопируйте свою реферальную ссылку
💬 Отправьте друзьям в чат или соцсети
🔗 Каждая ссылка уникальна и содержит ваш ID

**ШАг 2: ДРУГ РЕГИСТРИРУЕТСЯ**
👤 Друг переходит по вашей ссылке
🚀 Регистрируется в боте
🎁 Получает +200 XP при регистрации

**ШАГ 3: ВЫ ПОЛУЧАЕТЕ НАГРАДУ**
💰 +500 XP сразу за приглашение
⭐ +100 XP каждую неделю за активного друга
🏆 Бонусы за достижения рефералов

**УСЛОВИЯ:**
• Самоприглашение не считается
• Бонусы только за реальную активность
• Еженедельные выплаты по воскресеньям

*🚀 Начните прямо сейчас - поделитесь ссылкой!*
        `,
        {
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
        },
      );
    });

    this.bot.action('withdraw_bonus', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
💰 *ВЫВОД БОНУСОВ*

**ДОСТУПНЫЕ ВАРИАНТЫ:**
🎮 Премиум функции бота - от 1000 XP
🛍️ Скидки в магазине - от 500 XP  
🎁 Подарочные карты - от 2000 XP

**ТЕКУЩИЙ БАЛАНС:**
⭐ Ваш XP: Loading...
💎 Доступно к выводу: Loading...

**МИНИМАЛЬНЫЙ ВЫВОД:**
🔢 500 XP = Базовые награды
💰 1000 XP = Премиум возможности
🏆 2000 XP = Ценные призы

*🚧 Функция в разработке - скоро будет доступна!*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ К рефералам', callback_data: 'bonuses_referrals' }],
            ],
          },
        },
      );
    });

    this.bot.action('user_profile', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
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
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✏️ Редактировать', callback_data: 'edit_profile' },
                { text: '⬅️ Назад', callback_data: 'more_functions' },
              ],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
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

    this.bot.action('manage_reminders', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showManageReminders(ctx);
    });

    this.bot.action('reminders_stats', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showRemindersStats(ctx);
    });

    // Handle reminder deletion
    this.bot.action(/^delete_reminder_(.+)$/, async (ctx) => {
      const reminderId = ctx.match[1];
      await ctx.answerCbQuery();
      await this.handleDeleteReminder(ctx, reminderId);
    });

    this.bot.action('settings_menu', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
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
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    });

    this.bot.action('shop', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
🛍️ *Магазин премиум функций*

💰 **Ваш баланс:** ${user.totalXp} XP

**Доступные улучшения:**
⚡ Премиум аккаунт - 299₽/месяц
🎯 Неограниченные задачи
📊 Расширенная аналитика  
🎨 Эксклюзивные темы
🤖 Приоритетная поддержка ИИ

**Косметические улучшения:**
🎨 Темы интерфейса - от 99₽
🏆 Уникальные значки - от 49₽
⚡ Анимированные эмодзи - от 29₽

**Функциональные дополнения:**
📈 Экспорт в Excel - 199₽
📱 Мобильное приложение - 399₽
🔔 Smart-уведомления - 149₽

💡 **XP Магазин доступен ниже!**
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✨ XP Магазин', callback_data: 'xp_shop' },
                { text: '💳 Премиум', callback_data: 'premium_shop' },
              ],
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    });

    // XP Shop handler
    this.bot.action('xp_shop', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
✨ *XP Магазин*

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

Заработайте XP выполняя задачи и привычки! 💪
        `,
        {
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
              [{ text: '⬅️ Назад в магазин', callback_data: 'shop' }],
            ],
          },
        },
      );
    });

    // Premium shop handler
    this.bot.action('premium_shop', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
💳 *Премиум подписка*

**Преимущества Premium аккаунта:**
✅ Неограниченные задачи и привычки
✅ Расширенная аналитика и отчеты
✅ Приоритетная поддержка AI
✅ Эксклюзивные темы и значки
✅ Экспорт данных в различных форматах
✅ Персональный менеджер продуктивности
✅ Интеграция с внешними сервисами

**Тарифы:**
🥈 **Базовый** - 299₽/месяц
🥇 **Продвинутый** - 499₽/месяц  
💎 **Профессиональный** - 799₽/месяц

*Премиум функции скоро будут доступны!*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🥈 Базовый', callback_data: 'premium_basic' },
                { text: '🥇 Продвинутый', callback_data: 'premium_advanced' },
              ],
              [{ text: '💎 Профессиональный', callback_data: 'premium_pro' }],
              [{ text: '⬅️ Назад в магазин', callback_data: 'shop' }],
            ],
          },
        },
      );
    });

    // XP Purchase handlers
    this.bot.action('buy_theme_2000', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'theme',
        2000,
        'Эксклюзивная тема "Темная материя"',
        'dark_matter',
      );
    });

    this.bot.action('buy_badge_1500', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'badge',
        1500,
        'Значок "Мастер продуктивности"',
        'productivity_master',
      );
    });

    this.bot.action('buy_emoji_800', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'emoji',
        800,
        'Анимированные эмодзи набор',
        'animated_emoji_pack',
      );
    });

    this.bot.action('buy_stickers_1200', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'sticker',
        1200,
        'Кастомные стикеры',
        'custom_stickers',
      );
    });

    this.bot.action('buy_stats_3000', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'feature',
        3000,
        'Расширенная статистика',
        'advanced_stats',
      );
    });

    this.bot.action('buy_categories_2500', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'feature',
        2500,
        'Дополнительные категории задач',
        'extra_categories',
      );
    });

    this.bot.action('buy_notifications_1800', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'feature',
        1800,
        'Персональные уведомления',
        'personal_notifications',
      );
    });

    this.bot.action('buy_export_2200', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'feature',
        2200,
        'Экспорт данных',
        'data_export',
      );
    });

    // Billing handlers
    this.bot.action('show_limits', async (ctx) => {
      await ctx.answerCbQuery();
      const subscriptionStatus =
        await this.billingService.getSubscriptionStatus(ctx.userId);

      const limitsText =
        subscriptionStatus.limits.dailyReminders === -1
          ? '∞ (безлимит)'
          : subscriptionStatus.limits.dailyReminders.toString();
      const aiLimitsText =
        subscriptionStatus.limits.dailyAiQueries === -1
          ? '∞ (безлимит)'
          : subscriptionStatus.limits.dailyAiQueries.toString();

      let statusMessage = '';
      if (subscriptionStatus.isTrialActive) {
        statusMessage = `🎁 **Пробный период:** ${subscriptionStatus.daysRemaining} дней осталось`;
      } else {
        statusMessage = `💎 **Подписка:** ${
          subscriptionStatus.type === 'FREE'
            ? 'Бесплатная'
            : subscriptionStatus.type === 'PREMIUM'
              ? 'Premium'
              : 'Premium Plus'
        }`;
      }

      await ctx.editMessageTextWithMarkdown(
        `
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
      `,
        {
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
        },
      );
    });

    this.bot.action('upgrade_premium', async (ctx) => {
      await ctx.answerCbQuery();
      const trialInfo = await this.billingService.getTrialInfo(ctx.userId);

      let trialText = '';
      if (trialInfo.isTrialActive) {
        trialText = `🎁 **У вас есть ${trialInfo.daysRemaining} дней пробного периода!**

`;
      }

      await ctx.editMessageTextWithMarkdown(
        `
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
      `,
        {
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
        },
      );
    });

    // Handle Premium purchase
    this.bot.action('buy_premium', async (ctx) => {
      await ctx.answerCbQuery();
      await this.createPayment(ctx, 'PREMIUM');
    });

    // Handle Premium Plus purchase
    this.bot.action('buy_premium_plus', async (ctx) => {
      await ctx.answerCbQuery();
      await this.createPayment(ctx, 'PREMIUM_PLUS');
    });

    // Handle payment status check
    this.bot.action(/^check_payment_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const paymentId = ctx.match[1];

      try {
        const status = await this.paymentService.checkPaymentStatus(paymentId);

        if (status === 'succeeded') {
          await ctx.editMessageTextWithMarkdown(
            '✅ *Платеж успешно завершен!*\n\nВаша подписка активирована.',
          );
        } else if (status === 'canceled') {
          await ctx.editMessageTextWithMarkdown(
            '❌ *Платеж отменен*\n\nПопробуйте оформить подписку заново.',
          );
        } else {
          await ctx.editMessageTextWithMarkdown(
            '⏳ *Платеж в обработке*\n\nПожалуйста, подождите или проверьте позже.',
          );
        }
      } catch (error) {
        await ctx.replyWithMarkdown(
          '❌ *Ошибка при проверке платежа*\n\nПопробуйте позже.',
        );
      }
    });

    this.bot.action('dependencies', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
🎭 *Блок зависимостей*

**Система напоминаний, поддержки и мотивации на базе искусственного интеллекта, чтобы ты смог освободиться от любой зависимости.**

      `,
        {
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
        },
      );
    });

    this.bot.action('choose_dependency', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
🎯 *Выбери свою зависимость*

**Популярные зависимости:**
      `,
        {
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
        },
      );
    });

    // Dependency tracking handlers
    ['smoking', 'alcohol', 'social', 'gaming', 'shopping', 'sweets'].forEach(
      (type) => {
        this.bot.action(`dep_${type}`, async (ctx) => {
          await ctx.answerCbQuery();

          const dependencyName =
            type === 'smoking'
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

          await ctx.editMessageTextWithMarkdown(
            `
🎯 *Отлично! Начинаем борьбу с зависимостью от ${dependencyName}*

🤖 Система ИИ настроена и будет отправлять вам персональные мотивационные сообщения каждый день.

💪 *Ты уже на правильном пути к свободе!*

Что тебе поможет:
• Ежедневные умные напоминания и поддержка
• Персональные советы от ИИ
• Напоминания о твоих целях
• Техники преодоления желаний

        `,
            {
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
            },
          );
        });
      },
    );

    // Custom dependency handler
    this.bot.action('dep_custom', async (ctx) => {
      await ctx.answerCbQuery();
      ctx.session.step = 'waiting_custom_dependency';
      await ctx.editMessageTextWithMarkdown(
        `
✍️ *Создание своей зависимости*

Напишите название зависимости, от которой хотите избавиться:

*Например:* "Переедание", "Прокрастинация", "Негативные мысли" и т.д.
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'choose_dependency' }],
            ],
          },
        },
      );
    });

    // Setup reminders for dependencies
    ['smoking', 'alcohol', 'social', 'gaming', 'shopping', 'sweets'].forEach(
      (type) => {
        this.bot.action(`setup_reminders_${type}`, async (ctx) => {
          await ctx.answerCbQuery();

          const dependencyName =
            type === 'smoking'
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
            // Сохраняем информацию о зависимости пользователя
            // await this.userService.updateUser(ctx.userId, {
            //   dependencyType: type,
            //   dependencyStartDate: new Date(),
            // });

            // Запускаем ежедневные мотивационные сообщения
            this.startDailyMotivation(ctx.userId, type);

            await ctx.editMessageTextWithMarkdown(
              `
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
            `,
              {
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
              },
            );
          } catch (error) {
            this.logger.error(
              `Error setting up dependency reminders: ${error}`,
            );
            await ctx.editMessageTextWithMarkdown(
              '❌ Произошла ошибка при настройке. Попробуйте позже.',
              {
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
              },
            );
          }
        });
      },
    );

    // Pomodoro Focus handler
    this.bot.action('pomodoro_focus', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
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

**Настройки:**
⏱️ Время фокуса: 25 мин
☕ Время перерыва: 5 мин
🔔 Уведомления: включены
🎵 Фоновые звуки: выключены

*Выберите действие:*
        `,
        {
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
            ],
          },
        },
      );
    });

    // Pomodoro session handlers
    this.bot.action('start_pomodoro_session', async (ctx) => {
      await ctx.answerCbQuery();

      const user = await this.getOrCreateUser(ctx);

      // Check if user needs to provide timezone first
      if (!user.timezone) {
        await this.askForTimezone(ctx);
        return;
      }

      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 25 * 60 * 1000);

      // Format time according to user's timezone
      const endTimeFormatted = this.formatTimeWithTimezone(
        endTime,
        user.timezone,
      );

      await ctx.editMessageTextWithMarkdown(
        `🍅 *Сессия фокуса запущена!*

⏰ **Таймер**: 25 минут (до ${endTimeFormatted})
🎯 Сосредоточьтесь на одной задаче
📱 Уберите отвлекающие факторы
💪 Работайте до уведомления

🔔 **Вы получите уведомление через 25 минут**

*Удачной работы! 💪*`,
        {
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
            ],
          },
        },
      );

      // Clear any existing session for this user
      const existingSession = this.activePomodoroSessions.get(ctx.userId);
      if (existingSession) {
        if (existingSession.focusTimer)
          clearTimeout(existingSession.focusTimer);
        if (existingSession.breakTimer)
          clearTimeout(existingSession.breakTimer);
      }

      // Start new 25-minute focus timer
      const focusTimer = setTimeout(
        async () => {
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

            // Start 5-minute break timer
            const breakTimer = setTimeout(
              async () => {
                try {
                  await ctx.editMessageTextWithMarkdown(
                    `
⏰ *Перерыв закончился!*

🍅 5-минутный перерыв завершен. Готовы к следующей сессии фокуса?

💪 Следующий цикл:
• 25 минут фокуса
• 5 минут отдыха  
• После 4 циклов - длинный перерыв 15-30 минут

🎯 Хотите продолжить?
              `,
                    {
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
                    },
                  );

                  // Remove session from active sessions after break completes
                  this.activePomodoroSessions.delete(ctx.userId);
                } catch (error) {
                  console.log(
                    'Failed to send break completion message:',
                    error,
                  );
                }
              },
              5 * 60 * 1000,
            ); // 5 minutes break

            // Update session with break timer
            const session = this.activePomodoroSessions.get(ctx.userId);
            if (session) {
              session.breakTimer = breakTimer;
            }
          } catch (error) {
            console.log('Failed to send pomodoro completion message:', error);
          }
        },
        25 * 60 * 1000,
      ); // 25 minutes = 1500000 milliseconds

      // Save the session with timers
      this.activePomodoroSessions.set(ctx.userId, {
        focusTimer,
        startTime,
      });
    });

    this.bot.action('pause_pomodoro', async (ctx) => {
      await ctx.answerCbQuery();

      const session = this.activePomodoroSessions.get(ctx.userId);
      if (session) {
        // Calculate remaining time
        const elapsed = Math.floor(
          (new Date().getTime() - session.startTime.getTime()) / (1000 * 60),
        );
        const remaining = Math.max(0, 25 - elapsed);
        const remainingMinutes = remaining;
        const remainingSeconds = Math.max(
          0,
          Math.floor(
            (25 * 60 * 1000 -
              (new Date().getTime() - session.startTime.getTime())) /
              1000,
          ) % 60,
        );

        await ctx.editMessageTextWithMarkdown(
          `
⏸️ *Сессия приостановлена*

⏰ Осталось времени: ${remainingMinutes}:${remainingSeconds.toString().padStart(2, '0')}
⚡ Прошло: ${elapsed} мин
🎯 Фокус-сессия в процессе

*Готовы продолжить?*
          `,
          {
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
              ],
            },
          },
        );
      } else {
        await ctx.editMessageTextWithMarkdown(`
⚠️ *Нет активной сессии*

У вас нет активной сессии для паузы.
        `);
      }
    });

    this.bot.action('resume_pomodoro', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(`
▶️ *Сессия возобновлена*

⏰ Продолжаем с 15:30
🎯 Фокусируемся на задаче!
      `);
    });

    this.bot.action('stop_pomodoro', async (ctx) => {
      await ctx.answerCbQuery();

      // Stop any active timers for this user
      const session = this.activePomodoroSessions.get(ctx.userId);
      if (session) {
        if (session.focusTimer) clearTimeout(session.focusTimer);
        if (session.breakTimer) clearTimeout(session.breakTimer);

        // Calculate elapsed time
        const elapsed = Math.floor(
          (new Date().getTime() - session.startTime.getTime()) / (1000 * 60),
        );
        const elapsedMinutes = elapsed % 60;
        const elapsedHours = Math.floor(elapsed / 60);
        const timeText =
          elapsedHours > 0
            ? `${elapsedHours}:${elapsedMinutes.toString().padStart(2, '0')}`
            : `${elapsedMinutes}:${(((new Date().getTime() - session.startTime.getTime()) % 60000) / 1000).toFixed(0).padStart(2, '0')}`;

        this.activePomodoroSessions.delete(ctx.userId);

        await ctx.editMessageTextWithMarkdown(
          `
⏹️ *Сессия остановлена*

⏰ Время работы: ${timeText} из 25:00
📝 Хотите записать, что успели сделать?

*Следующие действия:*
          `,
          {
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
              ],
            },
          },
        );
      } else {
        // No active session
        await ctx.editMessageTextWithMarkdown(
          `
⚠️ *Нет активной сессии*

У вас нет активной сессии фокуса для остановки.

*Хотите начать новую?*
          `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🚀 Начать сессию',
                    callback_data: 'start_pomodoro_session',
                  },
                ],
                [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
              ],
            },
          },
        );
      }
    });

    this.bot.action('pomodoro_history', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
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
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📈 График прогресса',
                  callback_data: 'pomodoro_chart',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
            ],
          },
        },
      );
    });

    this.bot.action('pomodoro_settings', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
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
        `,
        {
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
            ],
          },
        },
      );
    });

    // Additional Pomodoro handlers
    this.bot.action('log_pomodoro_progress', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
📝 *Записать прогресс*

⏰ Время работы: 9:30 из 25:00
📊 Эффективность: 38%

*Что вы успели сделать?*
        `,
        {
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
            ],
          },
        },
      );
    });

    this.bot.action('pomodoro_chart', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(`
📈 *График прогресса*

🚧 *Функция в разработке*

Здесь будет отображаться:
📊 График фокус-сессий по дням
📈 Динамика продуктивности
🎯 Статистика по типам задач
⏰ Лучшие часы для фокуса

📧 Включите уведомления в настройках, чтобы не пропустить запуск!
      `);
    });

    this.bot.action('change_pomodoro_time', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
⏱️ *Настройка времени*

**Выберите время фокуса:**
        `,
        {
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
            ],
          },
        },
      );
    });

    this.bot.action('pomodoro_notifications', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
🔔 *Настройки уведомлений*

**Текущие настройки:**
🔊 Звуковые сигналы: ✅
📱 Push-уведомления: ✅
⏰ Напоминания о перерывах: ✅
🎵 Фоновая музыка: ❌

*Функция в разработке!*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'pomodoro_settings' }],
            ],
          },
        },
      );
    });

    // Handle AI tips for focus
    this.bot.action('focus_ai_tips', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showFocusAITips(ctx);
    });

    // Progress category handlers
    ['studying', 'work', 'writing', 'creative', 'custom'].forEach(
      (category) => {
        this.bot.action(`progress_${category}`, async (ctx) => {
          await ctx.answerCbQuery();
          await ctx.editMessageTextWithMarkdown(`
✅ *Прогресс сохранен!*

📊 Категория: ${
            category === 'studying'
              ? 'Изучение'
              : category === 'work'
                ? 'Работа'
                : category === 'writing'
                  ? 'Написание'
                  : category === 'creative'
                    ? 'Творчество'
                    : 'Другое'
          }
⏰ Время работы: 9:30

🎯 +10 XP за фокус-сессию!
📈 Ваш прогресс учтен в статистике.
          `);
        });
      },
    );

    // Focus time setting handlers
    [15, 25, 30, 45, 60].forEach((minutes) => {
      this.bot.action(`set_focus_${minutes}`, async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.editMessageTextWithMarkdown(`
⏱️ *Время фокуса изменено*

Новое время фокуса: ${minutes} минут
Время перерыва: ${minutes <= 25 ? 5 : 10} минут

✅ Настройки сохранены!
        `);
      });
    });

    // Mood handlers
    ['excellent', 'good', 'neutral', 'sad', 'angry', 'anxious'].forEach(
      (mood) => {
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

          await ctx.editMessageTextWithMarkdown(
            `
${moodEmoji} *Настроение записано!*

Ваше настроение: **${moodText}**
📅 Дата: ${new Date().toLocaleDateString('ru-RU')}

📊 Статистика настроения будет доступна в следующем обновлении!

*Спасибо за то, что делитесь своим настроением. Это поможет лучше понимать ваше эмоциональное состояние.*
        `,
            {
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
            },
          );
        });
      },
    );

    // Handle AI analysis for mood
    this.bot.action('mood_ai_analysis', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMoodAIAnalysis(ctx);
    });

    this.bot.action('mood_stats', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
📊 *Статистика настроения*

**Сегодня:** 😊 (хорошее)
**За неделю:** Средняя оценка 7/10
**За месяц:** Средняя оценка 6.5/10

**Самые частые настроения:**
😊 Хорошее - 45%
😐 Нормальное - 30% 
😄 Отличное - 25%

📈 *Функция подробной статистики в разработке!*
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к настроению', callback_data: 'menu_mood' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('faq_support', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(`
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
      await ctx.editMessageTextWithMarkdown(
        '🔄 *Добавление привычек* - функция в разработке',
      );
    });

    this.bot.action('back_to_menu', async (ctx) => {
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

    // Voice command handlers
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
      const reminderText = ctx.match[1];
      await ctx.editMessageTextWithMarkdown(
        `⏰ *Создание напоминания*

Текст: "${reminderText}"

⚠️ Для создания напоминания укажите время в формате:
• "напомни мне покупить молоко в 17:30"
• "напомни через 2 часа позвонить врачу"

Попробуйте заново с указанием времени.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action(/^ai_chat_from_voice:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const text = ctx.match[1];
      await this.handleAIChatMessage(ctx, text);
    });

    // AI Chat handlers
    this.bot.action('ai_analyze_profile', async (ctx) => {
      await this.handleAIAnalyzeProfile(ctx);
    });

    this.bot.action('ai_task_recommendations', async (ctx) => {
      await this.handleAITaskRecommendations(ctx);
    });

    this.bot.action('ai_habit_help', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
🎯 *Помощь с привычками*

Функция в разработке! Скоро здесь будут персональные рекомендации по формированию полезных привычек.
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('ai_time_planning', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
⏰ *Планирование времени*

Функция в разработке! Здесь будут рекомендации по эффективному планированию времени.
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('ai_custom_question', async (ctx) => {
      await this.handleAICustomQuestion(ctx);
    });

    this.bot.action('ai_back_menu', async (ctx) => {
      await ctx.answerCbQuery();
      await this.startAIChat(ctx);
    });

    // AI specialized handlers
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

    // Task management handlers
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

    // Handle AI advice for tasks
    this.bot.action('tasks_ai_advice', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showTasksAIAdvice(ctx);
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

    // Feedback system action handlers

    this.bot.action(/^feedback_rating_(\d+)$/, async (ctx) => {
      const rating = parseInt(ctx.match[1]);
      await this.handleFeedbackRating(ctx, rating);
    });

    this.bot.action(/^feedback_like_(.+)$/, async (ctx) => {
      const feature = ctx.match[1];

      // For /feedback command, complete survey immediately
      if (!ctx.session.feedbackRating) {
        await this.completeFeedbackSurvey(ctx, feature);
      } else {
        // For automatic feedback request, show improvement options
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
      await ctx.editMessageTextWithMarkdown(`
🕐 *Хорошо, спросим позже!*

Вы всегда можете оставить отзыв командой /feedback
      `);
    });

    // Timezone setup handlers
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

    // Error handling
    this.bot.catch((err, ctx) => {
      this.logger.error(`Bot error for ${ctx.updateType}:`, err);
      ctx.reply(
        '🚫 Произошла ошибка. Попробуйте позже или обратитесь к администратору.',
      );
    });
  }

  // AI specialized handlers
  private async handleAITaskRecommendations(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    const tasks = await this.taskService.findTasksByUserId(ctx.userId);
    const completedTasks = tasks.filter((t) => t.completedAt !== null);

    let recommendation = '';
    if (tasks.length === 0) {
      recommendation =
        '📝 Создайте первую задачу! Начните с чего-то простого на сегодня.';
    } else if (completedTasks.length < tasks.length * 0.3) {
      recommendation =
        '🎯 Сфокусируйтесь на завершении текущих задач. Качество важнее количества!';
    } else {
      recommendation =
        '🚀 Отличная работа! Попробуйте технику Помодоро для повышения продуктивности.';
    }

    await ctx.editMessageTextWithMarkdown(
      `
💡 *Рекомендации по задачам*

📊 Статистика: ${completedTasks.length}/${tasks.length} задач выполнено

${recommendation}

*Совет:* Разбивайте большие задачи на маленькие шаги.
      `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );
  }

  private async handleAIHabitHelp(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    const habits = await this.habitService.findHabitsByUserId(ctx.userId);

    let advice = '';
    if (habits.length === 0) {
      advice =
        '🔄 Начните с одной простой привычки. Например: "Выпить стакан воды утром".';
    } else if (habits.length > 3) {
      advice =
        '⚠️ Много привычек сразу сложно поддерживать. Сконцентрируйтесь на 2-3 основных.';
    } else {
      advice =
        '✅ Отличное количество привычек! Главное - постоянство, а не идеальность.';
    }

    await ctx.editMessageTextWithMarkdown(
      `
🎯 *Помощь с привычками*

📈 У вас ${habits.length} активных привычек

${advice}

*Правило 21 дня:* Повторяйте действие ежедневно в течение 21 дня.
      `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );
  }

  private async handleAITimePlanning(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    const currentHour = new Date().getHours();

    let timeAdvice = '';
    if (currentHour < 9) {
      timeAdvice =
        '🌅 Утром лучше планировать самые важные дела. Мозг работает эффективнее!';
    } else if (currentHour < 14) {
      timeAdvice =
        '☀️ Пик продуктивности! Время для сложных задач и важных решений.';
    } else if (currentHour < 18) {
      timeAdvice =
        '🕐 После обеда энергия снижается. Подходящее время для рутинных дел.';
    } else {
      timeAdvice =
        '🌆 Вечер - время для планирования завтрашнего дня и легких задач.';
    }

    await ctx.editMessageTextWithMarkdown(
      `
⏰ *Планирование времени*

🕐 Сейчас ${currentHour}:00

${timeAdvice}

*Методы:*
• 🍅 Помодоро (25 мин работа / 5 мин отдых)
• ⏰ Блокировка времени 
• 🎯 Правило 3-х приоритетов
      `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );
  }

  private async handleAICustomQuestion(ctx: BotContext) {
    await ctx.editMessageTextWithMarkdown(
      `
✍️ *Задайте свой вопрос*

Напишите вопрос о:
• Управлении задачами
• Формировании привычек  
• Планировании времени
• Мотивации и целях
• Продуктивности

Я отвечу кратко и по делу!
      `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );

    // Enable custom AI chat mode
    ctx.session.aiChatMode = true;
  }

  // Referral system methods
  private async handleReferralRegistration(
    ctx: BotContext,
    newUserId: string,
    referrerId: string,
  ): Promise<void> {
    try {
      // Проверяем, что пользователи разные
      if (newUserId === referrerId) {
        return;
      }

      // Проверяем существование реферера
      const referrer = await this.userService
        .findByTelegramId(referrerId)
        .catch(() => null);
      if (!referrer) {
        this.logger.warn(`Referrer ${referrerId} not found`);
        return;
      }

      // Начисляем бонусы рефереру
      const referrerUser = await this.userService.findByTelegramId(referrerId);
      await this.userService.updateUser(referrerId, {
        totalXp: referrerUser.totalXp + 500,
      });

      // Начисляем бонус новому пользователю
      const newUser = await this.userService.findByTelegramId(newUserId);
      await this.userService.updateUser(newUserId, {
        totalXp: newUser.totalXp + 200,
      });

      // Отправляем уведомления
      try {
        await this.bot.telegram.sendMessage(
          referrerId,
          `🎉 *Поздравляем!*\n\n👤 Ваш друг присоединился к Ticky AI!\n💰 Вы получили +500 XP\n🎁 Друг получил +200 XP при регистрации`,
          { parse_mode: 'Markdown' },
        );
      } catch (error) {
        this.logger.warn(
          `Could not send referral notification to ${referrerId}: ${error.message}`,
        );
      }

      await ctx.replyWithMarkdown(
        `🎁 *Добро пожаловать!*\n\nВы присоединились по приглашению друга!\n⭐ Получили +200 XP бонус при регистрации\n\n🚀 Давайте начнем знакомство с ботом!`,
      );

      this.logger.log(
        `Referral registration: ${newUserId} invited by ${referrerId}`,
      );
    } catch (error) {
      this.logger.error('Error handling referral registration:', error);
    }
  }

  async onModuleInit() {
    // Запускаем бота асинхронно, не дожидаясь завершения
    this.launch().catch((error) => {
      this.logger.error('Failed to launch bot:', error);
    });

    // Инициализация системы мотивационных сообщений для зависимостей
    this.startMotivationalMessagesService();
  }

  private startMotivationalMessagesService() {
    // Отправка мотивационных сообщений каждый час с 8:00 до 22:00
    setInterval(
      async () => {
        const currentHour = new Date().getHours();

        // Работаем только с 8:00 до 22:00
        if (currentHour >= 8 && currentHour <= 22) {
          await this.sendMotivationalMessages();
        }
      },
      60 * 60 * 1000,
    ); // каждый час

    this.logger.log('Motivational messages service started');
  }

  private async sendMotivationalMessages() {
    try {
      // Здесь вы бы получили список пользователей с активными зависимостями
      // Пока что это заглушка для демонстрации структуры

      // const usersWithDependencies = await this.getUsersWithActiveDependencies();
      //
      // for (const user of usersWithDependencies) {
      //   const motivationalMessage = await this.generateMotivationalMessage(user.dependency);
      //   await this.bot.telegram.sendMessage(user.telegramId, motivationalMessage, {
      //     parse_mode: 'Markdown'
      //   });
      // }

      this.logger.log('Motivational messages sent');
    } catch (error) {
      this.logger.error('Error sending motivational messages:', error);
    }
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

    await ctx.editMessageTextWithMarkdown(
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

  private async showMainMenu(ctx: BotContext, shouldEdit: boolean = false) {
    const keyboard = {
      inline_keyboard: [
        [{ text: '➕ Добавить задачу/привычку', callback_data: 'add_item' }],
        [{ text: '📋 Мои задачи и привычки', callback_data: 'my_items' }],
        [
          { text: '📊 Мой прогресс', callback_data: 'my_progress' },
          { text: '🧠 Чат с ИИ', callback_data: 'ai_chat' },
        ],
        [
          { text: '⚙️ Ещё функции', callback_data: 'more_functions' },
          { text: '❓ FAQ / Поддержка', callback_data: 'faq_support' },
        ],
        [{ text: '📊 Мои лимиты', callback_data: 'show_limits' }],
      ],
    };

    const user = await this.getOrCreateUser(ctx);
    const trialInfo = await this.billingService.getTrialInfo(ctx.userId);
    const subscriptionStatus = await this.billingService.getSubscriptionStatus(
      ctx.userId,
    );

    let statusText = '';
    if (trialInfo.isTrialActive) {
      statusText = `🎁 **Пробный период:** ${trialInfo.daysRemaining} дней осталось\n`;
    } else if (subscriptionStatus.type !== 'FREE') {
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
    } else {
      await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
    }

    // Check if we should show feedback request
    setTimeout(() => this.checkAndShowFeedbackRequest(ctx), 2000);
  }

  async launch() {
    try {
      // Устанавливаем команды в меню бота
      await this.bot.telegram.setMyCommands([
        { command: 'start', description: '🎬 Начать работу с ботом' },
        { command: 'menu', description: '🏠 Главное меню' },
        { command: 'tasks', description: '📝 Мои задачи' },
        { command: 'habits', description: '🔄 Мои привычки' },
        { command: 'mood', description: '😊 Дневник настроения' },
        { command: 'focus', description: '🍅 Режим фокуса' },
        { command: 'billing', description: '💎 Мои лимиты и подписка' },
        { command: 'feedback', description: '💬 Обратная связь' },
        { command: 'help', description: '🆘 Справка' },
      ]);

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
    // Clear all active Pomodoro timers before stopping
    for (const [userId, session] of this.activePomodoroSessions.entries()) {
      if (session.focusTimer) clearTimeout(session.focusTimer);
      if (session.breakTimer) clearTimeout(session.breakTimer);
    }
    this.activePomodoroSessions.clear();

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
        [{ text: '🤖 AI-совет по задачам', callback_data: 'tasks_ai_advice' }],
        [{ text: '🔙 Назад в меню', callback_data: 'back_to_main' }],
      ],
    };

    const message = `
📝 *Управление задачами*

Выберите действие:
    `;

    // Check if this is a callback query (can edit) or command (need to reply)
    if (ctx.callbackQuery) {
      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } else {
      await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
    }
  }

  private async startAddingTask(ctx: BotContext) {
    // Проверяем наличие часового пояса перед созданием задачи
    const user = await this.userService.findByTelegramId(ctx.userId);
    if (!user.timezone) {
      ctx.session.pendingAction = 'adding_task';
      await this.askForTimezone(ctx);
      return;
    }

    // Check billing limits for tasks
    const limitCheck = await this.billingService.checkUsageLimit(
      ctx.userId,
      'dailyTasks',
    );

    if (!limitCheck.allowed) {
      await ctx.replyWithMarkdown(
        limitCheck.message || '🚫 Превышен лимит задач',
        {
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
        },
      );
      return;
    }

    await ctx.replyWithMarkdown(`
➕ *Создание новой задачи*

📊 **Задач сегодня:** ${limitCheck.current}/${limitCheck.limit === -1 ? '∞' : limitCheck.limit}

📝 Напишите или скажите в голосовом сообщении название задачи:
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

      // Increment daily tasks counter
      await this.billingService.incrementUsage(ctx.userId, 'dailyTasks');

      // Get current user stats to increment
      const user = await this.userService.findByTelegramId(ctx.userId);
      await this.userService.updateUserStats(ctx.userId, {
        totalTasks: user.totalTasks + 1,
      });

      // Get current usage for display
      const usageInfo = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyTasks',
      );

      await ctx.replyWithMarkdown(`
✅ *Задача создана!*

📝 *${task.title}*
⚡ XP за выполнение: ${task.xpReward}
📊 **Задач сегодня:** ${usageInfo.current}/${usageInfo.limit === -1 ? '∞' : usageInfo.limit}

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
        await ctx.editMessageTextWithMarkdown(`
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

      let message = `📋 *Ваши задачи:*\n\n`;
      message += `🔄 **Активных:** ${pendingTasks.length}\n`;
      message += `✅ **Выполненных:** ${completedTasks.length}\n\n`;
      message += `*Выберите задачу для завершения:*`;

      // Create keyboard with task completion buttons
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
    } catch (error) {
      this.logger.error('Error showing tasks list:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при получении списка задач',
      );
    }
  }

  private async showAllTasksList(ctx: BotContext) {
    try {
      const tasks = await this.taskService.findTasksByUserId(ctx.userId);

      const pendingTasks = tasks.filter(
        (task) => task.status === 'PENDING' || task.status === 'IN_PROGRESS',
      );

      if (pendingTasks.length === 0) {
        await ctx.editMessageTextWithMarkdown(`
📋 *Все активные задачи*

У вас нет активных задач. Все выполнено! 🎉
        `);
        return;
      }

      let message = `📋 *Все активные задачи (${pendingTasks.length}):*\n\n`;
      message += `*Выберите задачу для завершения:*`;

      // Create keyboard with all pending tasks
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
    } catch (error) {
      this.logger.error('Error showing all tasks list:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при получении списка задач',
      );
    }
  }

  private async showTodayTasks(ctx: BotContext) {
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
      const completedTasks = tasks.filter(
        (task) => task.status === 'COMPLETED',
      );

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
    } catch (error) {
      this.logger.error('Error showing today tasks:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при получении задач на сегодня',
      );
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

      await ctx.editMessageTextWithMarkdown(message);

      setTimeout(() => this.showTasksMenu(ctx), leveledUp ? 3000 : 2000);
    } catch (error) {
      this.logger.error('Error completing task:', error);
      if (error.message.includes('already completed')) {
        await ctx.editMessageTextWithMarkdown('ℹ️ Эта задача уже выполнена!');
      } else {
        await ctx.editMessageTextWithMarkdown(
          '❌ Ошибка при выполнении задачи',
        );
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
    // Попытаемся определить часовой пояс автоматически по IP
    await ctx.replyWithMarkdown('🔍 *Определяю ваш часовой пояс...*');

    try {
      // Попробуем получить IP и определить локацию
      const ipTimezone = await this.detectTimezoneByIP();

      if (ipTimezone) {
        await ctx.replyWithMarkdown(
          `
🌍 *Автоматически определен часовой пояс*

🏙️ Регион: ${ipTimezone.city || 'Не определен'}
🕐 Часовой пояс: ${ipTimezone.timezone}

Все верно?`,
          {
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
          },
        );
        return;
      }
    } catch (error) {
      this.logger.warn('Could not detect timezone by IP:', error);
    }

    // Если автоматическое определение не сработало, показываем ручной выбор
    await this.showManualTimezoneSelection(ctx);
  }

  private async showManualTimezoneSelection(ctx: BotContext) {
    await ctx.replyWithMarkdown(
      `
🌍 *Настройка часового пояса*

Выберите удобный способ:`,
      {
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
      },
    );
  }

  private async detectTimezoneByIP(): Promise<{
    timezone: string;
    city?: string;
  } | null> {
    try {
      // Используем бесплатный API для определения локации по IP
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
    } catch (error) {
      this.logger.warn('Error detecting timezone by IP:', error);
      return null;
    }
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

    // Продолжить с тем действием, которое пользователь хотел сделать
    if (ctx.session.pendingAction === 'adding_task') {
      ctx.session.pendingAction = undefined;
      await this.startAddingTask(ctx);
    } else if (ctx.session.pendingAction === 'adding_habit') {
      ctx.session.pendingAction = undefined;
      ctx.session.step = 'adding_habit';
      await ctx.replyWithMarkdown(
        '🔄 *Добавление привычки*\n\nВведите название привычки, которую хотите отслеживать:',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } else {
      await this.showMainMenu(ctx);
    }
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

      // Check if this is a callback query (can edit) or command (need to reply)
      if (ctx.callbackQuery) {
        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } else {
        await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
      }
    } catch (error) {
      this.logger.error('Error in showFeedbackSurvey:', error);
      await ctx.replyWithMarkdown(
        '❌ Ошибка при загрузке опроса. Попробуйте позже.',
      );
    }
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

    await ctx.editMessageTextWithMarkdown(
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

    await ctx.editMessageTextWithMarkdown(
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

    await ctx.editMessageTextWithMarkdown(
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

    await ctx.editMessageTextWithMarkdown(`
✨ *Спасибо за участие в опросе!*

Вы выбрали: ${improvementText}

Ваше мнение поможет нам стать лучше! 💝

Продолжайте пользоваться ботом и достигайте новых целей! 🚀
    `);
  }

  private async completeFeedback(ctx: BotContext, improvement: string) {
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

  private async startAIChat(ctx: BotContext) {
    await ctx.editMessageTextWithMarkdown(
      `
🧠 *ИИ Консультант*

Выберите тему или задайте вопрос:
    `,
      {
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
      },
    );

    // Set AI chat mode
    ctx.session.aiChatMode = true;
  }

  private async handleAIAnalyzeProfile(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    const tasks = await this.taskService.findTasksByUserId(ctx.userId);
    const completedTasks = tasks.filter((task) => task.completedAt !== null);

    const accountDays = Math.floor(
      (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    const completionRate =
      tasks.length > 0
        ? Math.round((completedTasks.length / tasks.length) * 100)
        : 0;

    let status = '';
    if (user.totalXp < 500) {
      status = '🌱 Новичок - только начинаете путь к продуктивности!';
    } else if (user.totalXp < 2000) {
      status = '📈 Развиваетесь - уже видны первые результаты!';
    } else {
      status = '🚀 Опытный пользователь - отличные результаты!';
    }

    await ctx.editMessageTextWithMarkdown(
      `
📊 *Анализ профиля*

${status}

**Статистика:**
⭐ Опыт: ${user.totalXp} XP (уровень ${user.level})
📅 С ботом: ${accountDays} дней
📝 Задач создано: ${tasks.length}
✅ Выполнено: ${completedTasks.length} (${completionRate}%)

**Рекомендация:**
${
  completionRate > 70
    ? '🎯 Отлично! Попробуйте более сложные цели.'
    : completionRate > 40
      ? '💪 Хорошо! Сфокусируйтесь на завершении задач.'
      : '� Начните с малого - одна задача в день!'
}
      `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );
  }

  private async handleAIChatMessage(ctx: BotContext, message: string) {
    try {
      // Check billing limits for AI queries
      const limitCheck = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyAiQueries',
      );

      if (!limitCheck.allowed) {
        await ctx.replyWithMarkdown(
          limitCheck.message || '🚫 Превышен лимит ИИ-запросов',
          {
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
          },
        );
        return;
      }

      // Check if this is a reminder request
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

      // Check absolute time first
      let reminderMatch: RegExpMatchArray | null = null;
      for (const pattern of absoluteTimePatterns) {
        reminderMatch = message.match(pattern);
        if (reminderMatch) {
          const [, reminderText, hours, minutes] = reminderMatch;
          await this.handleReminderRequest(ctx, reminderText, hours, minutes);
          return;
        }
      }

      // Check relative time
      for (const pattern of relativeTimePatterns) {
        reminderMatch = message.match(pattern);
        if (reminderMatch) {
          const [, reminderText, minutesFromNow] = reminderMatch;
          await this.handleRelativeReminderRequest(
            ctx,
            reminderText,
            parseInt(minutesFromNow),
          );
          return;
        }
      }

      await ctx.replyWithMarkdown('🤔 *Анализирую ваш вопрос...*');

      // Получаем персонализированный ответ через AI Context Service
      const personalizedResponse =
        await this.aiContextService.generatePersonalizedMessage(
          ctx.userId,
          'motivation',
          `${message}. Ответь кратко, до 100 слов, конкретно и по делу.`,
        );

      // Increment AI usage counter
      await this.billingService.incrementUsage(ctx.userId, 'dailyAiQueries');

      // Get current usage for display
      const usageInfo = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyAiQueries',
      );

      await ctx.replyWithMarkdown(
        `
🧠 *ИИ отвечает:*

${personalizedResponse}

📊 ИИ-запросов: ${usageInfo.current}/${usageInfo.limit === -1 ? '∞' : usageInfo.limit}
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      await ctx.replyWithMarkdown(
        `
❌ *Ошибка ИИ-консультанта*

Извините, сейчас не могу ответить на ваш вопрос. Попробуйте позже или задайте другой вопрос.
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            ],
          },
        },
      );
    }
  }

  private async handleRelativeReminderRequest(
    ctx: BotContext,
    reminderText: string,
    minutesFromNow: number,
  ) {
    try {
      const user = await this.userService.findByTelegramId(ctx.userId);

      // Validate minutes
      if (minutesFromNow <= 0 || minutesFromNow > 1440) {
        // max 24 hours
        await ctx.editMessageTextWithMarkdown(`
❌ *Неверное время*

Пожалуйста, укажите от 1 до 1440 минут (максимум 24 часа)
        `);
        return;
      }

      // Calculate reminder time
      const now = new Date();
      const reminderDate = new Date(now.getTime() + minutesFromNow * 60 * 1000);

      // Schedule the reminder
      setTimeout(
        async () => {
          try {
            await ctx.telegram.sendMessage(
              ctx.userId,
              `🔔 *Напоминание!*

${reminderText}`,
              { parse_mode: 'Markdown' },
            );
          } catch (error) {
            this.logger.error('Error sending reminder:', error);
          }
        },
        minutesFromNow * 60 * 1000,
      );

      const timeStr = this.formatTimeWithTimezone(reminderDate, user?.timezone);

      await ctx.editMessageTextWithMarkdown(
        `✅ *Напоминание установлено!*

📝 **Текст:** ${reminderText}
⏰ **Время:** через ${minutesFromNow} минут (в ${timeStr})

Я напомню вам в указанное время! 🔔`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );

      // Add XP for using reminders
      await this.userService.updateUser(ctx.userId, {
        totalXp: user.totalXp + 5,
      });
    } catch (error) {
      this.logger.error('Error creating relative reminder:', error);
      await ctx.editMessageTextWithMarkdown(`
❌ *Ошибка создания напоминания*

Не удалось создать напоминание. Попробуйте ещё раз.
      `);
    }
  }

  private async handleReminderRequest(
    ctx: BotContext,
    reminderText: string,
    hours: string,
    minutes: string,
  ) {
    try {
      const user = await this.userService.findByTelegramId(ctx.userId);

      // Check billing limits for reminders
      const limitCheck = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyReminders',
      );

      if (!limitCheck.allowed) {
        await ctx.replyWithMarkdown(
          limitCheck.message || '🚫 Превышен лимит напоминаний',
          {
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
          },
        );
        return;
      }

      // Validate time
      const hourNum = parseInt(hours);
      const minuteNum = parseInt(minutes);

      if (hourNum < 0 || hourNum > 23 || minuteNum < 0 || minuteNum > 59) {
        await ctx.replyWithMarkdown(`
❌ *Неверное время*

Пожалуйста, укажите корректное время в формате ЧЧ:ММ (например, 17:30)
        `);
        return;
      }

      // Create reminder time for today
      const now = new Date();
      const reminderDate = new Date();
      reminderDate.setHours(hourNum, minuteNum, 0, 0);

      // If time has already passed today, set for tomorrow
      if (reminderDate <= now) {
        reminderDate.setDate(reminderDate.getDate() + 1);
      }

      // Сохраняем напоминание в базу данных
      const savedReminder = await this.prisma.reminder.create({
        data: {
          userId: ctx.userId,
          type: 'GENERAL',
          title: reminderText,
          message: reminderText,
          scheduledTime: reminderDate,
          status: ReminderStatus.ACTIVE,
        },
      });

      // Schedule the reminder (в реальном приложении лучше использовать очереди типа Bull или Agenda)
      const delay = reminderDate.getTime() - now.getTime();
      setTimeout(async () => {
        try {
          await ctx.telegram.sendMessage(
            ctx.userId,
            `🔔 *Напоминание!*\n\n${reminderText}`,
            { parse_mode: 'Markdown' },
          );

          // Обновляем статус напоминания на выполненное
          await this.prisma.reminder.update({
            where: { id: savedReminder.id },
            data: { status: ReminderStatus.COMPLETED },
          });
        } catch (error) {
          this.logger.error('Error sending reminder:', error);
        }
      }, delay);

      // Increment usage counter
      await this.billingService.incrementUsage(ctx.userId, 'dailyReminders');

      const timeStr = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
      const dateStr = reminderDate.toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
      });

      // Get current usage for display
      const usageInfo = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyReminders',
      );

      await ctx.replyWithMarkdown(
        `
✅ *Напоминание установлено!*

📝 **Текст:** ${reminderText}
⏰ **Время:** ${timeStr}
📅 **Дата:** ${dateStr}

📊 **Использовано сегодня:** ${usageInfo.current}/${usageInfo.limit === -1 ? '∞' : usageInfo.limit} напоминаний

Я напомню вам в указанное время! 🔔
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );

      // Add XP for using reminders
      await this.userService.updateUser(ctx.userId, {
        totalXp: user.totalXp + 5,
      });
    } catch (error) {
      this.logger.error('Error creating reminder:', error);
      await ctx.replyWithMarkdown(`
❌ *Ошибка создания напоминания*

Не удалось создать напоминание. Попробуйте ещё раз.
      `);
    }
  }

  private async handleReminderTimeInput(ctx: BotContext, timeInput: string) {
    try {
      const reminderText = ctx.session.pendingReminder;

      if (!reminderText) {
        await ctx.replyWithMarkdown('❌ Ошибка: текст напоминания не найден.');
        return;
      }

      // Try to parse different time formats
      let hours: string | undefined, minutes: string | undefined;

      // Format: HH:MM или H:MM
      const timeMatch = timeInput.match(/(\d{1,2}):(\d{2})/);
      if (timeMatch) {
        hours = timeMatch[1];
        minutes = timeMatch[2];
      }
      // Format: "в HH" или "в HH:MM"
      else {
        const inTimeMatch = timeInput.match(/в\s*(\d{1,2})(?::(\d{2}))?/i);
        if (inTimeMatch) {
          hours = inTimeMatch[1];
          minutes = inTimeMatch[2] || '00';
        }
        // Format: "через X минут"
        else {
          const minutesMatch = timeInput.match(/через\s*(\d+)\s*минут/i);
          if (minutesMatch) {
            const minutesToAdd = parseInt(minutesMatch[1]);
            const futureTime = new Date();
            futureTime.setMinutes(futureTime.getMinutes() + minutesToAdd);
            hours = futureTime.getHours().toString();
            minutes = futureTime.getMinutes().toString().padStart(2, '0');
          }
          // Format: "через X часов"
          else {
            const hoursMatch = timeInput.match(/через\s*(\d+)\s*час/i);
            if (hoursMatch) {
              const hoursToAdd = parseInt(hoursMatch[1]);
              const futureTime = new Date();
              futureTime.setHours(futureTime.getHours() + hoursToAdd);
              hours = futureTime.getHours().toString();
              minutes = futureTime.getMinutes().toString().padStart(2, '0');
            }
            // Try to parse just numbers as HH:MM
            else if (
              timeInput.match(/^\d{1,2}$/) &&
              parseInt(timeInput) <= 23
            ) {
              hours = timeInput;
              minutes = '00';
            }
          }
        }
      }

      // If no valid time format found
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

      // Validate parsed time
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

      // Clear session state
      ctx.session.pendingReminder = undefined;
      ctx.session.waitingForReminderTime = false;

      // Create the reminder
      await this.handleReminderRequest(ctx, reminderText, hours, minutes);
    } catch (error) {
      this.logger.error('Error processing reminder time input:', error);

      // Clear session state on error
      ctx.session.pendingReminder = undefined;
      ctx.session.waitingForReminderTime = false;

      await ctx.editMessageTextWithMarkdown(`
❌ *Ошибка обработки времени*

Попробуйте создать напоминание заново.
      `);
    }
  }

  private async handleAudioMessage(ctx: BotContext, type: 'voice' | 'audio') {
    try {
      const emoji = type === 'voice' ? '🎤' : '🎵';
      const messageType =
        type === 'voice' ? 'голосовое сообщение' : 'аудио файл';

      await ctx.replyWithMarkdown(`${emoji} *Обрабатываю ${messageType}...*`);

      const transcribedText = await this.transcribeAudio(ctx, type);
      if (!transcribedText) {
        await ctx.replyWithMarkdown(
          `❌ Не удалось распознать ${messageType}. Попробуйте еще раз.`,
        );
        return;
      }

      await ctx.replyWithMarkdown(`🎯 *Распознано:* "${transcribedText}"`);

      // Handle AI Chat mode for audio messages
      if (ctx.session.aiChatMode) {
        await this.handleAIChatMessage(ctx, transcribedText);
        return;
      }

      // Handle audio reminders
      if (this.isReminderRequest(transcribedText)) {
        await this.processReminderFromText(ctx, transcribedText);
        return;
      }

      // Handle voice commands for tasks
      if (
        transcribedText.toLowerCase().includes('добавить задачу') ||
        transcribedText.toLowerCase().includes('новая задача') ||
        transcribedText.toLowerCase().includes('создать задачу')
      ) {
        await this.startAddingTask(ctx);
        return;
      }

      // Handle voice commands for menu
      if (
        transcribedText.toLowerCase().includes('меню') ||
        transcribedText.toLowerCase().includes('главное меню') ||
        transcribedText.toLowerCase().includes('показать меню')
      ) {
        await this.showMainMenu(ctx);
        return;
      }

      // Handle voice commands for help
      if (
        transcribedText.toLowerCase().includes('помощь') ||
        transcribedText.toLowerCase().includes('справка') ||
        transcribedText.toLowerCase().includes('что ты умеешь')
      ) {
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

      // Handle voice commands for feedback
      if (
        transcribedText.toLowerCase().includes('обратная связь') ||
        transcribedText.toLowerCase().includes('отзыв') ||
        transcribedText.toLowerCase().includes('фидбек')
      ) {
        await this.showFeedbackSurvey(ctx);
        return;
      }

      // Handle voice commands for habits
      if (
        transcribedText.toLowerCase().includes('добавить привычку') ||
        transcribedText.toLowerCase().includes('новая привычка') ||
        transcribedText.toLowerCase().includes('создать привычку')
      ) {
        await this.startAddingHabit(ctx);
        return;
      }

      // Try to intelligently parse the transcribed text to create task/reminder/habit
      await this.analyzeAndCreateFromVoice(ctx, transcribedText);
    } catch (error) {
      this.logger.error(`${type} message processing error:`, error);
      await ctx.replyWithMarkdown(
        `❌ Произошла ошибка при обработке ${type === 'voice' ? 'голосового сообщения' : 'аудио файла'}.`,
      );
    }
  }

  private async transcribeAudio(
    ctx: BotContext,
    type: 'voice' | 'audio',
  ): Promise<string | null> {
    try {
      // Check if message exists and has the right type
      if (!ctx.message) {
        return null;
      }

      let fileId: string;

      if (type === 'voice' && 'voice' in ctx.message) {
        fileId = ctx.message.voice.file_id;
      } else if (type === 'audio' && 'audio' in ctx.message) {
        fileId = ctx.message.audio.file_id;
      } else {
        return null;
      }

      // Get file info and download
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const response = await fetch(fileLink.href);
      const buffer = await response.arrayBuffer();

      // Create a File object for OpenAI
      const fileName = type === 'voice' ? 'voice.ogg' : 'audio.mp3';
      const mimeType = type === 'voice' ? 'audio/ogg' : 'audio/mpeg';
      const file = new File([buffer], fileName, { type: mimeType });

      // Use OpenAI Whisper for transcription
      const transcription = await this.openaiService.transcribeAudio(file);

      return transcription;
    } catch (error) {
      this.logger.error(`Error transcribing ${type}:`, error);
      return null;
    }
  }

  private async processReminderFromText(ctx: BotContext, text: string) {
    // Extract time and reminder text from voice/text input
    const timeMatch =
      text.match(/в\s*(\d{1,2}):(\d{2})/i) ||
      text.match(/в\s*(\d{1,2})\s*час(?:а|ов)?(?:\s*(\d{2})\s*минут)?/i) ||
      text.match(/на\s*(\d{1,2}):(\d{2})/i) ||
      text.match(/к\s*(\d{1,2}):(\d{2})/i);

    if (timeMatch) {
      const hours = timeMatch[1];
      const minutes = timeMatch[2] || '00';

      // Extract reminder text by removing time references and trigger words
      const reminderText = text
        .replace(/напомни\s*(мне)?/gi, '')
        .replace(/напоминание/gi, '')
        .replace(/поставь/gi, '')
        .replace(/установи/gi, '')
        .replace(/в\s*\d{1,2}:?\d{0,2}\s*(?:час|минут)?(?:а|ов)?/gi, '')
        .replace(/на\s*\d{1,2}:?\d{0,2}/gi, '')
        .replace(/к\s*\d{1,2}:?\d{0,2}/gi, '')
        .trim();

      // If no text left, ask for clarification
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

    // Handle relative time (через X минут/часов)
    const relativeMatch = text.match(/через\s*(\d+)\s*(минут|час)/i);
    if (relativeMatch) {
      const amount = parseInt(relativeMatch[1]);
      const unit = relativeMatch[2];

      const now = new Date();
      if (unit.includes('час')) {
        now.setHours(now.getHours() + amount);
      } else {
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

    // Check if this is a reminder request without time
    const isReminderWithoutTime = this.isReminderWithoutTime(text);
    if (isReminderWithoutTime) {
      // Extract reminder text by removing trigger words
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
        // Store reminder text in session and ask for time
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

    // If no specific time found and not a clear reminder request, ask for clarification
    await ctx.replyWithMarkdown(`
🤔 *Не удалось определить время напоминания*

Пожалуйста, укажите время в формате:
• "напомни купить молоко в 17:30"
• "напомни позвонить маме через 30 минут"
    `);
  }

  private isReminderWithoutTime(text: string): boolean {
    const reminderPatterns = [
      /напомни(?:\s+мне)?\s+.+/i,
      /напомню(?:\s+мне)?\s+.+/i,
      /напоминание\s+.+/i,
      /поставь\s+напоминание\s+.+/i,
      /установи\s+напоминание\s+.+/i,
      /нужно\s+напомнить\s+.+/i,
      /не\s+забыть\s+.+/i,
    ];

    // Check if it's a reminder request but doesn't have time indicators
    const hasReminderTrigger = reminderPatterns.some((pattern) =>
      pattern.test(text),
    );
    const hasTimeIndicator =
      /в\s*\d{1,2}:?\d{0,2}|на\s*\d{1,2}:?\d{0,2}|к\s*\d{1,2}:?\d{0,2}|через\s*\d+\s*(?:минут|час)/i.test(
        text,
      );

    return hasReminderTrigger && !hasTimeIndicator;
  }

  private isReminderRequest(text: string): boolean {
    const reminderPatterns = [
      // ТОЛЬКО полные формы с конкретным временем
      /напомни.*в\s*(\d{1,2}):(\d{2})/i,
      /напомни.*в\s*(\d{1,2})\s*час/i,
      /напомни.*через\s*(\d+)\s*(минут|час)/i,
      /напомню.*в\s*(\d{1,2}):(\d{2})/i,
      /напомню.*в\s*(\d{1,2})\s*час/i,
      /напомню.*через\s*(\d+)\s*(минут|час)/i,
      /напоминание.*в\s*(\d{1,2}):(\d{2})/i,
      /напоминание.*через\s*(\d+)\s*(минут|час)/i,

      // Альтернативные формы только с временем
      /поставь.*напоминание.*в\s*(\d{1,2}):(\d{2})/i,
      /установи.*напоминание.*в\s*(\d{1,2}):(\d{2})/i,
      /поставь.*напоминание.*через\s*(\d+)\s*(минут|час)/i,
      /установи.*напоминание.*через\s*(\d+)\s*(минут|час)/i,
    ];

    return reminderPatterns.some((pattern) => pattern.test(text));
  }

  private isTaskRequest(text: string): boolean {
    console.log('🔍 isTaskRequest анализирует текст:', text);

    // Исключаем очень короткие тексты (1-2 слова без глаголов действия)
    const words = text.trim().split(/\s+/);
    if (words.length <= 2) {
      // Для коротких фраз требуем явные глаголы действия
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
      ];

      const hasActionVerb = actionVerbs.some((verb) =>
        text.toLowerCase().includes(verb),
      );

      if (!hasActionVerb) {
        console.log('❌ Отклонено: короткий текст без глаголов действия');
        return false;
      }
    }

    // Проверяем, что это задача без конкретного времени
    const taskPatterns = [
      /^(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать)/i,
      /нужно\s+(сделать|выполнить|купить|позвонить|написать|отправить|подготовить)/i,
      /надо\s+(сделать|выполнить|купить|позвонить|написать|отправить|подготовить)/i,
      /^пить\s+/i, // "пить воду", "пить чай" и т.д.
      /^делать\s+/i, // "делать зарядку"
      /^читать\s+/i, // "читать книги"
      /каждый\s+(день|час|минут)/i, // фразы с повторением
      /каждые\s+\d+/i, // "каждые 5 минут"
    ];

    // Исключаем фразы с временными маркерами (конкретное время)
    const timePatterns = [
      /в\s*(\d{1,2}):(\d{2})/i, // "в 15:30"
      /в\s*(\d{1,2})\s*час/i, // "в 3 часа"
      /через\s*(\d+)\s*(минут|час)/i, // "через 2 часа"
      /завтра\s+в\s+/i, // "завтра в"
      /сегодня\s+в\s+/i, // "сегодня в"
    ];

    // Исключаем слова-триггеры для напоминаний
    const reminderTriggers = [/напомни|напомню|напоминание|remind/i];

    console.log('📊 Результаты проверки паттернов:');
    console.log(
      '- Паттерны задач найдены:',
      taskPatterns.some((p) => p.test(text)),
    );
    console.log(
      '- Временные маркеры найдены:',
      timePatterns.some((p) => p.test(text)),
    );
    console.log(
      '- Триггеры напоминаний найдены:',
      reminderTriggers.some((p) => p.test(text)),
    );
    console.log('- Длина текста:', text.length);
    console.log('- Количество слов:', words.length);

    // Проверяем, что нет временных маркеров и триггеров напоминаний
    const hasTimeMarkers = timePatterns.some((pattern) => pattern.test(text));
    const hasReminderTriggers = reminderTriggers.some((pattern) =>
      pattern.test(text),
    );

    if (hasTimeMarkers || hasReminderTriggers) {
      console.log(
        '❌ Отклонено: найдены временные маркеры или триггеры напоминаний',
      );
      return false;
    }

    // Проверяем, что это похоже на задачу (только если есть явные паттерны)
    const isTask = taskPatterns.some((pattern) => pattern.test(text));

    console.log('✅ Итоговый результат isTaskRequest:', isTask);
    return isTask;
  }

  private isGeneralChatMessage(text: string): boolean {
    const generalPatterns = [
      // Приветствия
      /^(привет|здравствуй|добрый день|добрый вечер|хай|hello|hi)\b/i,

      // Прощания
      /^(пока|до свидания|увидимся|всего хорошего|bye|goodbye)\b/i,

      // Общие вопросы и обращения к ИИ
      /ответь на вопрос/i,
      /что мне делать/i,
      /как дела/i,
      /как поживаешь/i,
      /что нового/i,
      /расскажи/i,
      /объясни/i,
      /помоги понять/i,
      /что думаешь/i,
      /твое мнение/i,
      /как считаешь/i,
      /посоветуй/i,
      /что лучше/i,

      // Философские и общие вопросы
      /смысл жизни/i,
      /что такое/i,
      /почему/i,
      /зачем/i,

      // Эмоциональные высказывания
      /устал/i,
      /грустно/i,
      /весело/i,
      /скучно/i,
      /интересно/i,

      // Благодарности
      /спасибо/i,
      /благодар/i,
      /thanks/i,
    ];

    // Исключаем команды бота и конкретные задачи
    const excludePatterns = [
      /\/\w+/, // команды бота
      /добавить|создать|сделать|выполнить|купить|позвонить|написать|отправить/i, // глаголы действий
      /в\s*\d{1,2}:\d{2}/, // временные метки
      /через\s+\d+/, // временные промежутки
      /напомни|напоминание/i, // напоминания
      /завтра|сегодня|вчера/i, // конкретные дни (если не общий вопрос)
    ];

    // Проверяем исключения
    const hasExclusions = excludePatterns.some((pattern) => pattern.test(text));
    if (hasExclusions) {
      return false;
    }

    // Проверяем общие паттерны
    const isGeneral = generalPatterns.some((pattern) => pattern.test(text));

    console.log('🤖 isGeneralChatMessage анализ:', {
      text,
      isGeneral,
      hasExclusions,
    });

    return isGeneral;
  }

  private async createTaskFromText(ctx: BotContext, text: string) {
    try {
      const user = await this.userService.findByTelegramId(ctx.userId);

      if (!user.timezone) {
        ctx.session.step = 'waiting_for_task_title';
        ctx.session.tempData = { taskTitle: text };
        await this.askForTimezone(ctx);
        return;
      }

      // Создаем задачу из текста
      const task = await this.taskService.createTask({
        userId: ctx.userId,
        title: text.trim(),
      });

      await ctx.replyWithMarkdown(
        `
✅ *Задача создана!*

📝 **"${task.title}"**

Задача добавлена в ваш список. Вы можете найти её в разделе "Мои задачи и привычки".

💡 *Подсказка:* Если хотите создать напоминание на конкретное время, используйте фразы типа "напомни купить молоко в 17:30"
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Мои задачи', callback_data: 'tasks_list' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error(`Error creating task from text: ${error}`);
      await ctx.replyWithMarkdown(
        '❌ Произошла ошибка при создании задачи. Попробуйте позже.',
      );
    }
  }

  private async showTasksAIAdvice(ctx: BotContext) {
    try {
      await ctx.editMessageTextWithMarkdown('🤔 *Анализирую ваши задачи...*');

      // Получаем персонализированный совет по задачам
      const aiAdvice = await this.aiContextService.generatePersonalizedMessage(
        ctx.userId,
        'task_suggestion',
        '',
      );

      await ctx.editMessageTextWithMarkdown(
        `
🤖 *AI-совет по задачам:*

${aiAdvice}

💡 *Хотите ещё советы?* Просто напишите мне в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Добавить задачу', callback_data: 'tasks_add' }],
              [{ text: '🔙 Назад к задачам', callback_data: 'back_to_tasks' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error getting AI advice for tasks:', error);
      await ctx.editMessageTextWithMarkdown(
        `
❌ *Не удалось получить AI-совет*

Попробуйте позже или напишите мне напрямую в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад к задачам', callback_data: 'back_to_tasks' }],
            ],
          },
        },
      );
    }
  }

  private async showHabitsAIAdvice(ctx: BotContext) {
    try {
      await ctx.editMessageTextWithMarkdown('🤔 *Анализирую ваши привычки...*');

      // Получаем персонализированный совет по привычкам
      const aiAdvice = await this.aiContextService.generatePersonalizedMessage(
        ctx.userId,
        'habit_advice',
        '',
      );

      await ctx.editMessageTextWithMarkdown(
        `
🤖 *AI-совет по привычкам:*

${aiAdvice}

💡 *Хотите ещё советы?* Просто напишите мне в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад к привычкам', callback_data: 'menu_habits' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error getting AI advice for habits:', error);
      await ctx.editMessageTextWithMarkdown(
        `
❌ *Не удалось получить AI-совет*

Попробуйте позже или напишите мне напрямую в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад к привычкам', callback_data: 'menu_habits' }],
            ],
          },
        },
      );
    }
  }

  // Command handler methods
  private async showHabitsMenu(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    if (!user.timezone) {
      ctx.session.step = 'adding_habit';
      await this.askForTimezone(ctx);
    } else {
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
          } else {
            await ctx.replyWithMarkdown(message, keyboard);
          }
        } else {
          message += `📊 **Всего привычек:** ${habits.length}\n\n`;
          message += `*Выберите привычку для выполнения:*`;

          // Create keyboard with habit completion buttons
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
          } else {
            await ctx.replyWithMarkdown(message, {
              reply_markup: keyboard,
            });
          }
        }
      } catch (error) {
        this.logger.error(`Error fetching habits: ${error}`);

        const errorMessage =
          '❌ Произошла ошибка при загрузке привычек. Попробуйте позже.';
        const errorKeyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        };

        if (ctx.callbackQuery) {
          await ctx.editMessageTextWithMarkdown(errorMessage, errorKeyboard);
        } else {
          await ctx.replyWithMarkdown(errorMessage, errorKeyboard);
        }
      }
    }
  }

  private async showMoodMenu(ctx: BotContext) {
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

    // Check if this is a callback query (can edit) or command (need to reply)
    if (ctx.callbackQuery) {
      await ctx.editMessageTextWithMarkdown(message, keyboard);
    } else {
      await ctx.replyWithMarkdown(message, keyboard);
    }
  }

  private async showMoodAIAnalysis(ctx: BotContext) {
    try {
      await ctx.editMessageTextWithMarkdown(
        '🤔 *Анализирую ваше настроение...*',
      );

      // Получаем персонализированный анализ настроения
      const aiAnalysis =
        await this.aiContextService.generatePersonalizedMessage(
          ctx.userId,
          'mood_analysis',
          '',
        );

      await ctx.editMessageTextWithMarkdown(
        `
🤖 *AI-анализ настроения:*

${aiAnalysis}

💡 *Хотите персональные советы?* Просто напишите мне в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '😊 Отметить настроение', callback_data: 'menu_mood' }],
              [{ text: '🔙 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error getting AI mood analysis:', error);
      await ctx.editMessageTextWithMarkdown(
        `
❌ *Не удалось получить AI-анализ*

Попробуйте позже или напишите мне напрямую в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 К настроению', callback_data: 'menu_mood' }],
            ],
          },
        },
      );
    }
  }

  private async showFocusSession(ctx: BotContext) {
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

    // Check if this is a callback query (can edit) or command (need to reply)
    if (ctx.callbackQuery) {
      await ctx.editMessageTextWithMarkdown(message, keyboard);
    } else {
      await ctx.replyWithMarkdown(message, keyboard);
    }
  }

  private async showRemindersMenu(ctx: BotContext) {
    try {
      // Получаем активные напоминания пользователя
      const reminders = await this.prisma.reminder.findMany({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.ACTIVE,
          scheduledTime: {
            gte: new Date(), // Только будущие напоминания
          },
        },
        orderBy: {
          scheduledTime: 'asc',
        },
        take: 10, // Показываем максимум 10 ближайших напоминаний
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
            ],
            [{ text: '📝 Все напоминания', callback_data: 'all_reminders' }],
            [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        };

        if (ctx.callbackQuery) {
          await ctx.editMessageTextWithMarkdown(message, {
            reply_markup: keyboard,
          });
        } else {
          await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
        }
        return;
      }

      message += `📊 **Активных напоминаний:** ${reminders.length}\n\n`;
      message += `*Ближайшие напоминания:*\n\n`;

      // Отображаем список напоминаний
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
            { text: '📝 Все напоминания', callback_data: 'all_reminders' },
          ],
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
      } else {
        await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
      }
    } catch (error) {
      this.logger.error(`Error fetching reminders: ${error}`);

      const errorMessage =
        '❌ Произошла ошибка при загрузке напоминаний. Попробуйте позже.';
      const errorKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      };

      if (ctx.callbackQuery) {
        await ctx.editMessageTextWithMarkdown(errorMessage, errorKeyboard);
      } else {
        await ctx.replyWithMarkdown(errorMessage, errorKeyboard);
      }
    }
  }

  private async showAllReminders(ctx: BotContext) {
    try {
      // Получаем все напоминания пользователя (активные и завершенные)
      const activeReminders = await this.prisma.reminder.findMany({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.ACTIVE,
        },
        orderBy: {
          scheduledTime: 'asc',
        },
      });

      const completedReminders = await this.prisma.reminder.findMany({
        where: {
          userId: ctx.userId,
          status: { in: [ReminderStatus.COMPLETED, ReminderStatus.DISMISSED] },
        },
        orderBy: {
          scheduledTime: 'desc',
        },
        take: 5, // Показываем последние 5 завершенных
      });

      let message = `🔔 *Все напоминания*\n\n`;

      // Активные напоминания
      if (activeReminders.length > 0) {
        message += `🟢 **Активные (${activeReminders.length}):**\n\n`;

        activeReminders.forEach((reminder, index) => {
          const date = new Date(reminder.scheduledTime);
          const isToday = date.toDateString() === new Date().toDateString();
          const isTomorrow =
            date.toDateString() ===
            new Date(Date.now() + 24 * 60 * 60 * 1000).toDateString();

          let dateStr;
          if (isToday) {
            dateStr = 'сегодня';
          } else if (isTomorrow) {
            dateStr = 'завтра';
          } else {
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
      } else {
        message += `🟢 **Активные:** нет\n\n`;
      }

      // Завершенные напоминания
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

          const statusIcon =
            reminder.status === ReminderStatus.COMPLETED ? '✅' : '❌';

          message += `${index + 1}. ${statusIcon} ${reminder.title}\n`;
          message += `    📅 ${dateStr} в ${timeStr}\n\n`;
        });
      } else {
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
    } catch (error) {
      this.logger.error(`Error fetching all reminders: ${error}`);
      await ctx.editMessageTextWithMarkdown(
        '❌ Произошла ошибка при загрузке напоминаний. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'reminders' }],
            ],
          },
        },
      );
    }
  }

  private async showCreateReminderHelp(ctx: BotContext) {
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

  private async showManageReminders(ctx: BotContext) {
    try {
      // Получаем активные напоминания пользователя
      const reminders = await this.prisma.reminder.findMany({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.ACTIVE,
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

      // Создаем кнопки для каждого напоминания (максимум 8)
      const keyboard = {
        inline_keyboard: [
          ...reminders.slice(0, 8).map((reminder) => {
            const date = new Date(reminder.scheduledTime);
            const timeStr = date.toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            });
            const title =
              reminder.title.length > 25
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
    } catch (error) {
      this.logger.error(`Error showing manage reminders: ${error}`);
      await ctx.editMessageTextWithMarkdown(
        '❌ Произошла ошибка. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'reminders' }],
            ],
          },
        },
      );
    }
  }

  private async showRemindersStats(ctx: BotContext) {
    try {
      // Получаем статистику по напоминаниям
      const totalActive = await this.prisma.reminder.count({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.ACTIVE,
        },
      });

      const totalCompleted = await this.prisma.reminder.count({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.COMPLETED,
        },
      });

      const totalDismissed = await this.prisma.reminder.count({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.DISMISSED,
        },
      });

      const todayCompleted = await this.prisma.reminder.count({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.COMPLETED,
          scheduledTime: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
            lte: new Date(new Date().setHours(23, 59, 59, 999)),
          },
        },
      });

      // Получаем ближайшее напоминание
      const nextReminder = await this.prisma.reminder.findFirst({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.ACTIVE,
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
        const isTomorrow =
          nextDate.toDateString() ===
          new Date(Date.now() + 24 * 60 * 60 * 1000).toDateString();

        let dateStr;
        if (isToday) {
          dateStr = 'сегодня';
        } else if (isTomorrow) {
          dateStr = 'завтра';
        } else {
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
      } else {
        message += `**Ближайшее напоминание:**\n`;
        message += `Нет активных напоминаний`;
      }

      const keyboard = {
        inline_keyboard: [
          [
            { text: '🔔 Мои напоминания', callback_data: 'reminders' },
            { text: '➕ Создать', callback_data: 'create_reminder_help' },
          ],
          [{ text: '⬅️ Назад', callback_data: 'reminders' }],
        ],
      };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error(`Error showing reminders stats: ${error}`);
      await ctx.editMessageTextWithMarkdown(
        '❌ Произошла ошибка при загрузке статистики. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'reminders' }],
            ],
          },
        },
      );
    }
  }

  private async handleDeleteReminder(ctx: BotContext, reminderId: string) {
    try {
      // Найдем и удалим напоминание
      const reminder = await this.prisma.reminder.findFirst({
        where: {
          id: reminderId,
          userId: ctx.userId, // Убеждаемся, что пользователь может удалять только свои напоминания
        },
      });

      if (!reminder) {
        await ctx.editMessageTextWithMarkdown(
          '❌ *Напоминание не найдено*\n\nВозможно, оно уже было удалено.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔔 К напоминаниям', callback_data: 'reminders' }],
              ],
            },
          },
        );
        return;
      }

      // Удаляем напоминание
      await this.prisma.reminder.delete({
        where: {
          id: reminderId,
        },
      });

      await ctx.editMessageTextWithMarkdown(
        `✅ *Напоминание удалено*\n\n📝 "${reminder.title}" было успешно удалено из списка напоминаний.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✏️ Управление', callback_data: 'manage_reminders' },
                { text: '🔔 К напоминаниям', callback_data: 'reminders' },
              ],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error(`Error deleting reminder: ${error}`);
      await ctx.editMessageTextWithMarkdown(
        '❌ Произошла ошибка при удалении напоминания. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'manage_reminders' }],
            ],
          },
        },
      );
    }
  }

  private async showFocusAITips(ctx: BotContext) {
    try {
      await ctx.editMessageTextWithMarkdown(
        '🤔 *Анализирую ваши паттерны фокуса...*',
      );

      // Получаем персонализированные советы по фокусу
      const aiTips = await this.aiContextService.generatePersonalizedMessage(
        ctx.userId,
        'focus_tips',
        '',
      );

      await ctx.editMessageTextWithMarkdown(
        `
🤖 *AI-советы по фокусу:*

${aiTips}

💡 *Хотите персональную помощь?* Просто напишите мне в чат!
        `,
        {
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
        },
      );
    } catch (error) {
      this.logger.error('Error getting AI focus tips:', error);
      await ctx.editMessageTextWithMarkdown(
        `
❌ *Не удалось получить AI-советы*

Попробуйте позже или напишите мне напрямую в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 К фокус-сессиям', callback_data: 'menu_focus' }],
            ],
          },
        },
      );
    }
  }

  private async createPayment(
    ctx: BotContext,
    subscriptionType: 'PREMIUM' | 'PREMIUM_PLUS',
  ) {
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

      await ctx.editMessageTextWithMarkdown(
        `
💎 *Оплата ${subscriptionType === 'PREMIUM' ? 'Premium' : 'Premium Plus'}*

💰 **Сумма:** ${plan.amount}₽
📅 **Период:** ${plan.period}

**Что включено:**
${plan.features.map((feature) => `• ${feature}`).join('\n')}

🔗 Для оплаты перейдите по ссылке ниже:
        `,
        {
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
        },
      );
    } catch (error) {
      this.logger.error('Error creating payment:', error);
      await ctx.editMessageTextWithMarkdown(
        `
❌ *Ошибка создания платежа*

Попробуйте позже или свяжитесь с поддержкой.
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'upgrade_premium' }],
            ],
          },
        },
      );
    }
  }

  /**
   * Безопасно получает пользователя, создавая его при необходимости
   */
  private async getOrCreateUser(ctx: BotContext): Promise<User> {
    try {
      return await this.userService.findByTelegramId(ctx.userId);
    } catch (error) {
      // Пользователь не найден, создаем его
      const userData = {
        id: ctx.from?.id.toString() || ctx.userId,
        username: ctx.from?.username || undefined,
        firstName: ctx.from?.first_name || undefined,
        lastName: ctx.from?.last_name || undefined,
      };

      return await this.userService.findOrCreateUser(userData);
    }
  }

  /**
   * Handles XP purchases from the shop
   */
  private async handleXPPurchase(
    ctx: BotContext,
    itemType: 'theme' | 'badge' | 'emoji' | 'sticker' | 'feature',
    cost: number,
    itemName: string,
    itemId: string,
  ): Promise<void> {
    await ctx.answerCbQuery();

    try {
      const user = await this.userService.findByTelegramId(ctx.userId);

      // Check if user has enough XP
      if (user.totalXp < cost) {
        await ctx.editMessageTextWithMarkdown(
          `❌ *Недостаточно XP*

Для покупки "${itemName}" нужно ${cost} XP.
У вас: ${user.totalXp} XP
Нужно еще: ${cost - user.totalXp} XP

💪 Выполняйте задачи и привычки для заработка XP!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Назад в магазин', callback_data: 'xp_shop' }],
              ],
            },
          },
        );
        return;
      }

      // Check if user already owns this item
      const alreadyOwned = this.checkIfUserOwnsItem(user, itemType, itemId);

      if (alreadyOwned) {
        await ctx.editMessageTextWithMarkdown(
          `✅ *Уже приобретено*

У вас уже есть "${itemName}".

Выберите что-то другое в магазине!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Назад в магазин', callback_data: 'xp_shop' }],
              ],
            },
          },
        );
        return;
      }

      // Process purchase
      await this.processXPPurchase(user, itemType, itemId);

      // Update user XP
      await this.userService.updateUserStats(ctx.userId, {
        xpGained: -cost, // Subtract XP
      });

      await ctx.editMessageTextWithMarkdown(
        `🎉 *Покупка успешна!*

Вы приобрели: "${itemName}"
Потрачено: ${cost} XP
Остаток XP: ${user.totalXp - cost}

${this.getItemActivationMessage(itemType)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🛍️ Продолжить покупки', callback_data: 'xp_shop' },
                { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
              ],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error(`Error processing XP purchase: ${error}`);
      await ctx.editMessageTextWithMarkdown(
        '❌ Произошла ошибка при покупке. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад в магазин', callback_data: 'xp_shop' }],
            ],
          },
        },
      );
    }
  }

  /**
   * Check if user already owns a specific item
   */
  private checkIfUserOwnsItem(
    user: User,
    itemType: string,
    itemId: string,
  ): boolean {
    switch (itemType) {
      case 'theme':
        return user.unlockedThemes.includes(itemId);
      case 'badge':
      case 'emoji':
      case 'sticker':
        return user.stickers.includes(itemId);
      case 'feature':
        // For features, we could add a separate field or use stickers array
        return user.stickers.includes(`feature_${itemId}`);
      default:
        return false;
    }
  }

  /**
   * Process the actual purchase and update user data
   */
  private async processXPPurchase(
    user: User,
    itemType: string,
    itemId: string,
  ): Promise<void> {
    const updateData: Partial<User> = {};

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

  /**
   * Get activation message based on item type
   */
  private getItemActivationMessage(itemType: string): string {
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

  private async completeHabit(ctx: BotContext, habitId: string) {
    try {
      // В будущем здесь будет логика выполнения привычки через HabitService
      // Пока что просто показываем сообщение
      await ctx.editMessageTextWithMarkdown(
        `
✅ *Привычка выполнена!*

🎯 Отличная работа! Вы на пути к формированию полезной привычки.

💡 *Функция выполнения привычек в разработке - скоро будет полноценная система отслеживания!*
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Мои привычки', callback_data: 'habits_list' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error completing habit:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при выполнении привычки',
      );
    }
  }

  private async showAllHabitsList(ctx: BotContext) {
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

      // Create keyboard with all habits
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
    } catch (error) {
      this.logger.error('Error showing all habits list:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при получении списка привычек',
      );
    }
  }

  private async confirmTimezone(ctx: BotContext, timezone: string) {
    try {
      // Сохраняем часовой пояс в базу данных
      await this.userService.updateUser(ctx.userId, {
        timezone: timezone,
      });

      await ctx.editMessageTextWithMarkdown(`
✅ *Часовой пояс установлен!*

🕐 Часовой пояс: ${timezone}

Теперь можете создавать задачи и привычки!
      `);

      // Reset session step
      ctx.session.step = undefined;

      // Продолжить с тем действием, которое пользователь хотел сделать
      if (ctx.session.pendingAction === 'adding_task') {
        ctx.session.pendingAction = undefined;
        await this.startAddingTask(ctx);
      } else if (ctx.session.pendingAction === 'adding_habit') {
        ctx.session.pendingAction = undefined;
        ctx.session.step = 'adding_habit';
        await ctx.editMessageTextWithMarkdown(
          '🔄 *Добавление привычки*\n\nВведите название привычки, которую хотите отслеживать:',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      } else {
        await this.showMainMenu(ctx);
      }
    } catch (error) {
      this.logger.error('Error confirming timezone:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при сохранении часового пояса',
      );
    }
  }

  private async showTimezoneList(ctx: BotContext) {
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

    await ctx.editMessageTextWithMarkdown(
      `
🕐 *Выберите часовой пояс*

Выберите ближайший к вам город:`,
      {
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
      },
    );
  }

  /**
   * Format time string with user's timezone
   */
  private formatTimeWithTimezone(date: Date, timezone?: string | null): string {
    return date.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone || 'Europe/Moscow',
    });
  }

  /**
   * Start adding habit process from voice command
   */
  private async startAddingHabit(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    if (!user.timezone) {
      ctx.session.pendingAction = 'adding_habit';
      await this.askForTimezone(ctx);
      return;
    }

    ctx.session.step = 'adding_habit';
    await ctx.replyWithMarkdown(
      '🔄 *Добавление привычки*\n\nВведите название привычки, которую хотите отслеживать:',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );
  }

  /**
   * Analyze voice transcription and intelligently create task/reminder/habit
   */
  private async analyzeAndCreateFromVoice(ctx: BotContext, text: string) {
    const lowercaseText = text.toLowerCase();

    // First check for reminder with specific time
    const isReminder = this.isReminderRequest(text);
    if (isReminder) {
      await this.processReminderFromText(ctx, text);
      return;
    }

    // Then check for habit patterns
    const isHabit = this.isHabitRequest(lowercaseText);
    if (isHabit) {
      const habitName = this.extractHabitName(text);
      await this.createHabitFromVoice(ctx, habitName);
      return;
    }

    // Default: create task (for any other text without specific time)
    const taskName = this.extractTaskName(text);
    await this.createTaskFromVoice(ctx, taskName);
  }

  private isHabitRequest(text: string): boolean {
    return (
      text.includes('привычка') ||
      text.includes('каждый день') ||
      text.includes('ежедневно') ||
      text.includes('регулярно') ||
      text.includes('постоянно')
    );
  }

  private extractHabitName(text: string): string {
    return text
      .replace(/добавить\s*(привычку)?/gi, '')
      .replace(/новая\s*привычка/gi, '')
      .replace(/создать\s*(привычку)?/gi, '')
      .replace(/каждый\s*день/gi, '')
      .replace(/ежедневно/gi, '')
      .replace(/регулярно/gi, '')
      .trim();
  }

  private extractTaskName(text: string): string {
    return text
      .replace(/добавить\s*(задачу)?/gi, '')
      .replace(/новая\s*задача/gi, '')
      .replace(/создать\s*(задачу)?/gi, '')
      .replace(/сделать/gi, '')
      .replace(/нужно/gi, '')
      .replace(/надо/gi, '')
      .trim();
  }

  private async createHabitFromVoice(ctx: BotContext, habitName: string) {
    if (!habitName || habitName.length < 2) {
      await ctx.replyWithMarkdown(
        '⚠️ Не удалось извлечь название привычки. Попробуйте еще раз.',
      );
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

      await ctx.replyWithMarkdown(
        `✅ *Привычка "${habitName}" создана!*

🎯 Теперь вы можете отслеживать её выполнение в разделе "Мои привычки".

*Напоминание:* Регулярность - ключ к формированию привычек!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Мои привычки', callback_data: 'menu_habits' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error(`Error creating habit from voice: ${error}`);
      await ctx.replyWithMarkdown(
        '❌ Произошла ошибка при создании привычки. Попробуйте позже.',
      );
    }
  }

  private async createTaskFromVoice(ctx: BotContext, taskName: string) {
    if (!taskName || taskName.length < 2) {
      await ctx.replyWithMarkdown(
        '⚠️ Не удалось извлечь название задачи. Попробуйте еще раз.',
      );
      return;
    }

    try {
      const user = await this.getOrCreateUser(ctx);

      // Check billing limits
      const limitCheck = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyTasks',
      );

      if (!limitCheck.allowed) {
        await ctx.replyWithMarkdown(
          limitCheck.message || '🚫 Превышен лимит задач',
        );
        return;
      }

      const task = await this.taskService.createTask({
        userId: ctx.userId,
        title: taskName,
        description: undefined,
        priority: 'MEDIUM',
      });

      // Increment usage
      await this.billingService.incrementUsage(ctx.userId, 'dailyTasks');

      await ctx.replyWithMarkdown(
        `✅ *Задача "${taskName}" создана!*

📋 ID: ${task.id}

Задачу можно найти в разделе "Мои задачи".`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Мои задачи', callback_data: 'menu_tasks' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error(`Error creating task from voice: ${error}`);
      await ctx.replyWithMarkdown(
        '❌ Произошла ошибка при создании задачи. Попробуйте позже.',
      );
    }
  }

  private startDailyMotivation(userId: string, dependencyType: string) {
    // Запускаем ежедневные мотивационные сообщения в 21:00
    const sendTime = '21:00';

    this.logger.log(
      `Starting daily motivation for user ${userId}, dependency: ${dependencyType}, time: ${sendTime}`,
    );

    // Здесь можно добавить cron job или scheduler для отправки ежедневных сообщений
    // Для простоты сейчас просто логируем

    // Отправляем первое мотивационное сообщение через 5 секунд для демонстрации
    setTimeout(async () => {
      try {
        const message = await this.generateMotivationalMessage(dependencyType);
        await this.bot.telegram.sendMessage(userId, message, {
          parse_mode: 'Markdown',
        });
      } catch (error) {
        this.logger.error(`Error sending first motivational message: ${error}`);
      }
    }, 5000);
  }

  private async generateMotivationalMessage(
    dependencyType: string,
  ): Promise<string> {
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
    const randomMessage =
      messageArray[Math.floor(Math.random() * messageArray.length)];

    return `🤖 *Ежедневная мотивация*\n\n${randomMessage}\n\n#МотивацияДня #БорьбаСЗависимостью`;
  }
}
