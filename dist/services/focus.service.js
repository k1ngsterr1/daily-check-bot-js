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
var FocusService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.FocusService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../database/prisma.service");
const client_1 = require("@prisma/client");
let FocusService = FocusService_1 = class FocusService {
    prisma;
    logger = new common_1.Logger(FocusService_1.name);
    constructor(prisma) {
        this.prisma = prisma;
    }
    async createFocusSession(createFocusSessionDto) {
        const focusSession = await this.prisma.focusSession.create({
            data: {
                ...createFocusSessionDto,
                startedAt: new Date(),
            },
        });
        this.logger.log(`Created focus session: ${focusSession.id} for user: ${focusSession.userId}`);
        return focusSession;
    }
    async findFocusSessionsByUserId(userId) {
        return await this.prisma.focusSession.findMany({
            where: { userId },
            orderBy: {
                createdAt: 'desc',
            },
        });
    }
    async findFocusSessionById(sessionId, userId) {
        const focusSession = await this.prisma.focusSession.findFirst({
            where: {
                id: sessionId,
                userId,
            },
        });
        if (!focusSession) {
            throw new common_1.NotFoundException(`Focus session with ID ${sessionId} not found`);
        }
        return focusSession;
    }
    async updateFocusSession(sessionId, userId, updateFocusSessionDto) {
        await this.findFocusSessionById(sessionId, userId);
        const focusSession = await this.prisma.focusSession.update({
            where: { id: sessionId },
            data: updateFocusSessionDto,
        });
        this.logger.log(`Updated focus session: ${focusSession.id}`);
        return focusSession;
    }
    async completeFocusSession(sessionId, userId, actualDuration, productivityRating = 5) {
        const session = await this.findFocusSessionById(sessionId, userId);
        if (session.status === client_1.FocusSessionStatus.COMPLETED) {
            throw new Error('Focus session is already completed');
        }
        const xpGained = Math.floor(actualDuration / 5);
        const updatedSession = await this.prisma.focusSession.update({
            where: { id: sessionId },
            data: {
                status: client_1.FocusSessionStatus.COMPLETED,
                actualDuration,
                endedAt: new Date(),
                productivityRating,
                xpReward: xpGained,
            },
        });
        this.logger.log(`Completed focus session: ${sessionId}, XP gained: ${xpGained}`);
        return { session: updatedSession, xpGained };
    }
    async pauseFocusSession(sessionId, userId) {
        const session = await this.findFocusSessionById(sessionId, userId);
        if (session.status !== client_1.FocusSessionStatus.ACTIVE) {
            throw new Error('Can only pause active focus sessions');
        }
        const updatedSession = await this.prisma.focusSession.update({
            where: { id: sessionId },
            data: {
                status: client_1.FocusSessionStatus.PAUSED,
            },
        });
        this.logger.log(`Paused focus session: ${sessionId}`);
        return updatedSession;
    }
    async resumeFocusSession(sessionId, userId) {
        const session = await this.findFocusSessionById(sessionId, userId);
        if (session.status !== client_1.FocusSessionStatus.PAUSED) {
            throw new Error('Can only resume paused focus sessions');
        }
        const updatedSession = await this.prisma.focusSession.update({
            where: { id: sessionId },
            data: {
                status: client_1.FocusSessionStatus.ACTIVE,
            },
        });
        this.logger.log(`Resumed focus session: ${sessionId}`);
        return updatedSession;
    }
    async getActiveFocusSession(userId) {
        return await this.prisma.focusSession.findFirst({
            where: {
                userId,
                status: {
                    in: [client_1.FocusSessionStatus.ACTIVE, client_1.FocusSessionStatus.PAUSED],
                },
            },
            orderBy: {
                startedAt: 'desc',
            },
        });
    }
    async getTodayFocusTime(userId) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        const completedSessions = await this.prisma.focusSession.findMany({
            where: {
                userId,
                status: client_1.FocusSessionStatus.COMPLETED,
                endedAt: {
                    gte: startOfDay,
                    lte: endOfDay,
                },
            },
            select: {
                actualDuration: true,
            },
        });
        return completedSessions.reduce((total, session) => total + session.actualDuration, 0);
    }
    async getFocusStats(userId, days = 30) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const [allSessions, completedSessions] = await Promise.all([
            this.prisma.focusSession.findMany({
                where: {
                    userId,
                    createdAt: {
                        gte: startDate,
                    },
                },
                select: {
                    status: true,
                    actualDuration: true,
                    productivityRating: true,
                },
            }),
            this.prisma.focusSession.findMany({
                where: {
                    userId,
                    status: client_1.FocusSessionStatus.COMPLETED,
                    createdAt: {
                        gte: startDate,
                    },
                },
                select: {
                    actualDuration: true,
                    productivityRating: true,
                },
            }),
        ]);
        const totalSessions = allSessions.length;
        const completedSessionsCount = completedSessions.length;
        const totalFocusTime = completedSessions.reduce((sum, session) => sum + session.actualDuration, 0);
        const averageSessionLength = completedSessionsCount > 0 ? totalFocusTime / completedSessionsCount : 0;
        const averageProductivityRating = completedSessionsCount > 0
            ? completedSessions.reduce((sum, session) => sum + session.productivityRating, 0) / completedSessionsCount
            : 0;
        const completionRate = totalSessions > 0 ? (completedSessionsCount / totalSessions) * 100 : 0;
        return {
            totalSessions,
            completedSessions: completedSessionsCount,
            totalFocusTime,
            averageSessionLength: Math.round(averageSessionLength),
            averageProductivityRating: Math.round(averageProductivityRating * 10) / 10,
            completionRate: Math.round(completionRate),
        };
    }
};
exports.FocusService = FocusService;
exports.FocusService = FocusService = FocusService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], FocusService);
//# sourceMappingURL=focus.service.js.map