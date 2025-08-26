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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var OpenAIService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const openai_1 = __importDefault(require("openai"));
let OpenAIService = OpenAIService_1 = class OpenAIService {
    configService;
    logger = new common_1.Logger(OpenAIService_1.name);
    openai;
    constructor(configService) {
        this.configService = configService;
        const apiKey = this.configService.get('openai.apiKey');
        if (!apiKey) {
            throw new Error('OPENAI_API_KEY is not provided');
        }
        this.openai = new openai_1.default({
            apiKey: apiKey,
        });
    }
    async getTimezoneByCity(city) {
        try {
            const prompt = `
Определи часовой пояс для города: ${city}

Ответь ТОЛЬКО в формате JSON без дополнительного текста:
{
  "timezone": "Europe/Moscow",
  "normalizedCity": "Москва"
}

Где:
- timezone - стандартное название часового пояса в формате IANA (например: Europe/Moscow, America/New_York, Asia/Tokyo)
- normalizedCity - правильное название города на русском языке

Если город не найден или некорректен, верни null.
      `;
            const response = await this.openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                temperature: 0.1,
                max_tokens: 100,
            });
            const content = response.choices[0]?.message?.content?.trim();
            if (!content || content === 'null') {
                return null;
            }
            const result = JSON.parse(content);
            if (result.timezone && result.normalizedCity) {
                return {
                    timezone: result.timezone,
                    normalizedCity: result.normalizedCity,
                };
            }
            return null;
        }
        catch (error) {
            this.logger.error('Error getting timezone by city:', error);
            return null;
        }
    }
    async getAIResponse(prompt) {
        try {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [
                    {
                        role: 'system',
                        content: 'Ты персональный ассистент по продуктивности. Даешь краткие, практичные советы на русском языке. Отвечай дружелюбно и мотивирующе. Важно: всегда завершай свой ответ полностью, не обрывай на середине предложения или пункта.',
                    },
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                temperature: 0.7,
                max_tokens: 1500,
            });
            const content = response.choices[0]?.message?.content?.trim();
            if (!content) {
                throw new Error('Empty response from OpenAI');
            }
            return content;
        }
        catch (error) {
            this.logger.error('Error getting AI response:', error);
            throw new Error('Не удалось получить ответ от ИИ-консультанта');
        }
    }
    async transcribeAudio(audioFile) {
        try {
            const transcription = await this.openai.audio.transcriptions.create({
                file: audioFile,
                model: 'whisper-1',
                language: 'ru',
                response_format: 'text',
            });
            return transcription || null;
        }
        catch (error) {
            this.logger.error('Error transcribing audio:', error);
            return null;
        }
    }
    async getTaskAdvice(userId, aiContextService) {
        return aiContextService.analyzeProductivity(userId);
    }
    async getHabitHelp(userId, aiContextService) {
        return aiContextService.generatePersonalizedMessage(userId, 'habit_advice');
    }
    async getTimePlanning(userId, aiContextService) {
        return aiContextService.generatePersonalizedMessage(userId, 'focus_tips');
    }
};
exports.OpenAIService = OpenAIService;
exports.OpenAIService = OpenAIService = OpenAIService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], OpenAIService);
//# sourceMappingURL=openai.service.js.map