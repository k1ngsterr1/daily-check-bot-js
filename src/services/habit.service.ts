import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Habit, HabitFrequency } from '@prisma/client';
import { CreateHabitDto, UpdateHabitDto } from '../dto';

@Injectable()
export class HabitService {
  private readonly logger = new Logger(HabitService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createHabit(createHabitDto: CreateHabitDto): Promise<Habit> {
    const habit = await this.prisma.habit.create({
      data: {
        ...createHabitDto,
        xpReward: createHabitDto.xpReward || 5,
      },
    });

    this.logger.log(`Created habit: ${habit.id} for user: ${habit.userId}`);
    return habit;
  }

  async findHabitsByUserId(userId: string, isActive = true): Promise<Habit[]> {
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

  async findHabitById(habitId: string, userId: string): Promise<Habit> {
    const habit = await this.prisma.habit.findFirst({
      where: {
        id: habitId,
        userId,
      },
    });

    if (!habit) {
      throw new NotFoundException(`Habit with ID ${habitId} not found`);
    }

    return habit;
  }

  async updateHabit(
    habitId: string,
    userId: string,
    updateHabitDto: UpdateHabitDto,
  ): Promise<Habit> {
    await this.findHabitById(habitId, userId); // Ensure habit exists and belongs to user

    const habit = await this.prisma.habit.update({
      where: { id: habitId },
      data: updateHabitDto,
    });

    this.logger.log(`Updated habit: ${habit.id}`);
    return habit;
  }

  async deleteHabit(habitId: string, userId: string): Promise<void> {
    await this.findHabitById(habitId, userId); // Ensure habit exists and belongs to user

    await this.prisma.habit.delete({
      where: { id: habitId },
    });

    this.logger.log(`Deleted habit: ${habitId}`);
  }

  async completeHabit(
    habitId: string,
    userId: string,
  ): Promise<{ habit: Habit; xpGained: number }> {
    const habit = await this.findHabitById(habitId, userId);

    // Update streak and total completions
    const updatedHabit = await this.prisma.habit.update({
      where: { id: habitId },
      data: {
        totalCompletions: habit.totalCompletions + 1,
        currentStreak: habit.currentStreak + 1,
        maxStreak: Math.max(habit.maxStreak, habit.currentStreak + 1),
      },
    });

    this.logger.log(
      `Completed habit: ${habitId}, XP gained: ${habit.xpReward}`,
    );
    return { habit: updatedHabit, xpGained: habit.xpReward };
  }

  async getHabitStats(userId: string): Promise<{
    total: number;
    active: number;
    inactive: number;
    totalCompletions: number;
    averageStreak: number;
  }> {
    const [total, active, habits] = await Promise.all([
      this.prisma.habit.count({ where: { userId } }),
      this.prisma.habit.count({ where: { userId, isActive: true } }),
      this.prisma.habit.findMany({
        where: { userId },
        select: { totalCompletions: true, currentStreak: true },
      }),
    ]);

    const totalCompletions = habits.reduce(
      (sum, habit) => sum + habit.totalCompletions,
      0,
    );
    const averageStreak =
      habits.length > 0
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
}
