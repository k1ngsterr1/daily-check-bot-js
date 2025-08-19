export declare class CreateUserDto {
    id: string;
    username?: string;
    firstName?: string;
    lastName?: string;
}
export declare class UpdateUserDto {
    username?: string;
    firstName?: string;
    lastName?: string;
    timezone?: string;
    city?: string;
}
export declare class UpdateUserStatsDto {
    totalTasks?: number;
    completedTasks?: number;
    totalHabits?: number;
    completedHabits?: number;
    todayTasks?: number;
    todayHabits?: number;
    xpGained?: number;
}
