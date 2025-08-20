import { ConfigService } from '@nestjs/config';
export declare class OpenAIService {
    private readonly configService;
    private readonly logger;
    private openai;
    constructor(configService: ConfigService);
    getTimezoneByCity(city: string): Promise<{
        timezone: string;
        normalizedCity: string;
    } | null>;
    getAIResponse(prompt: string): Promise<string>;
    transcribeAudio(audioFile: File): Promise<string | null>;
}
