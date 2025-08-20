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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiContextService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../database/prisma.service");
const openai_service_1 = require("./openai.service");
let AiContextService = class AiContextService {
    prisma;
    openaiService;
    constructor(prisma, openaiService) {
        this.prisma = prisma;
        this.openaiService = openaiService;
    }
    async getUserContext(userId) {
        try {
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
            const context = {
                userId,
                name: user.firstName || user.username || 'Пользователь',
                timezone: user.timezone || undefined,
                totalXp: user.totalXp || 0,
                currentStreak: user.currentStreak || 0,
                subscriptionType: user.subscriptionType || 'FREE',
                tasks: user.tasks?.map((task) => ({
                    title: task.title,
                    priority: task.priority.toString(),
                    category: task.category || 'general',
                    completed: task.status === 'COMPLETED',
                    dueDate: task.dueDate || undefined,
                })) || [],
                moodHistory: user.moods?.map((mood) => ({
                    mood: mood.mood.toString(),
                    date: mood.createdAt,
                    notes: mood.note || undefined,
                })) || [],
            };
            return context;
        }
        catch (error) {
            console.error('Error getting user context:', error);
            return { userId };
        }
    }
    async generatePersonalizedMessage(userId, messageType, customPrompt) {
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
        }
        catch (error) {
            console.error('Error generating AI response:', error);
            return this.getFallbackMessage(messageType, context);
        }
    }
    getMotivationPrompt(context) {
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
    getTaskSuggestionPrompt(context) {
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
    getHabitAdvicePrompt(context) {
        return `Ты ИИ-коуч по формированию привычек.
    
Пользователь:
- Стрик: ${context.currentStreak} дней
- Опыт: ${context.totalXp} XP
- Настроение: ${context.moodHistory?.[0]?.mood || 'не указано'}

Давай советы по:
- Формированию новых привычек
- Поддержанию существующих
- Преодолению препятствий
- Мотивации и дисциплине

Будь поддерживающим тренером, используй научный подход и эмодзи.`;
    }
    getMoodAnalysisPrompt(context) {
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
    getFocusTipsPrompt(context) {
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
    getDependencyHelpPrompt(context) {
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
    getDefaultUserPrompt(messageType) {
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
    getFallbackMessage(messageType, context) {
        const messages = {
            motivation: `🚀 ${context.name}, ты на правильном пути! У тебя ${context.totalXp} XP и стрик ${context.currentStreak} дней. Продолжай двигаться к своим целям!`,
            task_suggestion: '📝 Сосредоточься на важных задачах, разбивай большие на маленькие части, и не забывай отмечать прогресс!',
            habit_advice: '🔄 Начинай с малого, будь последователен, отмечай успехи. Каждый день - это новая возможность!',
            mood_analysis: '😊 Твое настроение влияет на продуктивность. Попробуй техники релаксации и не забывай про отдых.',
            focus_tips: '🍅 Используй технику Помодоро: 25 минут фокуса, 5 минут отдых. Убери отвлекающие факторы!',
            dependency_help: '💪 Каждый день без вредной привычки - это победа. Замени негативное поведение позитивным!',
        };
        return messages[messageType] || messages.motivation;
    }
    async analyzeProductivity(userId) {
        const context = await this.getUserContext(userId);
        const completedTasks = context.tasks?.filter((t) => t.completed).length || 0;
        const totalTasks = context.tasks?.length || 0;
        const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
        const recentMood = context.moodHistory?.[0]?.mood || 'неизвестно';
        return this.generatePersonalizedMessage(userId, 'task_suggestion', `Проанализируй мою продуктивность: выполнено ${completedTasks} из ${totalTasks} задач (${completionRate}%), текущее настроение: ${recentMood}, стрик: ${context.currentStreak} дней. Дай персонализированные советы по улучшению.`);
    }
    async generateDailyMotivation(userId) {
        return this.generatePersonalizedMessage(userId, 'motivation', 'Мотивируй меня на новый продуктивный день!');
    }
    async analyzeMoodPattern(userId) {
        return this.generatePersonalizedMessage(userId, 'mood_analysis', 'Проанализируй мои паттерны настроения и дай советы по улучшению эмоционального состояния.');
    }
};
exports.AiContextService = AiContextService;
exports.AiContextService = AiContextService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        openai_service_1.OpenAIService])
], AiContextService);
//# sourceMappingURL=ai-context.service.js.map