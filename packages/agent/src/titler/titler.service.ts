import { Injectable, Logger } from '@nestjs/common';

/**
 * Kind hint for `TitlerService.generateTitle`. The titler doesn't
 * branch implementation today (heuristic version returns the same
 * shape for all kinds), but the hint is plumbed through so the
 * future AI-driven path can tune its system prompt per kind:
 *
 *   - 'idea'    → atomic, action-oriented ("Build X", "Catalog Y").
 *   - 'mission' → ambitious + ongoing ("Run the best X worldwide").
 *   - 'work'    → noun-phrase describing the artifact ("Y Directory").
 */
export type TitleKind = 'idea' | 'mission' | 'work';

export interface GenerateTitleOptions {
    /** What kind of object this title is for. See `TitleKind`. */
    kind?: TitleKind;
    /** Hard cap on returned title length in characters. Default 80. */
    maxChars?: number;
    /** User id, used by the (future) AI path for routing + quota. */
    userId?: string;
}

/** Returned when input is empty / whitespace / nonsense. */
const FALLBACK_TITLES: Record<TitleKind, string> = {
    idea: 'Untitled Idea',
    mission: 'Untitled Mission',
    work: 'Untitled Work',
};

/**
 * Phase 3 PR I — shared title-generation service (Missions/Ideas/Works
 * build, PLAN §5.5 PR I).
 *
 * One entry point for short titles derived from longer prompt text.
 * Today the implementation is a deterministic heuristic (first
 * sentence-ish, clipped to N chars, fallback for empty input).
 * The interface deliberately accepts a `kind` hint + `userId` so
 * a follow-up PR can swap in an AI-driven path without touching
 * any call site:
 *
 *   1. PR I (this) — heuristic only. Predictable, free, deterministic.
 *   2. Follow-up   — flip the implementation to try AI first via
 *      `AiFacadeService.askText`, falling back to the same heuristic
 *      on provider failure / no API key. Public method signature
 *      stays identical so consumers are unaffected.
 *
 * Consumers (Phase 3 PR I wires the first three; Work title
 * fallback lands later when it's needed):
 *   - `WorkProposalService.createUserManual` (Phase 1 PR B
 *     replaced its inline `deriveTitle` with a call to this)
 *   - `MissionsService.create` (uses this when the caller's
 *     `title` is empty or missing)
 *   - Phase 3 PR J Mission tick worker (titles spawned Ideas
 *     from the model output if it's verbose)
 *   - Future: Work title fallback in the Work create path
 *
 * The service is stateless and has no DI dependencies — safe to
 * register in multiple modules without coordination.
 */
@Injectable()
export class TitlerService {
    private readonly logger = new Logger(TitlerService.name);

    /**
     * Generate a short title from a free-text prompt. Always returns
     * a non-empty string — falls back to a kind-aware default
     * ("Untitled Idea" / "Untitled Mission" / "Untitled Work") when
     * the prompt is empty or contains no usable characters.
     *
     * Idempotent and side-effect-free in the heuristic implementation.
     * The future AI-backed version will be non-deterministic but
     * never throw — provider failures fall back to the heuristic.
     */
    async generateTitle(prompt: string, opts: GenerateTitleOptions = {}): Promise<string> {
        const kind = opts.kind ?? 'idea';
        const maxChars = Math.max(8, opts.maxChars ?? 80);
        return this.heuristicTitle(prompt, kind, maxChars);
    }

    /**
     * Heuristic: take the first sentence-ish of the prompt (split on
     * `.` / newline), trim, collapse interior whitespace, drop
     * trailing punctuation, clip to `maxChars`. Returns the
     * kind-appropriate fallback when nothing usable remains.
     *
     * Exposed as a private method so the eventual AI-backed override
     * of `generateTitle` can still call this as its failure fallback
     * without duplicating the heuristic.
     */
    private heuristicTitle(prompt: string, kind: TitleKind, maxChars: number): string {
        if (typeof prompt !== 'string') {
            return FALLBACK_TITLES[kind];
        }
        const firstSentence = prompt.split(/[.\n]/, 1)[0] ?? '';
        // Collapse interior whitespace so "  Build   X  Y  " → "Build X Y".
        const collapsed = firstSentence.trim().replace(/\s+/g, ' ');
        // Strip trailing punctuation — sentence-end markers add no
        // signal in a title.
        const stripped = collapsed.replace(/[!?,;:\-—]+$/, '').trim();
        const clipped = stripped.slice(0, maxChars).trim();
        return clipped.length > 0 ? clipped : FALLBACK_TITLES[kind];
    }
}
