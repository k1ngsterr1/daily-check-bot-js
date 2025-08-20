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
var TaskService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../database/prisma.service");
const client_1 = require("@prisma/client");
let TaskService = TaskService_1 = class TaskService {
    prisma;
    logger = new common_1.Logger(TaskService_1.name);
    constructor(prisma) {
        this.prisma = prisma;
    }
    async createTask(createTaskDto) {
        const task = await this.prisma.task.create({
            data: {
                ...createTaskDto,
                xpReward: createTaskDto.xpReward ||
                    this.calculateXpReward(createTaskDto.priority || client_1.TaskPriority.MEDIUM),
            },
        });
        this.logger.log(`Created task: ${task.id} for user: ${task.userId}`);
        return task;
    }
    async findTasksByUserId(userId, status) {
        return await this.prisma.task.findMany({
            where: {
                userId,
                ...(status && { status }),
            },
            orderBy: [
                { priority: 'desc' },
                { dueDate: 'asc' },
                { createdAt: 'desc' },
            ],
        });
    }
    async findTaskById(taskId, userId) {
        const task = await this.prisma.task.findFirst({
            where: {
                id: taskId,
                userId,
            },
        });
        if (!task) {
            throw new common_1.NotFoundException(`Task with ID ${taskId} not found`);
        }
        return task;
    }
    async updateTask(taskId, userId, updateTaskDto) {
        await this.findTaskById(taskId, userId);
        const task = await this.prisma.task.update({
            where: { id: taskId },
            data: {
                ...updateTaskDto,
                ...(updateTaskDto.status === client_1.TaskStatus.COMPLETED && {
                    completedAt: new Date(),
                }),
            },
        });
        this.logger.log(`Updated task: ${task.id}`);
        return task;
    }
    async deleteTask(taskId, userId) {
        await this.findTaskById(taskId, userId);
        await this.prisma.task.delete({
            where: { id: taskId },
        });
        this.logger.log(`Deleted task: ${taskId}`);
    }
    async completeTask(taskId, userId) {
        const task = await this.findTaskById(taskId, userId);
        if (task.status === client_1.TaskStatus.COMPLETED) {
            throw new Error('Task is already completed');
        }
        const updatedTask = await this.prisma.task.update({
            where: { id: taskId },
            data: {
                status: client_1.TaskStatus.COMPLETED,
                completedAt: new Date(),
            },
        });
        this.logger.log(`Completed task: ${taskId}, XP gained: ${task.xpReward}`);
        return { task: updatedTask, xpGained: task.xpReward };
    }
    async getTodayTasks(userId) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        return await this.prisma.task.findMany({
            where: {
                userId,
                OR: [
                    {
                        dueDate: {
                            gte: startOfDay,
                            lte: endOfDay,
                        },
                    },
                    {
                        dueDate: null,
                        createdAt: {
                            gte: startOfDay,
                        },
                    },
                ],
            },
            orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
        });
    }
    async getOverdueTasks(userId) {
        const now = new Date();
        return await this.prisma.task.findMany({
            where: {
                userId,
                status: {
                    not: client_1.TaskStatus.COMPLETED,
                },
                dueDate: {
                    lt: now,
                },
            },
            orderBy: { dueDate: 'asc' },
        });
    }
    async getTaskStats(userId) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        const now = new Date();
        const [total, completed, pending, inProgress, overdue, todayCompleted] = await Promise.all([
            this.prisma.task.count({ where: { userId } }),
            this.prisma.task.count({
                where: { userId, status: client_1.TaskStatus.COMPLETED },
            }),
            this.prisma.task.count({
                where: { userId, status: client_1.TaskStatus.PENDING },
            }),
            this.prisma.task.count({
                where: { userId, status: client_1.TaskStatus.IN_PROGRESS },
            }),
            this.prisma.task.count({
                where: {
                    userId,
                    status: { not: client_1.TaskStatus.COMPLETED },
                    dueDate: { lt: now },
                },
            }),
            this.prisma.task.count({
                where: {
                    userId,
                    status: client_1.TaskStatus.COMPLETED,
                    completedAt: { gte: startOfDay, lte: endOfDay },
                },
            }),
        ]);
        return {
            total,
            completed,
            pending,
            inProgress,
            overdue,
            todayCompleted,
        };
    }
    async searchTasks(userId, query) {
        return await this.prisma.task.findMany({
            where: {
                userId,
                OR: [
                    { title: { contains: query, mode: 'insensitive' } },
                    { description: { contains: query, mode: 'insensitive' } },
                    { category: { contains: query, mode: 'insensitive' } },
                ],
            },
            orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
        });
    }
    calculateXpReward(priority) {
        const xpMap = {
            [client_1.TaskPriority.LOW]: 5,
            [client_1.TaskPriority.MEDIUM]: 10,
            [client_1.TaskPriority.HIGH]: 15,
            [client_1.TaskPriority.URGENT]: 20,
        };
        return xpMap[priority] || 10;
    }
};
exports.TaskService = TaskService;
exports.TaskService = TaskService = TaskService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], TaskService);
//# sourceMappingURL=task.service.js.map