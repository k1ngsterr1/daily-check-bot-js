"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramBotModule = void 0;
const common_1 = require("@nestjs/common");
const telegram_bot_service_1 = require("./telegram-bot.service");
const prisma_service_1 = require("../database/prisma.service");
const user_service_1 = require("../services/user.service");
const task_service_1 = require("../services/task.service");
let TelegramBotModule = class TelegramBotModule {
};
exports.TelegramBotModule = TelegramBotModule;
exports.TelegramBotModule = TelegramBotModule = __decorate([
    (0, common_1.Module)({
        providers: [telegram_bot_service_1.TelegramBotService, prisma_service_1.PrismaService, user_service_1.UserService, task_service_1.TaskService],
        exports: [telegram_bot_service_1.TelegramBotService],
    })
], TelegramBotModule);
//# sourceMappingURL=telegram-bot.module.js.map