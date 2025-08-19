"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var AppController_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppController = void 0;
const common_1 = require("@nestjs/common");
const app_service_1 = require("./app.service");
const payment_service_1 = require("./services/payment.service");
let AppController = AppController_1 = class AppController {
    appService;
    paymentService;
    logger = new common_1.Logger(AppController_1.name);
    constructor(appService, paymentService) {
        this.appService = appService;
        this.paymentService = paymentService;
    }
    getHello() {
        return this.appService.getHello();
    }
    async handleYookassaWebhook(body) {
        try {
            this.logger.log('Received YooKassa webhook:', JSON.stringify(body, null, 2));
            if (body.event === 'payment.succeeded' ||
                body.event === 'payment.canceled') {
                await this.paymentService.handlePaymentWebhook(body);
            }
            return { status: 'ok' };
        }
        catch (error) {
            this.logger.error('Error handling YooKassa webhook:', error);
            return { status: 'error' };
        }
    }
};
exports.AppController = AppController;
__decorate([
    (0, common_1.Get)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", String)
], AppController.prototype, "getHello", null);
__decorate([
    (0, common_1.Post)('webhook/yookassa'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AppController.prototype, "handleYookassaWebhook", null);
exports.AppController = AppController = AppController_1 = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [app_service_1.AppService,
        payment_service_1.PaymentService])
], AppController);
//# sourceMappingURL=app.controller.js.map