import {
    parseFleetGitLine,
    parseFleetRemote,
    type FleetSessionGitRef,
    parseFleetSessionAttention,
    parseFleetSessionHooks,
    parseFleetSessionLastEvidence,
    type FleetSessionView,
} from '@ever-works/contracts';
import type { FleetCheckout } from '../../entities/fleet-checkout.entity';
import type { FleetSession } from '../../entities/fleet-session.entity';

const iso = (value: Date | string | null | undefined): string | null => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Sessions on computers (FL-04) — the one mapping from a row to what every
 * surface reads. `lastScreen` only on request (the detail page), never in a
 * list; the daemon's own id, the provider's session id and anything else
 * machine-internal never leave the platform.
 */
export function toFleetSessionView(
    row: FleetSession,
    options: { includeScreen?: boolean } = {},
): FleetSessionView {
    const view: FleetSessionView = {
        id: row.id,
        nodeId: row.nodeId,
        userId: row.userId,
        organizationId: row.organizationId ?? null,
        kind: row.kind,
        provider: row.provider,
        agentId: row.agentId ?? null,
        agentRunId: row.agentRunId ?? null,
        checkoutId: row.checkoutId ?? null,
        cwd: row.cwd,
        title: row.title,
        state: row.state,
        outcome: row.outcome ?? null,
        endedReason: row.endedReason ?? null,
        exitCode: typeof row.exitCode === 'number' ? row.exitCode : null,
        recordingState: row.recordingState ?? 'off',
        restartOfSessionId: row.restartOfSessionId ?? null,
        firstMessage: row.firstMessage ?? null,
        startedBy: row.startedBy,
        lastActivityAt: iso(row.lastActivityAt),
        startedAt: iso(row.startedAt),
        endedAt: iso(row.endedAt),
        createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
        updatedAt: iso(row.updatedAt) ?? iso(row.createdAt) ?? new Date(0).toISOString(),
    };
    // FL-05 (CONTRACTS §4.2): re-read through the shared parsers — a column
    // written by an older node release never reaches a surface half-formed.
    view.attention = row.attention ? parseFleetSessionAttention(row.attention) : null;
    view.stateChangedAt = iso(row.stateChangedAt) ?? iso(row.lastActivityAt) ?? view.createdAt;
    view.hooks = row.hooks ? parseFleetSessionHooks(row.hooks) : null;
    view.lastEvidence = row.lastEvidence ? parseFleetSessionLastEvidence(row.lastEvidence) : null;
    view.boundaryUntil = iso(row.boundaryUntil);
    if (options.includeScreen) view.lastScreen = row.lastScreen ?? null;
    return view;
}

/**
 * Session git & actions (FL-06, spec FR-1, FR-6) — the checkout a session
 * works in, as the session card's `gitLine` / `prPill` slots and the detail
 * header read it. The remote's URL never leaves the platform here — only its
 * `owner/repo`.
 */
export function toFleetSessionGitRef(row: FleetCheckout): FleetSessionGitRef {
    const gitLine = parseFleetGitLine(row.gitLine ?? null);
    const remote = parseFleetRemote(row.remoteUrl ?? null);
    return {
        checkoutId: row.id,
        path: row.path,
        kind: row.kind,
        state: row.state,
        isolation: row.isolation ?? 'host',
        createdBy: row.createdBy,
        repository: remote ? `${remote.owner}/${remote.repo}` : null,
        branch: gitLine?.branch ?? row.branch ?? null,
        gitLine,
    };
}
