import {
    SKILL_READINESS_REQUIREMENTS_MAX,
    type SkillReadinessDetail,
    type SkillReadinessState,
    type SkillRequirement,
    type SkillRequirementStatus,
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
 *   needs_setup → missing_requirements → blocked_by_access → unknown → ready
 *
 * The one rule that is never relaxed: a check that FAILED can only ever make
 * the verdict `unknown` — never `ready`, and never a false "missing".
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

    if (findings.bindingsFailed) return { readiness: 'unknown', detail };

    const unmuted = findings.boundTargetCount - findings.mutedBindingCount;
    if (findings.boundTargetCount === 0 || unmuted <= 0) {
        return { readiness: 'needs_setup', detail };
    }
    if (findings.requirements.some((row) => row.status === 'missing')) {
        return { readiness: 'missing_requirements', detail };
    }
    if (findings.blockedForEveryAgent) {
        return { readiness: 'blocked_by_access', detail };
    }
    if (findings.requirements.some((row) => row.status === 'unknown')) {
        return { readiness: 'unknown', detail };
    }
    return { readiness: 'ready', detail };
}

/**
 * The stored detail: requirements ordered most-actionable first (missing,
 * then couldn't-check, then refused, then met), capped at 20 rows with the
 * overflow counted rather than silently dropped.
 */
function buildDetail(findings: SkillReadinessFindings): SkillReadinessDetail {
    const ordered = findings.requirements
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
    return detail;
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
    const detail: SkillReadinessDetail = {
        requirements,
        // The run resolved it, so it reaches at least one target.
        boundTargetCount: Math.max(previous?.boundTargetCount ?? 0, 1),
        mutedBindingCount: previous?.mutedBindingCount ?? 0,
        evaluatedForAgentIds: evaluatedFor.includes(agentId)
            ? evaluatedFor
            : [agentId, ...evaluatedFor].slice(0, 10),
        evaluatedAt: now.toISOString(),
    };
    const readiness: SkillReadinessState =
        current.readiness === 'missing_requirements' ? 'missing_requirements' : 'blocked_by_access';
    return { readiness, detail };
}
