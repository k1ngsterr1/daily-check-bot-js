import { PrismaService } from '../database/prisma.service';
import { Task, TaskStatus } from '@prisma/client';
import { CreateTaskDto, UpdateTaskDto } from '../dto';
export declare class TaskService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    createTask(createTaskDto: CreateTaskDto): Promise<Task>;
    findTasksByUserId(userId: string, status?: TaskStatus): Promise<Task[]>;
    findTaskById(taskId: string, userId: string): Promise<Task>;
    updateTask(taskId: string, userId: string, updateTaskDto: UpdateTaskDto): Promise<Task>;
    deleteTask(taskId: string, userId: string): Promise<void>;
    completeTask(taskId: string, userId: string): Promise<{
        task: Task;
        xpGained: number;
    }>;
    getTodayTasks(userId: string): Promise<Task[]>;
    getOverdueTasks(userId: string): Promise<Task[]>;
    getTaskStats(userId: string): Promise<{
        total: number;
        completed: number;
        pending: number;
        inProgress: number;
        overdue: number;
        todayCompleted: number;
    }>;
    searchTasks(userId: string, query: string): Promise<Task[]>;
    private calculateXpReward;
}
