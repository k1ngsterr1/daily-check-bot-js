export declare class CreateFocusSessionDto {
    userId: string;
    title?: string;
    description?: string;
    plannedDuration?: number;
    category?: string;
    tags?: string[];
}
export declare class UpdateFocusSessionDto {
    title?: string;
    description?: string;
    actualDuration?: number;
    endedAt?: Date;
    breaksTaken?: number;
    breakDuration?: number;
    notes?: string;
    productivityRating?: number;
}
