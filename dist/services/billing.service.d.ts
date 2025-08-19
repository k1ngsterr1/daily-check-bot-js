import { PrismaService } from '../database/prisma.service';
import { SubscriptionType } from '@prisma/client';
export interface UsageLimits {
    dailyReminders: number;
    dailyTasks: number;
    dailyHabits: number;
    dailyAiQueries: number;
    maxFocusSessions: number;
    advancedAnalytics: boolean;
    prioritySupport: boolean;
    customThemes: boolean;
}
export declare class BillingService {
    private prisma;
    constructor(prisma: PrismaService);
    private readonly SUBSCRIPTION_LIMITS;
    getUserLimits(userId: string): Promise<UsageLimits>;
    checkUsageLimit(userId: string, limitType: keyof UsageLimits): Promise<{
        allowed: boolean;
        current: number;
        limit: number;
        message?: string;
    }>;
    incrementUsage(userId: string, limitType: keyof UsageLimits): Promise<void>;
    resetDailyUsageIfNeeded(userId: string): Promise<void>;
    private isSameDay;
    initializeTrialForUser(userId: string): Promise<void>;
    getTrialInfo(userId: string): Promise<{
        isTrialActive: boolean;
        daysRemaining: number;
        trialEnds?: Date;
    }>;
    getSubscriptionStatus(userId: string): Promise<{
        type: SubscriptionType;
        isActive: boolean;
        isTrialActive: boolean;
        daysRemaining: number;
        limits: UsageLimits;
        usage: {
            dailyReminders: number;
            dailyTasks: number;
            dailyHabits: number;
            dailyAiQueries: number;
        };
    }>;
}
