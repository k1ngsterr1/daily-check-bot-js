import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { BotContext } from './bot-context.interface';
import { UserService } from '../services/user.service';
import { OpenAIService } from '../services/openai.service';
export declare class TelegramBotService implements OnModuleInit, OnModuleDestroy {
    private readonly configService;
    private readonly userService;
    private readonly openaiService;
    private readonly logger;
    private bot;
    constructor(configService: ConfigService, userService: UserService, openaiService: OpenAIService);
    private setupMiddleware;
    private setupHandlers;
    onModuleInit(): Promise<void>;
    onModuleDestroy(): Promise<void>;
    private startOnboarding;
    private showOnboardingStep1;
    private showOnboardingStep2;
    private showOnboardingStep3;
    private showMainMenu;
    launch(): Promise<void>;
    stop(): Promise<void>;
    getBotInstance(): Telegraf<BotContext>;
    private askForTimezone;
    private handleCityInput;
}
