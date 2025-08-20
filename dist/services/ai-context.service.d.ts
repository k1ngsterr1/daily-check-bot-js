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
export declare class AiContextService {
    private prisma;
    private openaiService;
    constructor(prisma: PrismaService, openaiService: OpenAIService);
    getUserContext(userId: string): Promise<UserContext>;
    generatePersonalizedMessage(userId: string, messageType: 'motivation' | 'task_suggestion' | 'habit_advice' | 'mood_analysis' | 'focus_tips' | 'dependency_help', customPrompt?: string): Promise<string>;
    private getMotivationPrompt;
    private getTaskSuggestionPrompt;
    private getHabitAdvicePrompt;
    private getMoodAnalysisPrompt;
    private getFocusTipsPrompt;
    private getDependencyHelpPrompt;
    private getDefaultUserPrompt;
    private getFallbackMessage;
    analyzeProductivity(userId: string): Promise<string>;
    generateDailyMotivation(userId: string): Promise<string>;
    analyzeMoodPattern(userId: string): Promise<string>;
}
