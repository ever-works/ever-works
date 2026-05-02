import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiFacadeService } from '../facades/ai.facade';
import { User } from '../entities';
import { WorkRepository } from '../database';
import { slugifyText } from '../utils/text.utils';
import { sanitizeDescription, sanitizeStringArray } from '../utils/sanitize.util';

// Prompt for extracting work details
export const WORK_DETAIL_PROMPT = `
You are a work website builder assistant. Your task is to analyze a work name and prompt to extract relevant details.

Work Name: {name}
User Prompt: {prompt}

Based on the name and prompt, extract the following information:
1. A clear, concise description of what this work is about
2. Relevant keywords that describe the work's content and purpose
3. Any additional context that would help users understand the work
4. Avoid starting descriptions with phrases like "This work is about..."; instead, get straight to the point.
    e.g. instead of "Collection of AI tools for developers", write "AI tools for developers"

Rules:
- Description should be 1-2 sentences, clear and informative
- Keywords should be relevant and specific to the work's purpose
- Focus on the main topic and scope of the work
- Avoid marketing language, keep it factual and descriptive
`;

// Output schema for validation
export const workDetailSchema = z.object({
    description: z.string().describe('Clear, concise description of the work (1-2 sentences)'),
    keywords: z.array(z.string()).describe('Array of relevant keywords describing the work'),
    categories: z
        .array(z.string())
        .nullable()
        .describe('One or more relevant high-level category names.'),
});

export interface WorkDetails {
    name: string;
    slug: string;
    description: string;
    keywords: string[];
    categories: string[];
}

@Injectable()
export class WorkDetailService {
    private readonly logger = new Logger(WorkDetailService.name);

    constructor(
        private readonly aiFacade: AiFacadeService,
        private readonly workRepository: WorkRepository,
    ) {}

    /**
     * Extracts work details from name and prompt using AI
     * @param name The work name
     * @param prompt The user prompt describing the work
     * @param user The user creating the work
     * @returns Extracted work details with unique slug
     */
    async generateWorkDetails(
        name: string,
        prompt: string,
        user: User,
        aiProvider?: string,
    ): Promise<WorkDetails> {
        this.logger.log(`Extracting details for work: ${name}`);

        try {
            // Generate AI-extracted details via facade
            const { result } = await this.aiFacade.askJson(
                WORK_DETAIL_PROMPT,
                workDetailSchema,
                {
                    temperature: 0,
                    variables: { name, prompt },
                    routing: { complexity: 'simple' },
                },
                { userId: user.id, providerOverride: aiProvider },
            );

            // Generate unique slug
            const baseSlug = slugifyText(name);
            const uniqueSlug = await this.generateUniqueSlug(baseSlug, user.id);

            // Sanitize AI-generated content to remove newlines and control characters
            // This is critical for GitHub API compatibility
            return {
                name,
                slug: uniqueSlug,
                description: sanitizeDescription(result.description),
                keywords: sanitizeStringArray(result.keywords),
                categories: sanitizeStringArray(result.categories || []),
            };
        } catch (error) {
            this.logger.error(
                `Error extracting details for work ${name}: ${error.message}`,
                error.stack,
            );

            // Fallback to basic details if AI extraction fails
            const baseSlug = slugifyText(name);
            const uniqueSlug = await this.generateUniqueSlug(baseSlug, user.id);

            return {
                name,
                slug: uniqueSlug,
                description: sanitizeDescription(`Work for ${name}`),
                keywords: [name.toLowerCase().trim()],
                categories: [],
            };
        }
    }

    /**
     * Generates a unique slug by checking for conflicts and appending numbers
     * @param baseSlug The base slug to check
     * @param userId The user ID to check conflicts for
     * @returns Unique slug
     */
    private async generateUniqueSlug(baseSlug: string, userId: string): Promise<string> {
        let slug = baseSlug;
        let counter = 1;

        // Check if base slug exists
        while (await this.workRepository.existsByUserAndSlug(userId, slug)) {
            slug = `${baseSlug}-${counter}`;
            counter++;
        }

        return slug;
    }
}
