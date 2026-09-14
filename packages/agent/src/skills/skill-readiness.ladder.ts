import {
    SKILL_READINESS_AGENTS_MAX,
    SKILL_READINESS_REQUIREMENTS_MAX,
    SKILL_READINESS_RUN_SUPPRESSION_TTL_MS,
    type SkillReadinessDetail,
    type SkillReadinessState,
    type SkillRequirement,
    type SkillRequirementStatus,
    type SkillRunSuppression,
} from '@ever-works/contracts';

/**
 * Skills shelf — the PURE half of readiness: given what the checks found,
 * which single verdict does the Skill carry?
 *
 * Kept free of I/O so the precedence ladder can be pinned exhaustively by a
 * table test. `SkillReadinessService` does the reading and hands the
 * findings here.
 *
 * Precedence among stored verdicts (spec FR-22):
 *   needs_setup → missing_requirements → blocked_by_access → check_failed → ready
 *
 * The one rule that is never relaxed: a check that FAILED can only ever make
 * the verdict `check_failed` — never `ready`, and never a false "missing".
 * `unknown` is never produced here: it only ever means "nothing has checked
 * this Skill yet".
 *
 * ## Run-time suppressions and the sweep
 *
 * A run that drops a Skill (every declared tool refused for its agent) is
 * real evidence about THAT agent, recorded by {@link withRunSuppression}. A
 * later check keeps it unless the check actually evaluated that agent's
 * grants and found the Skill usable there ({@link carryRunSuppressions}).
 * Both paths then apply the same rule — a suppression in force means
 * `blocked_by_access`, naming the agents in `blockedForAgentIds` — so the
 * badge does not flip between a run and the next sweep.
 */
export interface SkillReadinessFindings {
    /** The binding lookup itself threw — nothing else can be trusted. */
    bindingsFailed: boolean;
    boundTargetCount: number;
    mutedBindingCount: number;
    /** Every requirement row found, in any order. */
    requirements: SkillRequirement[];
    /** Every declared tool is refused for every agent the check covered. */
    blockedForEveryAgent: boolean;
    evaluatedForAgentIds: string[];
    evaluatedAt: Date;
    /** The evaluated agents for which every declared tool is refused. */
    blockedForAgentIds?: string[];
    /** Run-time suppressions still in force, already passed through {@link carryRunSuppressions}. */
    runSuppressions?: SkillRunSuppression[];
}

const STATUS_ORDER: Record<SkillRequirementStatus, number> = {
    missing: 0,
    unknown: 1,
    refused: 2,
    met: 3,
};

export function decideSkillReadiness(findings: SkillReadinessFindings): {
    readiness: SkillReadinessState;
    detail: SkillReadinessDetail;
} {
    const detail = buildDetail(findings);

    if (findings.bindingsFailed) return { readiness: 'check_failed', detail };

    const unmuted = findings.boundTargetCount - findings.mutedBindingCount;
    if (findings.boundTargetCount === 0 || unmuted <= 0) {
        return { readiness: 'needs_setup', detail };
    }
    if (findings.requirements.some((row) => row.status === 'missing')) {
        return { readiness: 'missing_requirements', detail };
    }
    if (findings.blockedForEveryAgent || (findings.runSuppressions?.length ?? 0) > 0) {
        return { readiness: 'blocked_by_access', detail };
    }
    if (findings.requirements.some((row) => row.status === 'unknown')) {
        return { readiness: 'check_failed', detail };
    }
    return { readiness: 'ready', detail };
}

/**
 * The stored detail: requirements ordered most-actionable first (missing,
 * then couldn't-check, then refused, then met), capped at 20 rows with the
 * overflow counted rather than silently dropped.
 */
function buildDetail(findings: SkillReadinessFindings): SkillReadinessDetail {
    const suppressions = findings.runSuppressions ?? [];
    const ordered = withSuppressedToolRows(findings.requirements, suppressions)
        .map((row, index) => ({ row, index }))
        .sort(
            (a, b) => STATUS_ORDER[a.row.status] - STATUS_ORDER[b.row.status] || a.index - b.index,
        )
        .map(({ row }) => row);
    const requirements = ordered.slice(0, SKILL_READINESS_REQUIREMENTS_MAX);
    const detail: SkillReadinessDetail = {
        requirements,
        boundTargetCount: findings.boundTargetCount,
        mutedBindingCount: findings.mutedBindingCount,
        evaluatedForAgentIds: findings.evaluatedForAgentIds,
        evaluatedAt: findings.evaluatedAt.toISOString(),
    };
    if (ordered.length > requirements.length) {
        detail.truncated = true;
        detail.truncatedCount = ordered.length - requirements.length;
    }
    const blockedFor = uniqueAgentIds([
        ...(findings.blockedForAgentIds ?? []),
        ...suppressions.map((entry) => entry.agentId),
    ]);
    if (blockedFor.length > 0) detail.blockedForAgentIds = blockedFor;
    if (suppressions.length > 0) detail.runSuppressions = suppressions;
    return detail;
}

/**
 * A suppression in force names its refused tools against its agent: a tool
 * row the check left `met` (allowed for some other agent) reads `refused`
 * with that agent's access link, so the requirements agree with the badge.
 */
function withSuppressedToolRows(
    rows: SkillRequirement[],
    suppressions: SkillRunSuppression[],
): SkillRequirement[] {
    if (suppressions.length === 0) return rows;
    return rows.map((row) => {
        if (row.kind !== 'tool' || row.status !== 'met') return row;
        const suppression = suppressions.find((entry) => entry.refusedTools.includes(row.id));
        if (!suppression) return row;
        return {
            kind: 'tool',
            id: row.id,
            status: 'refused',
            reason: 'refusedByGrants',
            fixTarget: { surface: 'access', ref: suppression.agentId },
        };
    });
}

