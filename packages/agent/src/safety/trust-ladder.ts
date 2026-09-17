import {
    ACTION_CATEGORY_CEILING,
    ACTION_CATEGORY_DEFAULT,
    LADDERED_CATEGORIES,
    SHIPPED_DEFAULT_RUNG_POLICY,
    compareRung,
    isDraftableCategory,
    minRung,
    nextRungUp,
    offeredRungs,
    type AutonomyGrantScopeType,
    type LadderDecidedBy,
    type LadderedActionCategory,
    type ResolvedLadder,
    type ResolvedLadderEntry,
    type TrustRung,
} from '@ever-works/contracts';

/**
 * Safety rails (AW-24) — the ladder: resolve it, and validate a write to it.
 *
 * Pure, no-IO helper (the same posture as `policy/tool-grant.ts` next door and
 * `agents/guardrails.ts`): the resolution and the rules run identically in the
 * API, the agent tool loop, the worker and — once the screen lands — the web
 * UI. A rung that means one thing on the screen and another at the enforcement
 * point is not a safety property.
 *
 * ## Narrow-only, over exactly three scopes
 *
 *     platform default  <  Workspace  <  Agent
 *
 * A lower scope may only ever move a category to a LOWER or EQUAL rung
 * (FR-10). This is `minRung`, and it is the same rule `tool-grant.ts` applies
 * to glob arrays, expressed over an ordered enum instead.
 *
 * A row that would RAISE is refused at write time, naming the Workspace rung
 * — never silently dropped. An owner who thinks they widened something and
 * did not is worse off than one who was told no.
 */

/** One stored rung, as the resolver reads it. */
export interface AutonomyGrantRow {
    id: string;
    scopeType: AutonomyGrantScopeType;
    scopeId: string;
    category: LadderedActionCategory;
    rung: TrustRung;
}

export interface ResolveLadderTarget {
    /** The Organization id (or the tenant id for a bare-tenant workspace). */
    workspaceScopeId: string;
    /** `null` resolves the Workspace ladder rather than one Agent's. */
    agentId?: string | null;
    /**
     * True when the rungs could not be read. Every laddered category then
     * resolves to **Ask** and the ladder says so (FR-18). Reads and
     * already-running work are unaffected; that is the gate's business, not
     * this function's.
     */
    safeMode?: boolean;
}

/**
 * Fold the stored rows into the ladder that is actually in force.
 *
 * Rows for other scopes are ignored rather than rejected — the caller may
 * hand over everything it loaded, and a row for a different Agent is simply
 * not this Agent's business.
 */
export function resolveLadder(
    rows: readonly AutonomyGrantRow[],
    target: ResolveLadderTarget,
): ResolvedLadder {
    const agentId = target.agentId ?? null;
    const workspaceRows = new Map<LadderedActionCategory, AutonomyGrantRow>();
    const agentRows = new Map<LadderedActionCategory, AutonomyGrantRow>();

    for (const row of rows) {
        if (row.scopeType === 'workspace' && row.scopeId === target.workspaceScopeId) {
            workspaceRows.set(row.category, row);
        } else if (row.scopeType === 'agent' && agentId && row.scopeId === agentId) {
            agentRows.set(row.category, row);
        }
    }

    const entries: ResolvedLadderEntry[] = LADDERED_CATEGORIES.map((category) => {
        const ceiling = ACTION_CATEGORY_CEILING[category];
        const defaultRung = ACTION_CATEGORY_DEFAULT[category];
        const draftable = isDraftableCategory(category);

        if (target.safeMode) {
            // Fail closed (FR-18): every laddered category behaves as Ask —
            // or at its ceiling, where the ceiling is stricter than Ask, so
            // safe mode can never be a way to widen `spend.commitment`.
            return {
                category,
                rung: minRung('ask', ceiling),
                decidedBy: 'default',
                ceiling,
                draftable,
                defaultRung,
                workspaceRung: null,
                grantId: null,
                enforced: true,
            };
        }

        const workspaceRow = workspaceRows.get(category);
        const workspaceRung = workspaceRow ? capToCeiling(workspaceRow.rung, ceiling) : null;

        let rung: TrustRung = workspaceRung ?? defaultRung;
        let decidedBy: LadderDecidedBy = workspaceRow ? 'workspace' : 'default';
        let grantId: string | null = workspaceRow?.id ?? null;

        const agentRow = agentRows.get(category);
        if (agentRow) {
            // Narrow-only: an Agent row that would raise above its Workspace
            // is ignored here as well as refused at write time, so a row that
            // predates a Workspace demotion cannot widen anything.
            const narrowed = minRung(capToCeiling(agentRow.rung, ceiling), rung);
            if (compareRung(narrowed, rung) < 0) {
                rung = narrowed;
                decidedBy = 'agent';
                grantId = agentRow.id;
            }
        }

        return {
            category,
            rung,
            decidedBy,
            ceiling,
            draftable,
            defaultRung,
            workspaceRung: decidedBy === 'agent' ? (workspaceRung ?? defaultRung) : null,
            grantId,
            // An explicit rung is always enforced; an untouched default only
            // once the hold-and-execute half exists. See the constant.
            enforced: decidedBy !== 'default' || SHIPPED_DEFAULT_RUNG_POLICY === 'enforce',
        };
    });

    return { agentId, entries, safeMode: target.safeMode === true };
}

