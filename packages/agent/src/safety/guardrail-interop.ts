import type { LadderedActionCategory, ResolvedLadder } from '@ever-works/contracts';
import type { GuardrailDecision } from '../agents/guardrails';
import { ladderEntry } from './trust-ladder';

/**
 * Safety rails (AW-24) — where the ladder meets the per-Agent dispatch
 * guardrails.
 *
 * Both exist. Both stay. The guardrails are a two-mode policy over four
 * internal action types, stored on the Agent row, with no workspace scope and
 * no notion of a KIND of work; the ladder is per-category and resolves down
 * three scopes. They answer different questions, so neither replaces the
 * other — and where both have an opinion, **the stricter wins**.
 *
 * That is the only rule here, and it is one-directional on purpose: the
 * ladder can never make an Agent MORE autonomous than its guardrails already
 * allow, and guardrails can never lift a rung. Anything else would give an
 * owner two switches where flipping one could undo the other.
 *
 * Pure and no-IO, like `agents/guardrails.ts` itself, so both halves of the
 * rule can be read in one place and tested without a database.
 */

/**
 * The action types the approval queue carries, mapped to a kind of work.
 *
 * `other` is deliberately absent: an action type the platform has not
 * classified has no rung, so the ladder says nothing about it and the
 * guardrail decision stands unchanged (FR-3 — unclassified is never guessed
 * into a category).
 */
export const PROPOSAL_ACTION_CATEGORY: Readonly<Record<string, LadderedActionCategory>> =
    Object.freeze({
        spawn_agent: 'agent.fanout',
        schedule_task: 'agent.fanout',
        // A proposed message is classified as leaving the workspace: the
        // proposal payload names its recipient, and a payload field is
        // model-writable, so the classification takes the MORE RESTRICTIVE of
        // the two plausible categories rather than reading the recipient
        // (FR-4, FR-6).
        send_message: 'message.external',
        budget_override: 'spend.metered',
        merge_pull_request: 'publish.external',
    } as Record<string, LadderedActionCategory>);

/**
 * Fold a resolved ladder into a guardrail decision.
 *
 * Returns the STRICTER of the two, where strictness is
 * `block` > `queue` > `auto_approve`:
 *
 *   - rung `off`            → `block`      (the ladder refuses outright)
 *   - rung `draft` / `ask`  → at least `queue`
 *   - rung `auto`           → no opinion; the guardrail decision stands
 *   - no ladder, no mapping, or an unenforced shipped default
 *                           → no opinion; the guardrail decision stands
 *
 * A `block` from the guardrails is never softened, whatever the rung says.
 */
export function applyLadderToGuardrailDecision(
    decision: GuardrailDecision,
    actionType: string,
    ladder: ResolvedLadder | null | undefined,
): GuardrailDecision {
    if (decision === 'block') return 'block';
    if (!ladder) return decision;

    const category = PROPOSAL_ACTION_CATEGORY[actionType];
    if (!category) return decision;

    const entry = ladderEntry(ladder, category);
    if (!entry || !entry.enforced) return decision;

    if (entry.rung === 'off') return 'block';
    if (entry.rung === 'draft' || entry.rung === 'ask') return 'queue';
    return decision;
}

/** Which scope decided, for the Safety tab's "and this is what decided" line. */
export function ladderDecidedGuardrail(
    decision: GuardrailDecision,
    withLadder: GuardrailDecision,
): 'guardrails' | 'ladder' {
    return decision === withLadder ? 'guardrails' : 'ladder';
}
