import {
    matchesAnyToolPattern,
    type AgentCapabilityToolRow,
    type AgentStoredToolGrant,
    type ToolGrantChainEntry,
    type ToolGrantSource,
} from '@ever-works/contracts';

/**
 * Capabilities tab — the per-tool switch semantics, as pure functions.
 *
 * Split out of `AgentCapabilitiesClient` because this is the only part of
 * the tab that encodes POLICY rather than layout: the tool-grant matrix
 * narrows downward only, so a switch on the Agent surface can express
 * some outcomes and not others, and getting that wrong ships a control
 * that silently does nothing.
 *
 * The three questions this module answers:
 *
 *  1. Is the switch usable at all? A tool denied by tenant / organization
 *     / Work is NOT re-enableable here — the agent scope may only narrow.
 *     Neither is a tool the ancestors' `allow` list never covered.
 *  2. If it is usable, what does ON / OFF write? The API replaces the
 *     whole agent-scope row on PUT, so every toggle re-sends the full
 *     desired `allow`/`deny` pair.
 *  3. Which blocking reason applies, so the badge can name it.
 *
 * The naive version of (1) — "disabled unless `decision.source ===
 * 'agent'`" — is wrong in a way that stays invisible until an operator
 * uses `allow`: a `tool-not-granted` refusal is attributed by finding the
 * most specific layer whose ALLOW list matches, and by construction none
 * does, so the source degrades to `'default'`. An agent-scope allow list
 * that merely omits a tool would therefore render an unusable switch for
 * a restriction this very page owns. Decide from the per-layer `chain`,
 * never from the collapsed `source`.
 */

/** What the UI should render for one tool's switch. */
export type ToolToggleState =
    /** The tool's permission flag is off — fixed in Settings, not here. */
    | { kind: 'permission-off'; permission: string }
    /** A scope ABOVE the agent blocks it; this page cannot widen. */
    | { kind: 'upstream-denied'; scope: ToolGrantSource }
    /**
     * The agent row denies it through a WILDCARD pattern. Removing the
     * exact name would not help (the pattern still matches) and dropping
     * the pattern would silently re-enable every other tool it covers, so
     * the honest affordance is "Reset to inherited", not a switch.
     */
    | { kind: 'pattern-denied' }
    | { kind: 'editable'; checked: boolean };

const sameName = (pattern: string, toolName: string): boolean =>
    pattern.trim().toLowerCase() === toolName.trim().toLowerCase();

/** Most specific non-agent layer that denies this tool, if any. */
function upstreamDenyScope(
    chain: readonly ToolGrantChainEntry[],
    toolName: string,
): ToolGrantSource | null {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
        const entry = chain[i];
        if (entry.scope === 'agent') continue;
        if (matchesAnyToolPattern(entry.deny, toolName)) return entry.scope;
    }
    return null;
}

export function toolToggleState(
    tool: AgentCapabilityToolRow,
    agentGrantRow: AgentStoredToolGrant | null,
    chain: readonly ToolGrantChainEntry[],
): ToolToggleState {
    if (tool.gatedByPermission && !tool.permissionEnabled) {
        return { kind: 'permission-off', permission: tool.gatedByPermission };
    }

    // An upstream deny outranks anything the agent row says — checked
    // first so a redundant agent-level deny cannot render a switch that
    // appears to fix an outcome it has no power over.
    const upstream = upstreamDenyScope(chain, tool.name);
    if (upstream) return { kind: 'upstream-denied', scope: upstream };

    if (tool.decision.allowed) return { kind: 'editable', checked: true };

    const deny = agentGrantRow?.deny ?? [];
    if (deny.some((pattern) => sameName(pattern, tool.name))) {
        return { kind: 'editable', checked: false };
    }
    if (matchesAnyToolPattern(deny, tool.name)) return { kind: 'pattern-denied' };

    // Refused by an allow list. Repairable here only when the agent row
    // owns that list; otherwise an ancestor never granted it and the
    // narrowing rule forbids widening from this scope.
    const allow = agentGrantRow?.allow;
    if (allow && !matchesAnyToolPattern(allow, tool.name)) {
        return { kind: 'editable', checked: false };
    }

    return { kind: 'upstream-denied', scope: tool.decision.source };
}

/**
 * The full agent-scope grant row to PUT for one toggle.
 *
 * PUT REPLACES the row, so a stored `allow` list is always re-sent —
 * dropping it would silently widen the Agent back to its ancestors'
 * grants. Turning a tool ON when an allow list exists adds the tool to
 * that list: without it, ON would only clear a deny the tool was never
 * on, and the switch would flip straight back on the next render.
 */
export function composeGrantForToggle(
    tool: AgentCapabilityToolRow,
    agentGrantRow: AgentStoredToolGrant | null,
    next: boolean,
): { allow?: string[]; deny: string[] } {
    const currentDeny = agentGrantRow?.deny ?? [];
    const currentAllow = agentGrantRow?.allow ?? null;

    if (!next) {
        const deny = matchesAnyToolPattern(currentDeny, tool.name)
            ? [...currentDeny]
            : [...currentDeny, tool.name];
        if (currentAllow) return { allow: [...currentAllow], deny };
        return { deny };
    }

    const deny = currentDeny.filter((pattern) => !sameName(pattern, tool.name));
    if (!currentAllow) return { deny };
    const allow = matchesAnyToolPattern(currentAllow, tool.name)
        ? [...currentAllow]
        : [...currentAllow, tool.name];
    return { allow, deny };
}