/** A stored rung above its ceiling is read at the ceiling, never above it. */
function capToCeiling(rung: TrustRung, ceiling: TrustRung): TrustRung {
    return minRung(rung, ceiling);
}

/** Look one category up out of a resolved ladder. */
export function ladderEntry(
    ladder: ResolvedLadder,
    category: LadderedActionCategory,
): ResolvedLadderEntry | undefined {
    return ladder.entries.find((entry) => entry.category === category);
}

export interface ValidateRungWriteInput {
    category: LadderedActionCategory;
    /** The rung in force before this write. */
    current: TrustRung;
    /** The rung being asked for. */
    next: TrustRung;
    /**
     * The Workspace rung, when writing at Agent scope. A per-Agent row may
     * only narrow below it (FR-10). Omit when writing at Workspace scope.
     */
    workspaceRung?: TrustRung | null;
}

/**
 * The write rules, in one place, returning the FIRST violation as a
 * human-readable message or `null` when the write is legal — deliberately the
 * same return shape as `validateGuardrails` in `agents/guardrails.ts`, so the
 * two read alike and a caller can treat them identically.
 *
 * Rules, in the order they are checked:
 *   1. The rung must be one this category OFFERS (FR-8): a category with no
 *      reviewable artefact never offers Draft.
 *   2. The rung must not exceed the category's CEILING (FR-11), which nobody
 *      may set — not the owner, not a platform operator, not an API key.
 *   3. At Agent scope, the rung must not exceed the Workspace rung (FR-10).
 *   4. A PROMOTION moves exactly one rung (FR-32). A DEMOTION is
 *      unrestricted, immediate, and needs no readiness and no dwell (FR-33).
 *
 * Whether the caller is a person is NOT checked here and cannot be: it is a
 * property of the request, enforced by the human-actor guard before anything
 * reaches this function (FR-31).
 */
export function validateRungWrite(input: ValidateRungWriteInput): string | null {
    const { category, current, next } = input;
    const ceiling = ACTION_CATEGORY_CEILING[category];
    const draftable = isDraftableCategory(category);
    const offered = offeredRungs(draftable);

    if (!offered.includes(next)) {
        return `"${category}" does not offer the ${next} rung. Available: ${offered.join(', ')}.`;
    }

    if (compareRung(next, ceiling) > 0) {
        if (ceiling === 'off') {
            // FR-12 — money. Not a stricter setting; the absence of a
            // mechanism. Worth its own sentence rather than a generic ceiling
            // message, because the two mean different things.
            return `"${category}" is never something an agent does. Agents do not buy, refund or move money — an agent that needs a purchase raises a decision and a person makes it.`;
        }
        return `"${category}" may never go above ${ceiling}. This is not a setting — it is how the product works.`;
    }

    const workspaceRung = input.workspaceRung ?? null;
    if (workspaceRung !== null && compareRung(next, workspaceRung) > 0) {
        return `An agent may only narrow. The workspace allows ${workspaceRung} for "${category}", so this agent cannot be set to ${next}.`;
    }

    if (compareRung(next, current) > 0) {
        const allowed = nextRungUp(current, draftable);
        if (allowed !== next) {
            return `One rung at a time. Move "${category}" to ${allowed} first, then to ${next} once you have watched it there.`;
        }
    }

    return null;
}

/** True when the write is a promotion — the half that needs a confirmation. */
export function isPromotion(current: TrustRung, next: TrustRung): boolean {
    return compareRung(next, current) > 0;
}
