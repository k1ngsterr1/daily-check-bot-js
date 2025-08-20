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
var MoodService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MoodService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../database/prisma.service");
const client_1 = require("@prisma/client");
let MoodService = MoodService_1 = class MoodService {
    prisma;
    logger = new common_1.Logger(MoodService_1.name);
    constructor(prisma) {
        this.prisma = prisma;
    }
    async createMoodEntry(createMoodEntryDto) {
        const moodEntry = await this.prisma.moodEntry.create({
            data: createMoodEntryDto,
        });
        this.logger.log(`Created mood entry: ${moodEntry.id} for user: ${moodEntry.userId}`);
        return moodEntry;
    }
    async findMoodEntriesByUserId(userId, startDate, endDate) {
        const where = { userId };
        if (startDate && endDate) {
            where.createdAt = {
                gte: startDate,
                lte: endDate,
            };
        }
        return await this.prisma.moodEntry.findMany({
            where,
            orderBy: {
                createdAt: 'desc',
            },
        });
    }
    async findMoodEntryById(entryId, userId) {
        const moodEntry = await this.prisma.moodEntry.findFirst({
            where: {
                id: entryId,
                userId,
            },
        });
        if (!moodEntry) {
            throw new common_1.NotFoundException(`Mood entry with ID ${entryId} not found`);
        }
        return moodEntry;
    }
    async updateMoodEntry(entryId, userId, updateMoodEntryDto) {
        await this.findMoodEntryById(entryId, userId);
        const moodEntry = await this.prisma.moodEntry.update({
            where: { id: entryId },
            data: updateMoodEntryDto,
        });
        this.logger.log(`Updated mood entry: ${moodEntry.id}`);
        return moodEntry;
    }
    async deleteMoodEntry(entryId, userId) {
        await this.findMoodEntryById(entryId, userId);
        await this.prisma.moodEntry.delete({
            where: { id: entryId },
        });
        this.logger.log(`Deleted mood entry: ${entryId}`);
    }
    async getTodayMoodEntry(userId) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        return await this.prisma.moodEntry.findFirst({
            where: {
                userId,
                createdAt: {
                    gte: startOfDay,
                    lte: endOfDay,
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
        });
    }
    async getMoodStats(userId, days = 30) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const moodEntries = await this.prisma.moodEntry.findMany({
            where: {
                userId,
                createdAt: {
                    gte: startDate,
                },
            },
            select: {
                mood: true,
                rating: true,
            },
        });
        if (moodEntries.length === 0) {
            return {
                averageRating: 0,
                mostCommonMood: client_1.MoodType.NEUTRAL,
                totalEntries: 0,
                moodDistribution: {
                    [client_1.MoodType.VERY_SAD]: 0,
                    [client_1.MoodType.SAD]: 0,
                    [client_1.MoodType.NEUTRAL]: 0,
                    [client_1.MoodType.HAPPY]: 0,
                    [client_1.MoodType.VERY_HAPPY]: 0,
                },
            };
        }
        const averageRating = moodEntries.reduce((sum, entry) => sum + entry.rating, 0) /
            moodEntries.length;
        const moodDistribution = moodEntries.reduce((acc, entry) => {
            acc[entry.mood] = (acc[entry.mood] || 0) + 1;
            return acc;
        }, {});
        const mostCommonMood = Object.keys(moodDistribution).reduce((a, b) => moodDistribution[a] > moodDistribution[b] ? a : b);
        return {
            averageRating: Math.round(averageRating * 10) / 10,
            mostCommonMood,
            totalEntries: moodEntries.length,
            moodDistribution: {
                [client_1.MoodType.VERY_SAD]: moodDistribution[client_1.MoodType.VERY_SAD] || 0,
                [client_1.MoodType.SAD]: moodDistribution[client_1.MoodType.SAD] || 0,
                [client_1.MoodType.NEUTRAL]: moodDistribution[client_1.MoodType.NEUTRAL] || 0,
                [client_1.MoodType.HAPPY]: moodDistribution[client_1.MoodType.HAPPY] || 0,
                [client_1.MoodType.VERY_HAPPY]: moodDistribution[client_1.MoodType.VERY_HAPPY] || 0,
            },
        };
    }
};
exports.MoodService = MoodService;
exports.MoodService = MoodService = MoodService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], MoodService);
//# sourceMappingURL=mood.service.js.map