import { Injectable, Logger } from '@nestjs/common';
import { BaseChatModel } from '../shared/ai-provider.interface';
import { PromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { AiService } from '../shared';

// Prompt comparison prompt
const PROMPT_COMPARISON_PROMPT = `
You are a helpful assistant tasked with comparing two prompts to determine if they are related and describe the same or similar data generation context.

<existing_prompt>
{existingPrompt}
</existing_prompt>

<new_prompt>
{newPrompt}
</new_prompt>

Your task:
1. Analyze both prompts to understand their intent, scope, and target domain.
2. Determine if they are describing the same or very similar data generation context.
3. Consider them related if they:
   - Target the same general domain or topic area
   - Have similar scope and intent
   - Would likely generate similar types of items/data
   - Are variations or refinements of the same core request

4. Consider them unrelated if they:
   - Target completely different domains or topics
   - Have fundamentally different scopes or intents
   - Would generate completely different types of items/data

5. Provide a clear reasoning for your decision.

Be somewhat lenient in determining relatedness - minor variations, additional details, or slight scope changes should still be considered related if the core intent is similar.
`;

// Output schema for validation
const promptComparisonOutputSchema = z.object({
    areRelated: z
        .boolean()
        .describe('Whether the prompts are related and describe similar data generation context'),
    confidence: z
        .number()
        .min(0)
        .max(1)
        .describe('Confidence level in the comparison result (0-1)'),
    reasoning: z
        .string()
        .describe('Detailed explanation of why the prompts are considered related or unrelated'),
});

export type PromptComparisonResult = z.infer<typeof promptComparisonOutputSchema>;

@Injectable()
export class PromptComparisonService {
    private readonly logger = new Logger(PromptComparisonService.name);
    private llm: BaseChatModel;

    constructor(private readonly aiService: AiService) {
        // Use low temperature for consistent comparison results
        this.llm = this.aiService.createLlmWithTemperature(0.1);
    }

    /**
     * Compare two prompts to determine if they are related
     * @param slug The slug for logging purposes
     * @param existingPrompt The existing prompt from the configuration
     * @param newPrompt The new prompt from the request
     * @returns Comparison result with relatedness determination and reasoning
     */
    async comparePrompts(
        slug: string,
        existingPrompt: string,
        newPrompt: string,
    ): Promise<PromptComparisonResult> {
        if (!existingPrompt || !newPrompt) {
            return {
                areRelated: false,
                confidence: 0,
                reasoning: 'Cannot compare prompts: one or both prompts are empty or undefined',
            };
        }

        // If prompts are identical, they are definitely related
        if (existingPrompt.trim() === newPrompt.trim()) {
            return {
                areRelated: true,
                confidence: 1.0,
                reasoning: 'The prompts are identical',
            };
        }

        try {
            const promptTemplate = PromptTemplate.fromTemplate(PROMPT_COMPARISON_PROMPT);
            const result = await promptTemplate
                .pipe(this.llm.withStructuredOutput(promptComparisonOutputSchema))
                .invoke({
                    existingPrompt,
                    newPrompt,
                });

            return result;
        } catch (error) {
            this.logger.error(`[${slug}] Error comparing prompts: ${error.message}`, error.stack);

            // Fallback to simple string similarity check
            const similarity = this.calculateSimpleSimilarity(existingPrompt, newPrompt);
            const areRelated = similarity > 0.5;

            return {
                areRelated,
                confidence: 0.3,
                reasoning: `AI comparison failed, used fallback similarity check. Similarity score: ${similarity.toFixed(2)}`,
            };
        }
    }

    /**
     * Simple fallback similarity calculation using basic text comparison
     * @param text1 First text to compare
     * @param text2 Second text to compare
     * @returns Similarity score between 0 and 1
     */
    private calculateSimpleSimilarity(text1: string, text2: string): number {
        if (!text1 || !text2) return 0;

        const normalize = (text: string) =>
            text
                .toLowerCase()
                .replace(/[^\w\s]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

        const words1 = new Set(normalize(text1).split(' '));
        const words2 = new Set(normalize(text2).split(' '));

        const intersection = new Set([...words1].filter((word) => words2.has(word)));
        const union = new Set([...words1, ...words2]);

        return union.size > 0 ? intersection.size / union.size : 0;
    }
}
