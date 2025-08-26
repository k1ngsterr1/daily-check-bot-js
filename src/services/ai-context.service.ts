import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { OpenAIService } from './openai.service';

export interface UserContext {
  userId: string;
  name?: string;
  timezone?: string;
  preferences?: any;
  goals?: string[];
  habits?: Array<{
    name: string;
    category: string;
    streak: number;
    lastCompleted?: Date;
  }>;
  tasks?: Array<{
    title: string;
    priority: string;
    category: string;
    completed: boolean;
    dueDate?: Date;
  }>;
  moodHistory?: Array<{
    mood: string;
    date: Date;
    notes?: string;
  }>;
  focusSessions?: Array<{
    duration: number;
    date: Date;
    productivity: number;
  }>;
  dependencies?: string[];
  achievements?: string[];
  totalXp?: number;
  currentStreak?: number;
  subscriptionType?: string;
}

@Injectable()
export class AiContextService {
  constructor(
    private prisma: PrismaService,
    private openaiService: OpenAIService,
  ) {}

  async getUserContext(userId: string): Promise<UserContext> {
    try {
      // Получаем базовую информацию о пользователе
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          tasks: {
            take: 10,
            orderBy: { createdAt: 'desc' },
          },
          habits: {
            take: 10,
            orderBy: { createdAt: 'desc' },
          },
          moods: {
            take: 7,
            orderBy: { createdAt: 'desc' },
          },
          focusSessions: {
            take: 10,
            orderBy: { createdAt: 'desc' },
          },
          userAchievements: {
            include: {
              achievement: true,
            },
          },
        },
      });

      if (!user) {
        return { userId };
      }

      // Формируем контекст
      const context: UserContext = {
        userId,
        name: user.firstName || user.username || 'Пользователь',
        timezone: user.timezone || undefined,
        totalXp: user.totalXp || 0,
        currentStreak: user.currentStreak || 0,
        subscriptionType: user.subscriptionType || 'FREE',
        tasks:
          user.tasks?.map((task) => ({
            title: task.title,
            priority: task.priority.toString(),
            category: task.category || 'general',
            completed: task.status === 'COMPLETED',
            dueDate: task.dueDate || undefined,
          })) || [],
        moodHistory:
          user.moods?.map((mood) => ({
            mood: mood.mood.toString(),
            date: mood.createdAt,
            notes: mood.note || undefined,
          })) || [],
      };

      return context;
    } catch (error) {
      console.error('Error getting user context:', error);
      return { userId };
    }
  }

  async generatePersonalizedMessage(
    userId: string,
    messageType:
      | 'motivation'
      | 'task_suggestion'
      | 'habit_advice'
      | 'mood_analysis'
      | 'focus_tips'
      | 'dependency_help',
    customPrompt?: string,
  ): Promise<string> {
    const context = await this.getUserContext(userId);

    const systemPrompts = {
      motivation: this.getMotivationPrompt(context),
      task_suggestion: this.getTaskSuggestionPrompt(context),
      habit_advice: this.getHabitAdvicePrompt(context),
      mood_analysis: this.getMoodAnalysisPrompt(context),
      focus_tips: this.getFocusTipsPrompt(context),
      dependency_help: this.getDependencyHelpPrompt(context),
    };

    const systemPrompt = systemPrompts[messageType] || systemPrompts.motivation;
    const userPrompt = customPrompt || this.getDefaultUserPrompt(messageType);

    try {
      const fullPrompt = `${systemPrompt}\n\nПользователь: ${userPrompt}`;
      const response = await this.openaiService.getAIResponse(fullPrompt);

      return response;
    } catch (error) {
      console.error('Error generating AI response:', error);
      return this.getFallbackMessage(messageType, context);
    }
  }

  private getMotivationPrompt(context: UserContext): string {
    return `Ты персональный ИИ-помощник по продуктивности. 
    
Информация о пользователе:
- Имя: ${context.name}
- Опыт: ${context.totalXp} XP
- Текущий стрик: ${context.currentStreak} дней
- Подписка: ${context.subscriptionType}
- Активных задач: ${context.tasks?.filter((t) => !t.completed).length || 0}
- Завершенных задач: ${context.tasks?.filter((t) => t.completed).length || 0}
- Последнее настроение: ${context.moodHistory?.[0]?.mood || 'не указано'}

Твоя роль - мотивировать, поддерживать и давать персонализированные советы. 
Отвечай дружелюбно, с эмодзи, кратко (до 200 слов).
Учитывай прогресс пользователя и подбадривай его.`;
  }

  private getTaskSuggestionPrompt(context: UserContext): string {
    return `Ты ИИ-помощник по управлению задачами.
    
Контекст пользователя:
- Активные задачи: ${JSON.stringify(context.tasks?.filter((t) => !t.completed) || [])}
- Завершенные задачи: ${JSON.stringify(context.tasks?.filter((t) => t.completed) || [])}
- Настроение: ${context.moodHistory?.[0]?.mood || 'не указано'}
- Стрик: ${context.currentStreak} дней

Анализируй загруженность, приоритеты и предлагай:
1. Оптимизацию задач
2. Планирование времени
3. Разбивку сложных задач
4. Мотивационные советы

Отвечай конкретно и действенно, с эмодзи.`;
  }

  private getHabitAdvicePrompt(context: UserContext): string {
    const habits = context.habits || [];
    const activeHabits = habits.filter((h) => h.streak > 0);
    const avgStreak =
      habits.length > 0
        ? Math.round(
            habits.reduce((acc, h) => acc + h.streak, 0) / habits.length,
          )
        : 0;
    const habitNames = habits.map((h) => h.name).join(', ') || 'нет привычек';
    return `Ты ИИ-коуч по формированию привычек.

Профиль пользователя:
- Всего привычек: ${habits.length}
- Активных привычек: ${activeHabits.length}
- Средний стрик: ${avgStreak} дней
- Перечень привычек: ${habitNames}
- Настроение: ${context.moodHistory?.[0]?.mood || 'не указано'}
- Опыт: ${context.totalXp} XP

Проанализируй привычки пользователя, их прогресс и дай персональные рекомендации по формированию и поддержанию привычек, преодолению сложностей, мотивации и дисциплине. Учитывай текущие привычки, настроение и прогресс. Будь поддерживающим тренером, используй научный подход и эмодзи.`;
  }

  private getMoodAnalysisPrompt(context: UserContext): string {
    const recentMoods = context.moodHistory?.slice(0, 5) || [];
    return `Ты ИИ-психолог и аналитик настроения.
    
Последние настроения пользователя: ${JSON.stringify(recentMoods)}
Задачи: ${context.tasks?.length || 0} (завершено: ${context.tasks?.filter((t) => t.completed).length || 0})
Стрик: ${context.currentStreak} дней

Анализируй:
- Паттерны настроения
- Связь с продуктивностью
- Рекомендации для улучшения
- Техники управления эмоциями

Будь эмпатичным, профессиональным, с практическими советами.`;
  }

  private getFocusTipsPrompt(context: UserContext): string {
    return `Ты ИИ-эксперт по концентрации и фокусу.
    
Пользователь:
- Активных задач: ${context.tasks?.filter((t) => !t.completed).length || 0}
- Настроение: ${context.moodHistory?.[0]?.mood || 'не указано'}
- Подписка: ${context.subscriptionType}

Предлагай:
- Техники концентрации
- Планирование фокус-сессий
- Борьбу с отвлечениями
- Персональные стратегии

Используй методы Помодоро, Deep Work, и другие научно обоснованные подходы.`;
  }

  private getDependencyHelpPrompt(context: UserContext): string {
    return `Ты ИИ-консультант по избавлению от зависимостей.
    
Контекст:
- Настроение: ${context.moodHistory?.[0]?.mood || 'не указано'}
- Стрик достижений: ${context.currentStreak} дней
- Продуктивность: ${context.tasks?.filter((t) => t.completed).length || 0} завершенных задач

Помогай с:
- Анализом триггеров
- Стратегиями замещения
- Мотивацией к изменениям
- Отслеживанием прогресса

Будь поддерживающим, не осуждающим, с практическими советами.`;
  }

  private getDefaultUserPrompt(messageType: string): string {
    const prompts = {
      motivation: 'Мотивируй меня продолжать развиваться!',
      task_suggestion: 'Помоги оптимизировать мои задачи.',
      habit_advice: 'Дай совет по формированию привычек.',
      mood_analysis: 'Проанализируй мое настроение.',
      focus_tips: 'Как лучше сфокусироваться на задачах?',
      dependency_help: 'Помоги справиться с вредными привычками.',
    };
    return prompts[messageType] || prompts.motivation;
  }

  private getFallbackMessage(
    messageType: string,
    context: UserContext,
  ): string {
    const messages = {
      motivation: `🚀 ${context.name}, ты на правильном пути! У тебя ${context.totalXp} XP и стрик ${context.currentStreak} дней. Продолжай двигаться к своим целям!`,
      task_suggestion:
        '📝 Сосредоточься на важных задачах, разбивай большие на маленькие части, и не забывай отмечать прогресс!',
      habit_advice:
        '🔄 Начинай с малого, будь последователен, отмечай успехи. Каждый день - это новая возможность!',
      mood_analysis:
        '😊 Твое настроение влияет на продуктивность. Попробуй техники релаксации и не забывай про отдых.',
      focus_tips:
        '🍅 Используй технику Помодоро: 25 минут фокуса, 5 минут отдых. Убери отвлекающие факторы!',
      dependency_help:
        '💪 Каждый день без вредной привычки - это победа. Замени негативное поведение позитивным!',
    };
    return messages[messageType] || messages.motivation;
  }

  async analyzeProductivity(userId: string): Promise<string> {
    const context = await this.getUserContext(userId);

    const completedTasks =
      context.tasks?.filter((t) => t.completed).length || 0;
    const totalTasks = context.tasks?.length || 0;
    const completionRate =
      totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    const recentMood = context.moodHistory?.[0]?.mood || 'неизвестно';

    return this.generatePersonalizedMessage(
      userId,
      'task_suggestion',
      `Проанализируй мою продуктивность: выполнено ${completedTasks} из ${totalTasks} задач (${completionRate}%), текущее настроение: ${recentMood}, стрик: ${context.currentStreak} дней. Дай персонализированные советы по улучшению.`,
    );
  }

  async generateDailyMotivation(userId: string): Promise<string> {
    return this.generatePersonalizedMessage(
      userId,
      'motivation',
      'Мотивируй меня на новый продуктивный день!',
    );
  }

  async analyzeMoodPattern(userId: string): Promise<string> {
    return this.generatePersonalizedMessage(
      userId,
      'mood_analysis',
      'Проанализируй мои паттерны настроения и дай советы по улучшению эмоционального состояния.',
    );
  }
}
