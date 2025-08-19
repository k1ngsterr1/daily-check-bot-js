import { TaskStatus, TaskPriority } from '@prisma/client';
export declare class CreateTaskDto {
    userId: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    dueDate?: Date;
    category?: string;
    tags?: string[];
    estimatedDuration?: number;
    xpReward?: number;
    isRecurring?: boolean;
    recurrencePattern?: string;
}
export declare class UpdateTaskDto {
    title?: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    dueDate?: Date;
    category?: string;
    tags?: string[];
    estimatedDuration?: number;
    actualDuration?: number;
}
