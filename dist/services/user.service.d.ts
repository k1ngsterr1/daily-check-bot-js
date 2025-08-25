import { PrismaService } from '../database/prisma.service';
import { User } from '@prisma/client';
import { CreateUserDto } from '../dto';
export declare class UserService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    findByTelegramId(telegramId: string): Promise<User>;
    findOrCreateUser(userData: CreateUserDto): Promise<User>;
    updateUser(telegramId: string, updates: Partial<User>): Promise<User>;
    updateStats(telegramId: string, stats: {
        todayTasks?: number;
        todayHabits?: number;
        xpGained?: number;
    }): Promise<{
        user: User;
        leveledUp?: boolean;
        newLevel?: number;
    }>;
    updateStreak(telegramId: string, streakValue: number): Promise<User>;
    completeOnboarding(telegramId: string): Promise<User>;
    getUsersByReferralCode(referralCode: string): Promise<User[]>;
    getUserStats(telegramId: string): Promise<{
        user: User;
        completionRate: number;
        habitCompletionRate: number;
        averageMood: number;
        focusTimeToday: number;
    }>;
    private generateReferralCode;
    private calculateLevel;
    getDisplayName(user: User): string;
    getCurrentLevelXp(user: User): number;
    getNextLevelXp(user: User): number;
    getProgressXp(user: User): number;
    getXpToNextLevel(user: User): number;
    getLevelProgressRatio(user: User): number;
}
