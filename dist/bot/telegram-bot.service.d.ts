import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { BotContext } from './bot-context.interface';
import { UserService } from '../services/user.service';
export declare class TelegramBotService implements OnModuleInit, OnModuleDestroy {
    private readonly configService;
    private readonly userService;
    private readonly logger;
    private bot;
    constructor(configService: ConfigService, userService: UserService);
    private setupMiddleware;
    private setupHandlers;
    onModuleInit(): Promise<void>;
    onModuleDestroy(): Promise<void>;
    private startOnboarding;
    private showMainMenu;
    launch(): Promise<void>;
    stop(): Promise<void>;
    getBotInstance(): Telegraf<BotContext>;
}
