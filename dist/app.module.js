"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const schedule_1 = require("@nestjs/schedule");
const configuration_1 = __importDefault(require("./config/configuration"));
const prisma_service_1 = require("./database/prisma.service");
const services_1 = require("./services");
const telegram_bot_module_1 = require("./bot/telegram-bot.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                load: [configuration_1.default],
            }),
            schedule_1.ScheduleModule.forRoot(),
            telegram_bot_module_1.TelegramBotModule,
        ],
        providers: [
            prisma_service_1.PrismaService,
            services_1.UserService,
            services_1.TaskService,
            services_1.HabitService,
            services_1.MoodService,
            services_1.FocusService,
            services_1.OpenAIService,
            services_1.AiContextService,
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map