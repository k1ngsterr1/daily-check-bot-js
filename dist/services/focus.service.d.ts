import { PrismaService } from '../database/prisma.service';
import { FocusSession } from '@prisma/client';
import { CreateFocusSessionDto, UpdateFocusSessionDto } from '../dto';
export declare class FocusService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    createFocusSession(createFocusSessionDto: CreateFocusSessionDto): Promise<FocusSession>;
    findFocusSessionsByUserId(userId: string): Promise<FocusSession[]>;
    findFocusSessionById(sessionId: string, userId: string): Promise<FocusSession>;
    updateFocusSession(sessionId: string, userId: string, updateFocusSessionDto: UpdateFocusSessionDto): Promise<FocusSession>;
    completeFocusSession(sessionId: string, userId: string, actualDuration: number, productivityRating?: number): Promise<{
        session: FocusSession;
        xpGained: number;
    }>;
    pauseFocusSession(sessionId: string, userId: string): Promise<FocusSession>;
    resumeFocusSession(sessionId: string, userId: string): Promise<FocusSession>;
    getActiveFocusSession(userId: string): Promise<FocusSession | null>;
    getTodayFocusTime(userId: string): Promise<number>;
    getFocusStats(userId: string, days?: number): Promise<{
        totalSessions: number;
        completedSessions: number;
        totalFocusTime: number;
        averageSessionLength: number;
        averageProductivityRating: number;
        completionRate: number;
    }>;
}
