import { Injectable, Logger } from '@nestjs/common';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { z } from 'zod';
import { AiService, BaseChatModel } from '../ai';
import { User } from '../entities';
import { DirectoryRepository } from '../database';
import { slugifyText } from '../items-generator';
import { sanitizeDescription, sanitizeStringArray } from '../utils/sanitize.util';

// Prompt for extracting directory details
export const DIRECTORY_DETAIL_PROMPT = `
You are a directory website builder assistant. Your task is to analyze a directory name and prompt to extract relevant details.

Directory Name: {name}
User Prompt: {prompt}

Based on the name and prompt, extract the following information:
1. A clear, concise description of what this directory is about
2. Relevant keywords that describe the directory's content and purpose
3. Any additional context that would help users understand the directory
4. Avoid starting descriptions with phrases like "This directory is about..."; instead, get straight to the point.
    e.g. instead of "Collection of AI tools for developers", write "AI tools for developers"

Rules:
- Description should be 1-2 sentences, clear and informative
- Keywords should be relevant and specific to the directory's purpose
- Focus on the main topic and scope of the directory
- Avoid marketing language, keep it factual and descriptive
`;

// Output schema for validation
export const directoryDetailSchema = z.object({
    description: z.string().describe('Clear, concise description of the directory (1-2 sentences)'),
    keywords: z.array(z.string()).describe('Array of relevant keywords describing the directory'),
    categories: z
        .array(z.string())
        .nullable()
        .describe('One or more relevant high-level category names.'),
});

export interface DirectoryDetails {
    name: string;
    slug: string;
    description: string;
    keywords: string[];
    categories: string[];
}

@Injectable()
export class DirectoryDetailService {
    private readonly logger = new Logger(DirectoryDetailService.name);
    private llm: BaseChatModel;

    constructor(
        private readonly aiService: AiService,
        private readonly directoryRepository: DirectoryRepository,
    ) {
        this.llm = this.aiService.createLlmWithTemperature(0.0);
    }

    /**
     * Extracts directory details from name and prompt using AI
     * @param name The directory name
     * @param prompt The user prompt describing the directory
     * @param user The user creating the directory
     * @returns Extracted directory details with unique slug
     */
    async generateDirectoryDetails(
        name: string,
        prompt: string,
        user: User,
    ): Promise<DirectoryDetails> {
        this.logger.log(`Extracting details for directory: ${name}`);

        try {
            // Generate AI-extracted details
            const promptTemplate = HumanMessagePromptTemplate.fromTemplate(DIRECTORY_DETAIL_PROMPT);
            const result = await promptTemplate
                .pipe(this.llm.withStructuredOutput(directoryDetailSchema))
                .invoke({
                    name,
                    prompt,
                });

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
                `Error extracting details for directory ${name}: ${error.message}`,
                error.stack,
            );

            // Fallback to basic details if AI extraction fails
            const baseSlug = slugifyText(name);
            const uniqueSlug = await this.generateUniqueSlug(baseSlug, user.id);

            return {
                name,
                slug: uniqueSlug,
                description: sanitizeDescription(`Directory for ${name}`),
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
        while (await this.directoryRepository.existsByUserAndSlug(userId, slug)) {
            slug = `${baseSlug}-${counter}`;
            counter++;
        }

        return slug;
    }
}
