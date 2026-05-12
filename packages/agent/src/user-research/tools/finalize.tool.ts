import { tool } from 'ai';
import { inferredProfileSchema, type InferredProfile } from '../schemas';

interface CreateFinalizeToolOptions {
    onFinalize: (profile: InferredProfile) => void;
}

export function createFinalizeTool(opts: CreateFinalizeToolOptions) {
    return tool({
        description:
            'Call exactly once when you have gathered enough information about the user. Provide the inferred profile matching the schema. After calling this, the agent run will end.',
        inputSchema: inferredProfileSchema,
        execute: async (profile) => {
            opts.onFinalize(profile);
            return { ok: true };
        },
    });
}
