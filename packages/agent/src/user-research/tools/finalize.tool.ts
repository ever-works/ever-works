import { tool } from 'ai';
import { inferredProfileSchema, type InferredProfile } from '../schemas';

interface CreateFinalizeToolOptions {
	onFinalize: (profile: InferredProfile) => void;
}

/**
 * Structured-exit tool. The agent calls this with its final inferred profile
 * (Zod-validated by the AI SDK). Setting the captured profile from here gives
 * us guaranteed structured output without a second LLM call to summarize.
 */
export function createFinalizeTool(opts: CreateFinalizeToolOptions) {
	return tool({
		description:
			'Call exactly once when you have gathered enough information about the user. Provide the inferred profile matching the schema. After calling this, the agent run will end.',
		inputSchema: inferredProfileSchema,
		execute: async (profile) => {
			opts.onFinalize(profile);
			return { ok: true };
		}
	});
}