function uniqueAgentIds(ids: string[]): string[] {
    return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))].slice(
        0,
        SKILL_READINESS_AGENTS_MAX,
    );
}

/**
 * Which recorded run-time suppressions a fresh check keeps. Pure.
 *
 *   - The Skill's declared tools are no longer exactly the refused set → the
 *     run judged a definition that has since changed; dropped.
 *   - The check evaluated that agent's grants → kept only when the check also
 *     found every declared tool refused for it; a grant that now allows the
 *     Skill clears it.
 *   - The check did NOT evaluate that agent (outside the agents it reached,
 *     past the agent cap, or no grant matrix could be read) → kept while
 *     younger than {@link SKILL_READINESS_RUN_SUPPRESSION_TTL_MS}.
 *
 * `evaluatedAgentIds: null` means no agent's grants were read at all.
 */
export function carryRunSuppressions(
    previous: readonly SkillRunSuppression[] | null | undefined,
    check: {
        declaredTools: readonly string[];
        evaluatedAgentIds: readonly string[] | null;
        blockedAgentIds: readonly string[];
        now: Date;
    },
): SkillRunSuppression[] {
    if (!Array.isArray(previous) || previous.length === 0) return [];
    const declared = new Set(check.declaredTools);
    const kept: SkillRunSuppression[] = [];
    for (const entry of previous) {
        if (!entry || typeof entry.agentId !== 'string' || !Array.isArray(entry.refusedTools)) {
            continue;
        }
        const refused = declaredToolsOf(entry.refusedTools);
        const sameTools =
            refused.length > 0 &&
            refused.length === declared.size &&
            refused.every((tool) => declared.has(tool));
        if (!sameTools) continue;

        if (check.evaluatedAgentIds?.includes(entry.agentId)) {
            if (check.blockedAgentIds.includes(entry.agentId)) kept.push(entry);
            continue;
        }
        const at = Date.parse(entry.suppressedAt);
        if (
            Number.isFinite(at) &&
            check.now.getTime() - at < SKILL_READINESS_RUN_SUPPRESSION_TTL_MS
        ) {
            kept.push(entry);
        }
    }
    return kept.slice(0, SKILL_READINESS_AGENTS_MAX);
}

/** `mcp__<server>__<tool>` → `<server>`; anything else → null. */
export function mcpServerNameOf(toolName: string): string | null {
    if (!toolName.startsWith('mcp__')) return null;
    const rest = toolName.slice('mcp__'.length);
    const separator = rest.indexOf('__');
    const server = separator === -1 ? rest : rest.slice(0, separator);
    return server.length > 0 ? server : null;
}

/** The declared tool names of a Skill: trimmed, non-empty, deduped, in declaration order. */
export function declaredToolsOf(allowedTools: unknown): string[] {
    if (!Array.isArray(allowedTools)) return [];
    const out: string[] = [];
    for (const entry of allowedTools) {
        if (typeof entry !== 'string') continue;
        const tool = entry.trim();
        if (tool.length === 0 || out.includes(tool)) continue;
        out.push(tool);
    }
    return out;
}

/**
 * A run just dropped this Skill because every tool it declares is refused
 * for the running agent (spec FR-32). Fold that into the cached verdict so a
 * suppression discovered at run time is visible on the shelf immediately.
 *
 * Precedence still holds: a Skill already `missing_requirements` stays so
 * (the higher-priority badge), but the refused tools are recorded either way.
 *
 * The suppression is also recorded against the agent (`runSuppressions`,
 * `blockedForAgentIds`), which is what lets the next sweep keep it instead of
 * undoing it — see {@link carryRunSuppressions}.
 */
export function withRunSuppression(
    current: { readiness?: string | null; readinessDetail?: SkillReadinessDetail | null },
    refusedTools: readonly string[],
    agentId: string,
    now: Date,
): { readiness: SkillReadinessState; detail: SkillReadinessDetail } {
    const previous = current.readinessDetail;
    const refused = declaredToolsOf([...refusedTools]);
    const kept = (previous?.requirements ?? []).filter(
        (row) => !(row.kind === 'tool' && refused.includes(row.id)),
    );
    const refusedRows: SkillRequirement[] = refused.map((tool) => ({
        kind: 'tool',
        id: tool,
        status: 'refused',
        reason: 'refusedByGrants',
        fixTarget: { surface: 'access', ref: agentId },
    }));
    const evaluatedFor = previous?.evaluatedForAgentIds ?? [];
    const requirements = [...refusedRows, ...kept].slice(0, SKILL_READINESS_REQUIREMENTS_MAX);
    const earlierSuppressions = Array.isArray(previous?.runSuppressions)
        ? previous.runSuppressions.filter((entry) => entry?.agentId !== agentId)
        : [];
    const detail: SkillReadinessDetail = {
        requirements,
        // The run resolved it, so it reaches at least one target.
        boundTargetCount: Math.max(previous?.boundTargetCount ?? 0, 1),
        mutedBindingCount: previous?.mutedBindingCount ?? 0,
        evaluatedForAgentIds: evaluatedFor.includes(agentId)
            ? evaluatedFor
            : [agentId, ...evaluatedFor].slice(0, 10),
        evaluatedAt: now.toISOString(),
        blockedForAgentIds: uniqueAgentIds([agentId, ...(previous?.blockedForAgentIds ?? [])]),
        runSuppressions: [
            { agentId, refusedTools: refused, suppressedAt: now.toISOString() },
            ...earlierSuppressions,
        ].slice(0, SKILL_READINESS_AGENTS_MAX),
    };
    const readiness: SkillReadinessState =
        current.readiness === 'missing_requirements' ? 'missing_requirements' : 'blocked_by_access';
    return { readiness, detail };
}
