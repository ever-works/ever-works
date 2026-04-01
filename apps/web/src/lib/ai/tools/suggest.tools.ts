import { z } from 'zod';
import { tool, generateText, type LanguageModel } from 'ai';
import { directoryAPI } from '@/lib/api/directory';
import { webSearch } from './search.tools';
import { getUserInfo } from './user.tools';

const RESEARCH_AGENT_PROMPT = `You are a research assistant for Ever Works, a directory builder platform.
Your task is to learn about the user and suggest directory ideas they could create.

## YOUR APPROACH

1. First call getUserInfo to learn the user's name and email.
2. Use webSearch to research the user — search for their name, email, company, social profiles, or professional interests.
3. Run 2-4 searches to build a picture of the user's domain, industry, and interests.
4. Based on what you find, suggest 3-5 specific directory ideas that would be valuable for this person.

## DIRECTORY SUGGESTIONS FORMAT

For each suggestion include:
- **Name**: A clear, descriptive directory name
- **Description**: One sentence explaining what it would contain
- **Why**: Why this would be useful for this specific user based on what you found

## RULES
- Be specific — generic suggestions like "tech tools" are useless. Tie each suggestion to something concrete you found about the user.
- If web search is unavailable, fall back to suggesting directories based solely on the user profile info.
- If you find nothing about the user, be honest and suggest asking the user about their interests instead.
- Keep your final response concise and actionable.`;

/**
 * Creates the suggestDirectories tool with a bound model.
 * This tool runs a subagent that autonomously researches the user
 * via webSearch + getUserInfo and returns personalized directory ideas.
 */
export function createSuggestDirectoriesTool(model: LanguageModel) {
    return tool({
        description: [
            'Research the current user and suggest personalized directory ideas.',
            'This tool autonomously searches for user info online, analyzes their interests,',
            'and returns tailored directory suggestions. Use when the user asks for suggestions,',
            '"what should I create?", or "help me get started".',
        ].join(' '),
        inputSchema: z.object({
            additionalContext: z
                .string()
                .optional()
                .describe('Any additional context from the user about what they are interested in'),
        }),
        execute: async ({ additionalContext }, { abortSignal }) => {
            try {
                // Fetch existing directories so the subagent avoids duplicates
                let existingDirectories: string[] = [];
                try {
                    const dirs = await directoryAPI.getAll({ limit: 10 });
                    existingDirectories = dirs.directories.map((d: { name: string }) => d.name);
                } catch {
                    // Not critical
                }

                const parts: string[] = ['Research the user and suggest directory ideas.'];
                if (additionalContext) {
                    parts.push(`Additional context from user: "${additionalContext}"`);
                }
                if (existingDirectories.length) {
                    parts.push(
                        `They already have these directories: ${existingDirectories.join(', ')}. Don't suggest duplicates.`,
                    );
                }

                const result = await generateText({
                    model,
                    system: RESEARCH_AGENT_PROMPT,
                    prompt: parts.join('\n\n'),
                    tools: { webSearch, getUserInfo },
                    maxRetries: 1,
                    abortSignal,
                    stopWhen: ({ steps }) => steps.length >= 8,
                });

                return {
                    success: true,
                    suggestions: result.text,
                    searchesPerformed: result.steps.filter(
                        (s) => s.toolCalls && s.toolCalls.length > 0,
                    ).length,
                };
            } catch (error) {
                return {
                    success: false,
                    suggestions: null,
                    message:
                        error instanceof Error
                            ? error.message
                            : 'Failed to research user interests.',
                };
            }
        },
    });
}
