import { Context } from 'telegraf';

export interface BotContext extends Context {
  session: {
    step?: string;
    data?: any;
    waitingForInput?: boolean;
    currentAction?: string;
    tempData?: any;
    feedbackRating?: number;
    feedbackLiked?: string;
    aiChatMode?: boolean;
    aiHabitCreationMode?: boolean;
    pendingReminder?: {
      text: string;
      originalText: string;
    };
    waitingForReminderTime?: boolean;
    pendingAction?: string;
    pendingTaskTitle?: string;
    notificationTime?: number;
  };

  // User info
  userId: string;

  // Helper methods
  replyWithMarkdown(text: string, extra?: any): Promise<any>;
  editMessageTextWithMarkdown(text: string, extra?: any): Promise<any>;
}
