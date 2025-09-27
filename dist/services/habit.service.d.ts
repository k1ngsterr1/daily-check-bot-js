import { PrismaService } from '../database/prisma.service';
import { Habit } from '@prisma/client';
import { CreateHabitDto, UpdateHabitDto } from '../dto';
export declare class HabitService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    createHabit(createHabitDto: CreateHabitDto): Promise<Habit>;
    findHabitsByUserId(userId: string, isActive?: boolean): Promise<Habit[]>;
    findHabitById(habitId: string, userId: string): Promise<Habit>;
    updateHabit(habitId: string, userId: string, updateHabitDto: UpdateHabitDto): Promise<Habit>;
    deleteHabit(habitId: string, userId: string): Promise<void>;
    completeHabit(habitId: string, userId: string): Promise<{
        habit: Habit;
        xpGained: number;
    }>;
    isCompletedToday(habit: Habit): boolean;
    getHabitStats(userId: string): Promise<{
        total: number;
        active: number;
        inactive: number;
        totalCompletions: number;
        averageStreak: number;
    }>;
}
