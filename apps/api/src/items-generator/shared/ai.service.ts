import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly llm: ChatOpenAI;
  private readonly isConfigured: boolean;

  constructor() {
    this.isConfigured = !!process.env.OPENAI_API_KEY;
    
    if (!this.isConfigured) {
      this.logger.warn(
        'OPENAI_API_KEY not found in .env file. AI features will be limited.',
      );
    }
    
    this.llm = new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      modelName: process.env.OPENAI_MODEL || 'gpt-4.1',
      temperature: 0.7,
    });
  }

  isApiKeyConfigured(): boolean {
    return this.isConfigured;
  }

  /**
   * Get the LLM instance
   */
  getLlm(): ChatOpenAI {
    return this.llm;
  }

  /**
   * Check if the AI service is properly configured
   */
  isAiConfigured(): boolean {
    return this.isConfigured;
  }

  /**
   * Create a temporary LLM with a different temperature
   * @param temperature The temperature to use (0-1)
   */
  createLlmWithTemperature(temperature: number): ChatOpenAI {
    return new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      modelName: process.env.OPENAI_MODEL || 'gpt-4.1',
      temperature,
    });
  }
}
