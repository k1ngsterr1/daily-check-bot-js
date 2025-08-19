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
import { BillingService } from '../services/billing.service';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Telegraf<BotContext>;

  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
    private readonly openaiService: OpenAIService,
    private readonly taskService: TaskService,
    private readonly billingService: BillingService,
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

      // Handle waiting for reminder time
      if (ctx.session.waitingForReminderTime && ctx.session.pendingReminder) {
        await this.handleReminderTimeInput(ctx, ctx.message.text);
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
        return;
      }

      // Handle reminder requests in regular text mode
      if (this.isReminderRequest(ctx.message.text)) {
        await this.processReminderFromText(ctx, ctx.message.text);
        return;
      }

      // Skip if this is a command (starts with /)
      if (ctx.message.text.startsWith('/')) {
        return; // Let command handlers process it
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
      await this.startAIChat(ctx);
    });

    this.bot.action('more_functions', async (ctx) => {
      await ctx.answerCbQuery();
      const keyboard = {
        inline_keyboard: [
          [
            { text: '🎯 Прогресс и стрики', callback_data: 'progress_streaks' },
            { text: '🏆 Лидерборды', callback_data: 'leaderboards' },
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
            { text: '👤 Профиль', callback_data: 'user_profile' },
          ],
          [
            { text: '⚙️ Настройки', callback_data: 'settings_menu' },
            { text: '🛍️ Магазин', callback_data: 'shop' },
          ],
          [{ text: '🎭 Зависимости', callback_data: 'dependencies' }],
          [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
        ],
      };
      await ctx.replyWithMarkdown(
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
    this.bot.action('progress_streaks', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.replyWithMarkdown(
        `
🎯 *Прогресс и стрики*

📊 **Ваша статистика:**
⭐ Опыт: ${user.totalXp} XP
🔥 Текущий стрик: ${user.currentStreak} дней
📅 Аккаунт создан: ${user.createdAt.toLocaleDateString('ru-RU')}

**Стрики по категориям:**
📝 Задачи: ${user.currentStreak} дней
🔄 Привычки: В разработке
😊 Настроение: В разработке

Продолжайте выполнять задачи для увеличения стрика! 🚀
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

    this.bot.action('leaderboards', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.replyWithMarkdown(
        `
🏆 *Лидерборды*

**Топ пользователей по XP:**
🥇 1. Пользователь1 - 5000 XP
🥈 2. Пользователь2 - 4500 XP  
🥉 3. Пользователь3 - 4000 XP
...

*Функция в разработке - скоро будут реальные данные!*

Выполняйте задачи и поднимайтесь в рейтинге! 📈
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

    this.bot.action('achievements', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.replyWithMarkdown(
        `
🥇 *Ваши достижения*

**Разблокированные:**
🏆 Первые шаги - Создать первую задачу
⭐ Новичок - Получить 100 XP
📅 Постоянство - Стрик 3 дня

**В процессе:**
🔥 Мастер стрика - Стрик 7 дней (${user.currentStreak}/7)
💪 Продуктивный - Выполнить 50 задач
🚀 Энтузиаст - Получить 1000 XP (${user.totalXp}/1000)

**Заблокированные:**
🎯 Профессионал - Стрик 30 дней
⚡ Молния - Выполнить 10 задач за день
🌟 Легенда - Получить 10000 XP

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
      await ctx.replyWithMarkdown(
        `
🚀 *Челленджи*

**Активные испытания:**
⏰ 7-дневный марафон продуктивности
📝 Выполнить 21 задачу за неделю
🎯 Улучшить стрик до 10 дней

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
      await ctx.replyWithMarkdown(
        `
💰 *Бонусы и рефералы*

**Реферальная программа:**
🔗 Ваш код приглашения: \`REF${ctx.userId.slice(-6)}\`
👥 Приглашено друзей: 0
🎁 Бонус за друга: +500 XP

**Ежедневные бонусы:**
📅 Вход в систему: +50 XP
🎯 Первая задача дня: +100 XP
🔥 Поддержание стрика: +25 XP

**Еженедельные награды:**
🏆 7 дней активности: +300 XP
⭐ 21 задача в неделю: +500 XP

**Как пригласить друга:**
1. Поделитесь кодом приглашения
2. Друг вводит код при регистрации  
3. Вы оба получаете +500 XP!

*Функция в разработке - скоро полный запуск!*
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

    this.bot.action('user_profile', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.replyWithMarkdown(
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
🔥 Текущий стрик: ${user.currentStreak} дней
📊 Максимальный стрик: ${user.currentStreak} дней

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
            ],
          },
        },
      );
    });

    this.bot.action('settings_menu', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.replyWithMarkdown(
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
      await ctx.replyWithMarkdown(
        `
🛍️ *Магазин премиум функций*

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

*Магазин в разработке - скоро откроется!*
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

      await ctx.replyWithMarkdown(
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

      await ctx.replyWithMarkdown(
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

*Система оплаты в разработке - скоро будет доступна!*
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 Мои лимиты', callback_data: 'show_limits' }],
              [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('dependencies', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.replyWithMarkdown(
        `
🎭 *Блок зависимостей*

**Отслеживание вредных привычек:**
🚭 Курение - контроль и статистика
🍺 Алкоголь - трекинг потребления
📱 Соцсети - время в приложениях
🎮 Игры - мониторинг игрового времени
🛒 Покупки - контроль трат
🍰 Сладкое - учет калорий

**Полезные инструменты:**
📊 График прогресса по дням
⏰ Триггер-анализ (когда и почему)
💪 Техники борьбы с тягой
🎯 Постановка целей по сокращению
📝 Дневник наблюдений

**Поддержка:**
👥 Сообщество поддержки
📞 Горячая линия помощи
🧠 ИИ-советы для борьбы с зависимостями
📚 Образовательные материалы

⚠️ *Внимание:* Данный блок не заменяет профессиональную медицинскую помощь.

*Функция в разработке - скоро доступна!*
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📊 Начать трекинг',
                  callback_data: 'start_dependency_tracking',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    });

    this.bot.action('start_dependency_tracking', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.replyWithMarkdown(
        `
📊 *Начать трекинг зависимости*

Выберите тип зависимости для отслеживания:
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🚭 Курение', callback_data: 'track_smoking' },
                { text: '🍺 Алкоголь', callback_data: 'track_alcohol' },
              ],
              [
                { text: '📱 Соцсети', callback_data: 'track_social' },
                { text: '🎮 Игры', callback_data: 'track_gaming' },
              ],
              [
                { text: '🛒 Покупки', callback_data: 'track_shopping' },
                { text: '🍰 Сладкое', callback_data: 'track_sweets' },
              ],
              [{ text: '⬅️ Назад', callback_data: 'dependencies' }],
            ],
          },
        },
      );
    });

    // Dependency tracking handlers (placeholder for now)
    ['smoking', 'alcohol', 'social', 'gaming', 'shopping', 'sweets'].forEach(
      (type) => {
        this.bot.action(`track_${type}`, async (ctx) => {
          await ctx.answerCbQuery();
          await ctx.replyWithMarkdown(
            `
🚧 *Функция в разработке*

Трекинг ${
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
                        : 'сладкого'
            } будет доступен в следующем обновлении!

📧 Оставьте свой email в настройках, чтобы получить уведомление о запуске.
        `,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '⬅️ Назад',
                      callback_data: 'start_dependency_tracking',
                    },
                  ],
                ],
              },
            },
          );
        });
      },
    );

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

    // AI Chat handlers
    this.bot.action('ai_analyze_profile', async (ctx) => {
      await this.handleAIAnalyzeProfile(ctx);
    });

    this.bot.action('ai_task_recommendations', async (ctx) => {
      await this.handleAITaskRecommendations(ctx);
    });

    this.bot.action('ai_habit_help', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.replyWithMarkdown(
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
      await ctx.replyWithMarkdown(
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

    this.bot.action('exit_ai_chat', async (ctx) => {
      await ctx.answerCbQuery();
      ctx.session.aiChatMode = false;
      await ctx.replyWithMarkdown(`
✅ *Чат с ИИ завершён*

Спасибо за общение! Вы всегда можете вернуться к ИИ-консультанту через главное меню.
      `);
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

  private async startAIChat(ctx: BotContext) {
    await ctx.replyWithMarkdown(
      `
🧠 *ИИ Консультант активирован!*

Привет! Я ваш персональный ИИ-помощник по продуктивности. 

Я проанализировал ваш профиль и готов дать персональные рекомендации по:
📝 Управлению задачами
🔄 Формированию привычек  
⏰ Планированию времени
🎯 Достижению целей
📊 Повышению продуктивности

*Задайте мне любой вопрос или выберите тему:*
    `,
      {
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
      },
    );

    // Set AI chat mode
    ctx.session.aiChatMode = true;
  }

  private async handleAIAnalyzeProfile(ctx: BotContext) {
    await ctx.answerCbQuery();

    const user = await this.userService.findByTelegramId(ctx.userId);
    const tasks = await this.taskService.findTasksByUserId(ctx.userId);

    // Create profile analysis prompt
    const profileData = {
      totalXp: user.totalXp,
      currentStreak: user.currentStreak,
      accountAge: Math.floor(
        (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24),
      ),
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

      await ctx.replyWithMarkdown(
        `
🧠 *Анализ вашего профиля:*

${analysis}

💡 *Хотите обсудить что-то конкретное?* Просто напишите мне!
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
      await ctx.replyWithMarkdown(`
❌ *Ошибка при анализе профиля*

Извините, сейчас ИИ-анализ временно недоступен. Попробуйте позже.
      `);
    }
  }

  private async handleAITaskRecommendations(ctx: BotContext) {
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
      const recommendations =
        await this.openaiService.getAIResponse(taskPrompt);

      await ctx.replyWithMarkdown(
        `
💡 *Рекомендации по вашим задачам:*

${recommendations}

*Есть вопросы?* Напишите мне!
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      await ctx.replyWithMarkdown(`
❌ *Ошибка получения рекомендаций*

ИИ-консультант временно недоступен. Попробуйте позже.
      `);
    }
  }

  private async handleAICustomQuestion(ctx: BotContext) {
    await ctx.answerCbQuery();

    await ctx.replyWithMarkdown(
      `
✍️ *Режим свободного общения*

Напишите мне любой вопрос о продуктивности, управлении временем, мотивации или планировании. 

Я учту ваш профиль и дам персональный совет!

*Пример вопросов:*
• "Как мне лучше планировать утро?"
• "Почему я прокрастинирую?"
• "Как выработать привычку рано вставать?"
    `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
          ],
        },
      },
    );

    ctx.session.aiChatMode = true;
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

      const user = await this.userService.findByTelegramId(ctx.userId);
      const tasks = await this.taskService.findTasksByUserId(ctx.userId);
      const activeTasks = tasks.filter((task) => task.completedAt === null);

      // Create context for AI
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

      // Increment AI usage counter
      await this.billingService.incrementUsage(ctx.userId, 'dailyAiQueries');

      // Get current usage for display
      const usageInfo = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyAiQueries',
      );

      await ctx.replyWithMarkdown(
        `
🧠 *ИИ-консультант отвечает:*

${response}

📊 **ИИ-запросов сегодня:** ${usageInfo.current}/${usageInfo.limit === -1 ? '∞' : usageInfo.limit}

💡 *Есть ещё вопросы?* Просто напишите мне!
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              [{ text: '❌ Выйти из чата', callback_data: 'exit_ai_chat' }],
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
        await ctx.replyWithMarkdown(`
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

      const timeStr = reminderDate.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      });

      await ctx.replyWithMarkdown(
        `
✅ *Напоминание установлено!*

📝 **Текст:** ${reminderText}
⏰ **Время:** через ${minutesFromNow} минут (в ${timeStr})

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
      this.logger.error('Error creating relative reminder:', error);
      await ctx.replyWithMarkdown(`
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

      // Calculate delay in milliseconds
      const delay = reminderDate.getTime() - now.getTime();

      // Schedule the reminder
      setTimeout(async () => {
        try {
          await ctx.telegram.sendMessage(
            ctx.userId,
            `🔔 *Напоминание!*\n\n${reminderText}`,
            { parse_mode: 'Markdown' },
          );
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
        await ctx.replyWithMarkdown(`
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
        await ctx.replyWithMarkdown(`
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

      await ctx.replyWithMarkdown(`
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
        await ctx.replyWithMarkdown(`
🤖 *DailyCheck Bot - Ваш персональный помощник продуктивности*

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

      // Default: treat as AI chat
      await this.handleAIChatMessage(ctx, transcribedText);
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
      let reminderText = text
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
      // Полные формы с временем
      /напомни.*в\s*(\d{1,2}):(\d{2})/i,
      /напомни.*в\s*(\d{1,2})\s*час/i,
      /напомни.*через\s*(\d+)\s*(минут|час)/i,
      /напомню.*в\s*(\d{1,2}):(\d{2})/i,
      /напомню.*в\s*(\d{1,2})\s*час/i,
      /напомню.*через\s*(\d+)\s*(минут|час)/i,
      /напоминание.*в\s*(\d{1,2}):(\d{2})/i,
      /добавь.*напоминание/i,
      /создай.*напоминание/i,

      // Сокращенные формы (любые слова напомни/напомню)
      /напомни.+/i,
      /напомню.+/i,
      /напоминание.+/i,
      /remind.*/i,

      // Альтернативные формы
      /поставь.*напоминание/i,
      /установи.*напоминание/i,
      /нужно.*напомнить/i,
      /не забыть.*/i,
      /помни.*/i,
    ];

    return reminderPatterns.some((pattern) => pattern.test(text));
  }
}
