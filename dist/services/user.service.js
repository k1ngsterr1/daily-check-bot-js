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
var UserService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../database/prisma.service");
let UserService = UserService_1 = class UserService {
    prisma;
    logger = new common_1.Logger(UserService_1.name);
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findByTelegramId(telegramId) {
        const user = await this.prisma.user.findUnique({
            where: { id: telegramId },
        });
        if (!user) {
            throw new Error(`User with Telegram ID ${telegramId} not found`);
        }
        return user;
    }
    async findOrCreateUser(userData) {
        try {
            let user = await this.prisma.user.findUnique({
                where: { id: userData.id },
            });
            if (user) {
                const updateData = {};
                let hasUpdates = false;
                if (userData.username !== user.username) {
                    updateData.username = userData.username;
                    hasUpdates = true;
                }
                if (userData.firstName !== user.firstName) {
                    updateData.firstName = userData.firstName;
                    hasUpdates = true;
                }
                if (userData.lastName !== user.lastName) {
                    updateData.lastName = userData.lastName;
                    hasUpdates = true;
                }
                if (hasUpdates) {
                    updateData.lastActivity = new Date();
                    user = await this.prisma.user.update({
                        where: { id: userData.id },
                        data: updateData,
                    });
                    this.logger.debug(`Updated user info for ${userData.id}`);
                }
                return user;
            }
            user = await this.prisma.user.create({
                data: {
                    id: userData.id,
                    username: userData.username,
                    firstName: userData.firstName,
                    lastName: userData.lastName,
                    onboardingPassed: false,
                    lastActivity: new Date(),
                    referralCode: this.generateReferralCode(),
                },
            });
            this.logger.log(`Created new user: ${userData.id}`);
            return user;
        }
        catch (error) {
            this.logger.error(`Error in findOrCreateUser for ${userData.id}:`, error);
            throw error;
        }
    }
    async updateUser(telegramId, updates) {
        const updateData = {
            ...updates,
            lastActivity: new Date(),
        };
        return await this.prisma.user.update({
            where: { id: telegramId },
            data: updateData,
        });
    }
    async updateUserStats(telegramId, stats) {
        const user = await this.findByTelegramId(telegramId);
        const updateData = {
            lastActivity: new Date(),
        };
        if (stats.totalTasks !== undefined) {
            updateData.totalTasks = stats.totalTasks;
        }
        if (stats.completedTasks !== undefined) {
            updateData.completedTasks = stats.completedTasks;
        }
        if (stats.totalHabits !== undefined) {
            updateData.totalHabits = stats.totalHabits;
        }
        if (stats.completedHabits !== undefined) {
            updateData.completedHabits = stats.completedHabits;
        }
        if (stats.todayTasks !== undefined) {
            updateData.todayTasks = stats.todayTasks;
        }
        if (stats.todayHabits !== undefined) {
            updateData.todayHabits = stats.todayHabits;
        }
        if (stats.xpGained !== undefined) {
            const newTotalXp = user.totalXp + stats.xpGained;
            updateData.totalXp = newTotalXp;
            const newLevel = this.calculateLevel(newTotalXp);
            if (newLevel > user.level) {
                updateData.level = newLevel;
                this.logger.log(`User ${telegramId} leveled up to ${newLevel}!`);
            }
        }
        return await this.prisma.user.update({
            where: { id: telegramId },
            data: updateData,
        });
    }
    async updateStreak(telegramId, streakValue) {
        const user = await this.findByTelegramId(telegramId);
        const updateData = {
            currentStreak: streakValue,
        };
        if (streakValue > user.maxStreak) {
            updateData.maxStreak = streakValue;
        }
        return await this.prisma.user.update({
            where: { id: telegramId },
            data: updateData,
        });
    }
    async completeOnboarding(telegramId) {
        return await this.prisma.user.update({
            where: { id: telegramId },
            data: { onboardingPassed: true },
        });
    }
    async getUsersByReferralCode(referralCode) {
        return await this.prisma.user.findMany({
            where: { referralCode },
        });
    }
    async getUserStats(telegramId) {
        const user = await this.findByTelegramId(telegramId);
        const completionRate = user.totalTasks > 0 ? (user.completedTasks / user.totalTasks) * 100 : 0;
        const habitCompletionRate = user.totalHabits > 0
            ? (user.completedHabits / user.totalHabits) * 100
            : 0;
        const averageMood = 0;
        const focusTimeToday = 0;
        return {
            user,
            completionRate: Math.round(completionRate),
            habitCompletionRate: Math.round(habitCompletionRate),
            averageMood,
            focusTimeToday,
        };
    }
    generateReferralCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 6; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
    calculateLevel(totalXp) {
        return Math.floor(Math.sqrt(totalXp / 100)) + 1;
    }
    getDisplayName(user) {
        if (user.firstName && user.lastName) {
            return `${user.firstName} ${user.lastName}`;
        }
        else if (user.firstName) {
            return user.firstName;
        }
        else if (user.username) {
            return `@${user.username}`;
        }
        else {
            return `User ${user.id}`;
        }
    }
    getCurrentLevelXp(user) {
        return (user.level - 1) * 100 + 50 * (user.level - 1) * (user.level - 1);
    }
    getNextLevelXp(user) {
        return user.level * 100 + 50 * user.level * user.level;
    }
    getProgressXp(user) {
        return Math.max(0, user.totalXp - this.getCurrentLevelXp(user));
    }
    getXpToNextLevel(user) {
        return Math.max(0, this.getNextLevelXp(user) - user.totalXp);
    }
    getLevelProgressRatio(user) {
        const xpNeeded = this.getNextLevelXp(user) - this.getCurrentLevelXp(user);
        if (xpNeeded <= 0) {
            return 1.0;
        }
        return Math.min(1.0, this.getProgressXp(user) / xpNeeded);
    }
};
exports.UserService = UserService;
exports.UserService = UserService = UserService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], UserService);
//# sourceMappingURL=user.service.js.map