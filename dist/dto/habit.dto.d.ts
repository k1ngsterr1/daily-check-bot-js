import { HabitFrequency } from '@prisma/client';
export declare class CreateHabitDto {
    userId: string;
    title: string;
    description?: string;
    frequency?: HabitFrequency;
    targetCount?: number;
    category?: string;
    tags?: string[];
    reminderTime?: string;
    reminderDays?: string[];
    icon?: string;
    color?: string;
    difficulty?: number;
    xpReward?: number;
}
export declare class UpdateHabitDto {
    title?: string;
    description?: string;
    frequency?: HabitFrequency;
    targetCount?: number;
    category?: string;
    tags?: string[];
    isActive?: boolean;
    reminderTime?: string;
    reminderDays?: string[];
    icon?: string;
    color?: string;
    difficulty?: number;
    xpReward?: number;
}
