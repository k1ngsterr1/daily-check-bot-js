import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

@Injectable()
export class OpenAIService {
  private readonly logger = new Logger(OpenAIService.name);
  private openai: OpenAI;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('openai.apiKey');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not provided');
    }

    this.openai = new OpenAI({
      apiKey: apiKey,
    });
  }

  async getTimezoneByCity(
    city: string,
  ): Promise<{ timezone: string; normalizedCity: string } | null> {
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
    } catch (error) {
      this.logger.error('Error getting timezone by city:', error);
      return null;
    }
  }
}
