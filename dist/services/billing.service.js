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
exports.BillingService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../database/prisma.service");
let BillingService = class BillingService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    SUBSCRIPTION_LIMITS = {
        FREE: {
            dailyReminders: 5,
            dailyTasks: 10,
            dailyHabits: 3,
            dailyAiQueries: 10,
            maxFocusSessions: 3,
            advancedAnalytics: false,
            prioritySupport: false,
            customThemes: false,
        },
        PREMIUM: {
            dailyReminders: 50,
            dailyTasks: 100,
            dailyHabits: 20,
            dailyAiQueries: 100,
            maxFocusSessions: 20,
            advancedAnalytics: true,
            prioritySupport: false,
            customThemes: true,
        },
        PREMIUM_PLUS: {
            dailyReminders: -1,
            dailyTasks: -1,
            dailyHabits: -1,
            dailyAiQueries: -1,
            maxFocusSessions: -1,
            advancedAnalytics: true,
            prioritySupport: true,
            customThemes: true,
        },
    };
    async getUserLimits(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                subscriptionType: true,
                isTrialActive: true,
                trialEnds: true,
            },
        });
        if (!user) {
            return this.SUBSCRIPTION_LIMITS.FREE;
        }
        const now = new Date();
        const isTrialActive = user.isTrialActive && user.trialEnds && now < user.trialEnds;
        if (isTrialActive) {
            return this.SUBSCRIPTION_LIMITS.PREMIUM;
        }
        return this.SUBSCRIPTION_LIMITS[user.subscriptionType];
    }
    async checkUsageLimit(userId, limitType) {
        const limits = await this.getUserLimits(userId);
        const limit = limits[limitType];
        if (limit === -1) {
            return { allowed: true, current: 0, limit: -1 };
        }
        await this.resetDailyUsageIfNeeded(userId);
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                dailyRemindersUsed: true,
                dailyTasksUsed: true,
                dailyHabitsUsed: true,
                dailyAiQueriesUsed: true,
                subscriptionType: true,
                isTrialActive: true,
                trialEnds: true,
            },
        });
        if (!user) {
            return {
                allowed: false,
                current: 0,
                limit: 0,
                message: 'Пользователь не найден',
            };
        }
        let current = 0;
        let upgradeMessage = '';
        switch (limitType) {
            case 'dailyReminders':
                current = user.dailyRemindersUsed;
                upgradeMessage = 'напоминаний';
                break;
            case 'dailyTasks':
                current = user.dailyTasksUsed;
                upgradeMessage = 'задач';
                break;
            case 'dailyHabits':
                current = user.dailyHabitsUsed;
                upgradeMessage = 'привычек';
                break;
            case 'dailyAiQueries':
                current = user.dailyAiQueriesUsed;
                upgradeMessage = 'запросов к ИИ';
                break;
        }
        const allowed = current < limit;
        const message = allowed
            ? undefined
            : `🚫 Достигнут лимит ${upgradeMessage} (${limit}/день)\n\n` +
                `💎 Обновитесь до Premium для увеличения лимитов!`;
        return { allowed, current, limit, message };
    }
    async incrementUsage(userId, limitType) {
        await this.resetDailyUsageIfNeeded(userId);
        const updateData = {};
        switch (limitType) {
            case 'dailyReminders':
                updateData.dailyRemindersUsed = { increment: 1 };
                break;
            case 'dailyTasks':
                updateData.dailyTasksUsed = { increment: 1 };
                break;
            case 'dailyHabits':
                updateData.dailyHabitsUsed = { increment: 1 };
                break;
            case 'dailyAiQueries':
                updateData.dailyAiQueriesUsed = { increment: 1 };
                break;
        }
        if (Object.keys(updateData).length > 0) {
            await this.prisma.user.update({
                where: { id: userId },
                data: updateData,
            });
        }
    }
    async resetDailyUsageIfNeeded(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { lastUsageReset: true },
        });
        if (!user)
            return;
        const now = new Date();
        const lastReset = user.lastUsageReset;
        if (!lastReset || !this.isSameDay(now, lastReset)) {
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    dailyRemindersUsed: 0,
                    dailyTasksUsed: 0,
                    dailyHabitsUsed: 0,
                    dailyAiQueriesUsed: 0,
                    lastUsageReset: now,
                },
            });
        }
    }
    isSameDay(date1, date2) {
        return (date1.getFullYear() === date2.getFullYear() &&
            date1.getMonth() === date2.getMonth() &&
            date1.getDate() === date2.getDate());
    }
    async initializeTrialForUser(userId) {
        const now = new Date();
        const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        await this.prisma.user.update({
            where: { id: userId },
            data: {
                isTrialActive: true,
                trialEnds: trialEnd,
                lastUsageReset: now,
            },
        });
    }
    async getTrialInfo(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                isTrialActive: true,
                trialEnds: true,
            },
        });
        if (!user || !user.isTrialActive || !user.trialEnds) {
            return { isTrialActive: false, daysRemaining: 0 };
        }
        const now = new Date();
        const daysRemaining = Math.max(0, Math.ceil((user.trialEnds.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
        const isTrialActive = daysRemaining > 0;
        return {
            isTrialActive,
            daysRemaining,
            trialEnds: user.trialEnds,
        };
    }
    async getSubscriptionStatus(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                subscriptionType: true,
                isTrialActive: true,
                trialEnds: true,
                subscriptionEnds: true,
                dailyRemindersUsed: true,
                dailyTasksUsed: true,
                dailyHabitsUsed: true,
                dailyAiQueriesUsed: true,
            },
        });
        if (!user) {
            throw new Error('User not found');
        }
        const trialInfo = await this.getTrialInfo(userId);
        const limits = await this.getUserLimits(userId);
        const now = new Date();
        const isSubscriptionActive = user.subscriptionEnds
            ? now < user.subscriptionEnds
            : false;
        return {
            type: user.subscriptionType,
            isActive: isSubscriptionActive || trialInfo.isTrialActive,
            isTrialActive: trialInfo.isTrialActive,
            daysRemaining: trialInfo.daysRemaining,
            limits,
            usage: {
                dailyReminders: user.dailyRemindersUsed,
                dailyTasks: user.dailyTasksUsed,
                dailyHabits: user.dailyHabitsUsed,
                dailyAiQueries: user.dailyAiQueriesUsed,
            },
        };
    }
};
exports.BillingService = BillingService;
exports.BillingService = BillingService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], BillingService);
//# sourceMappingURL=billing.service.js.map