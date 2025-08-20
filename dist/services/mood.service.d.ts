import { PrismaService } from '../database/prisma.service';
import { MoodEntry, MoodType } from '@prisma/client';
import { CreateMoodEntryDto, UpdateMoodEntryDto } from '../dto';
export declare class MoodService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    createMoodEntry(createMoodEntryDto: CreateMoodEntryDto): Promise<MoodEntry>;
    findMoodEntriesByUserId(userId: string, startDate?: Date, endDate?: Date): Promise<MoodEntry[]>;
    findMoodEntryById(entryId: string, userId: string): Promise<MoodEntry>;
    updateMoodEntry(entryId: string, userId: string, updateMoodEntryDto: UpdateMoodEntryDto): Promise<MoodEntry>;
    deleteMoodEntry(entryId: string, userId: string): Promise<void>;
    getTodayMoodEntry(userId: string): Promise<MoodEntry | null>;
    getMoodStats(userId: string, days?: number): Promise<{
        averageRating: number;
        mostCommonMood: MoodType;
        totalEntries: number;
        moodDistribution: Record<MoodType, number>;
    }>;
}
