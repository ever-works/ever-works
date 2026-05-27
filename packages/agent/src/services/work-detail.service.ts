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

/**
 * Generates the structured description/keywords/categories triple for
 * a new Work from a free-text name + prompt, plus a unique slug.
 *
 * **Behavioural notes worth flagging:**
 *
 *   - **AI-failure fallback is invisible to callers.** When
 *     {@link AiFacadeService.askJson} throws, this service returns
 *     hardcoded values (`"Work for {name}"` + `[name.toLowerCase()]`
 *     + `[]`) under the same return shape as a successful AI run.
 *     There is no field on `WorkDetails` that distinguishes
 *     fallback from real output. Consumers that care about
 *     AI-generated quality (e.g. retry decisions, telemetry on AI
 *     failure rate) need to either add a discriminator here OR
 *     watch the error log line `Error extracting details for
 *     work …` to know how often the fallback fires.
 *
 *   - **`generateUniqueSlug` lookup-then-create is NOT atomic.**
 *     Two concurrent creations for the same user with the same
 *     base slug can both clear the existence check and both
 *     proceed to write. Downstream insert must rely on a DB
 *     UNIQUE constraint on `(userId, slug)` to catch the race;
 *     this service won't.
 *
 *   - **Slug counter has no upper bound.** Unlike
 *     `OnboardingAccountAdapter.resolveUniqueUsername` (which
 *     caps at 50 iterations and falls through to a UUID
 *     suffix), this loops until it finds a free slot. Per-user
 *     slug collisions are rare in practice, but a user creating
 *     hundreds of Works under the same generic name would walk
 *     the counter linearly. Add a ceiling + suffix fallback if
 *     this ever becomes hot.
 *
 *   - **Sanitisation is unconditional.** Both the AI path and
 *     the fallback path run outputs through {@link sanitizeDescription}
 *     / {@link sanitizeStringArray}. The inline comment
 *     ("critical for GitHub API compatibility") is load-bearing —
 *     removing sanitisation here breaks the downstream
 *     `gh issue create` / `gh repo create` calls that take this
 *     description verbatim.
 *
 *   - **`temperature: 0` + `complexity: 'simple'`** are deliberate:
 *     deterministic output maximises cache reuse upstream, and
 *     'simple' routes to a smaller/cheaper model. Don't bump these
 *     for "better quality" without measuring the prompt-cache hit
 *     rate hit.
 */
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
