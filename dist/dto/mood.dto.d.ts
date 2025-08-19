import { MoodType } from '@prisma/client';
export declare class CreateMoodEntryDto {
    userId: string;
    mood: MoodType;
    rating?: number;
    note?: string;
    emotions?: string[];
    factors?: string[];
    isPrivate?: boolean;
}
export declare class UpdateMoodEntryDto {
    mood?: MoodType;
    rating?: number;
    note?: string;
    emotions?: string[];
    factors?: string[];
    isPrivate?: boolean;
}
