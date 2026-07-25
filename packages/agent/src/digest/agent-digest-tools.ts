import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import type { DigestService } from './digest.service';
import type { ComposedDigest, DigestPeriod } from './digest.types';
import { DIGEST_PERIODS } from './digest.types';

/**
 * Digest briefings (Wave 7) — chat tool for the digest surface, per
 * the program DoD rule that every new entity/surface ships with chat
 * tools + keyword slots.
 *
 * Mirrors `ingest/agent-ingest-tools.ts`: a descriptor-factory the
 * tool assembly concatenates at run time (type-only import of
 * `TaskToolDescriptor`, so the Tasks runtime graph is NOT pulled into
 * the digest subpath).
 *
 * Keyword slots: "digest", "briefing", "what happened today / this
 * week", "summary of my activity", "daily recap" style asks route
 * here; the composed digest is deterministic (no LLM), so the chat
 * layer can quote its counts verbatim.
 */

export interface GetDigestArgs {
    /** 'daily' (default) or 'weekly'. */
    period?: string;
}

export function buildDigestTools(args: {
    /** Owner scope — the tool only ever composes this user's digest. */
    userId: string;
    digestService: Pick<DigestService, 'composeDigest'>;
}): TaskToolDescriptor[] {
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: 'get_digest',
        description:
            'Compose an on-demand activity briefing for the current user: agent runs completed/failed, tasks done or moved to review, pull requests opened, ingested-event counts by source, and active goal progress. Returns deterministic counts plus a rendered markdown body. period is "daily" (last 24 hours, default) or "weekly" (last 7 days).',
        parameters: {
            type: 'object',
            properties: {
                period: {
                    type: 'string',
                    description: 'Digest window: "daily" (default) or "weekly".',
                },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as GetDigestArgs;
            const period = (a.period ?? 'daily') as DigestPeriod;
            if (!DIGEST_PERIODS.includes(period)) {
                return { error: `Invalid period "${a.period}": expected "daily" or "weekly".` };
            }
            try {
                return await args.digestService.composeDigest(args.userId, { period });
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies TaskToolDescriptor<GetDigestArgs, ComposedDigest>);

    return out;
}
