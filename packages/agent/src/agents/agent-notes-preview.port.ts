/**
 * AW-23 — the NOTES PREVIEW port for the agent identity card.
 *
 * Token + contract only (leaf file, zero imports — the same
 * circular-dependency dodge as `run-kill-switch.ts` and
 * `run-agent-brake.ts`, see `docs/architecture/agent-injection-tokens.md`).
 *
 * WHY A PORT AND NOT A STORE. The identity card states, in two lines,
 * what an agent has been told to remember. The notes FILE itself — its
 * storage, its every-run load, its budget, its revision history and the
 * permission an agent needs to write it — belongs to the memory-and-
 * context-files work, and this epic deliberately adds NO second notes
 * mechanism and NO second notes budget. So the card asks for a preview
 * through this seam instead of reading, caching or persisting anything
 * of its own.
 *
 * NOTHING BINDS THIS TOKEN TODAY. Unbound, the card's Notes row renders
 * its documented empty state ("No notes yet") and the identity payload
 * carries `notesPreview: null`. When the memory work lands it binds one
 * provider here and the row lights up with no change to this epic's
 * card, its endpoint or its DTO.
 *
 * Fail-soft by contract: a preview that cannot be read is `null`, never
 * an error. A card must never fail to paint because one of its rows had
 * nothing to say.
 */

export interface AgentNotesPreview {
    /**
     * The first lines of this agent's durable notes, already trimmed to
     * what the card shows, or `null` when the agent has none.
     *
     * Implementations MUST NOT throw: resolve `null` on any failure.
     */
    previewForAgent(agentId: string): Promise<string | null>;
}

export const AGENT_NOTES_PREVIEW = 'AGENT_NOTES_PREVIEW' as const;

/** How many leading lines of the notes body the identity card shows. */
export const AGENT_NOTES_PREVIEW_LINES = 2;
