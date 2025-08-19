import { AppService } from './app.service';
import { PaymentService } from './services/payment.service';
export declare class AppController {
    private readonly appService;
    private readonly paymentService;
    private readonly logger;
    constructor(appService: AppService, paymentService: PaymentService);
    getHello(): string;
    handleYookassaWebhook(body: any): Promise<{
        status: string;
    }>;
}
