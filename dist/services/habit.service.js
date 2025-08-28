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
var HabitService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.HabitService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../database/prisma.service");
let HabitService = HabitService_1 = class HabitService {
    prisma;
    logger = new common_1.Logger(HabitService_1.name);
    constructor(prisma) {
        this.prisma = prisma;
    }
    async createHabit(createHabitDto) {
        const habit = await this.prisma.habit.create({
            data: {
                ...createHabitDto,
                xpReward: createHabitDto.xpReward || 5,
            },
        });
        this.logger.log(`Created habit: ${habit.id} for user: ${habit.userId}`);
        return habit;
    }
    async findHabitsByUserId(userId, isActive = true) {
        return await this.prisma.habit.findMany({
            where: {
                userId,
                isActive,
            },
            orderBy: {
                createdAt: 'desc',
            },
        });
    }
    async findHabitById(habitId, userId) {
        const habit = await this.prisma.habit.findFirst({
            where: {
                id: habitId,
                userId,
            },
        });
        if (!habit) {
            throw new common_1.NotFoundException(`Habit with ID ${habitId} not found`);
        }
        return habit;
    }
    async updateHabit(habitId, userId, updateHabitDto) {
        await this.findHabitById(habitId, userId);
        const habit = await this.prisma.habit.update({
            where: { id: habitId },
            data: updateHabitDto,
        });
        this.logger.log(`Updated habit: ${habit.id}`);
        return habit;
    }
    async deleteHabit(habitId, userId) {
        await this.findHabitById(habitId, userId);
        await this.prisma.habit.delete({
            where: { id: habitId },
        });
        this.logger.log(`Deleted habit: ${habitId}`);
    }
    async completeHabit(habitId, userId) {
        const habit = await this.findHabitById(habitId, userId);
        const updatedHabit = await this.prisma.habit.update({
            where: { id: habitId },
            data: {
                totalCompletions: habit.totalCompletions + 1,
                currentStreak: habit.currentStreak + 1,
                maxStreak: Math.max(habit.maxStreak, habit.currentStreak + 1),
            },
        });
        this.logger.log(`Completed habit: ${habitId}, XP gained: ${habit.xpReward}`);
        return { habit: updatedHabit, xpGained: habit.xpReward };
    }
    async getHabitStats(userId) {
        const [total, active, habits] = await Promise.all([
            this.prisma.habit.count({ where: { userId } }),
            this.prisma.habit.count({ where: { userId, isActive: true } }),
            this.prisma.habit.findMany({
                where: { userId },
                select: { totalCompletions: true, currentStreak: true },
            }),
        ]);
        const totalCompletions = habits.reduce((sum, habit) => sum + habit.totalCompletions, 0);
        const averageStreak = habits.length > 0
            ? habits.reduce((sum, habit) => sum + habit.currentStreak, 0) /
                habits.length
            : 0;
        return {
            total,
            active,
            inactive: total - active,
            totalCompletions,
            averageStreak: Math.round(averageStreak),
        };
    }
};
exports.HabitService = HabitService;
exports.HabitService = HabitService = HabitService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], HabitService);
//# sourceMappingURL=habit.service.js.map