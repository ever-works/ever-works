import { Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import {
    parseFleetSessionAttention,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import { AgentRepository } from '../../database/repositories/agent.repository';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look/needs-a-look.producer';
import { NeedsALookService } from '../needs-a-look/needs-a-look.service';
import { FleetSessionRepository } from './fleet-session.repository';

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
};

/** Sessions that ended without a result in this window raise one row per computer. */
const UNCONFIRMED_WINDOW_MS = 60 * 60_000;

/**
 * Session attention (FL-05 P2, CONTRACTS §4.6, R-23, spec FR-32, §5.7) — the
 * hub's "needs a look" rows for sessions:
 *
 *  - `session-needs-you` (`warn`) — one per session waiting for THIS person
 *    (they started it, or own the Agent): "Nina (Agent) waiting for you on
 *    build-01 · "Allow Bash(pnpm db:migrate)?"", action **Answer** (the session
 *    page). The prompt is the owner's: it shows only to the computer's owner,
 *    others read the sentence without it (FL-01's producer rule);
 *  - `session-unconfirmed` (`info`) — one per computer whose sessions ended
 *    without a result in the last hour (it restarted): "build-01 restarted —
 *    2 sessions ended without a result", action **Open**.
 *
 * Read from `fleet_sessions` on every request (computed, CONTRACTS §4.6): the
 * row clears the moment the attention does. Registered into FL-01's registry
 * at module init. Never throws for one bad row.
 */
@Injectable()
export class SessionNeedsYouProducer implements NeedsALookProducer, OnModuleInit {
    readonly id = 'fl-05.session-needs-you';
    private readonly logger = new Logger(SessionNeedsYouProducer.name);

    constructor(
        private readonly sessions: FleetSessionRepository,
        @Optional() private readonly registry?: NeedsALookService,
        @Optional() private readonly agents?: AgentRepository,
    ) {}

    onModuleInit(): void {
        this.registry?.register(this);
    }

    async produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): Promise<NeedsALookItem[]> {
        if (nodes.length === 0) return [];
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const items: NeedsALookItem[] = [];
        const agentNames = new Map<string, string>();

        for (const row of await this.sessions.findNeedsYouForNodes([...byId.keys()])) {
            if (row.userId !== context.userId) continue;
            const node = byId.get(row.nodeId);
            if (!node) continue;
            try {
                const attention = row.attention ? parseFleetSessionAttention(row.attention) : null;
                let who = PROVIDER_NAMES[row.provider] ?? 'A session';
                if (row.kind === 'agent' && row.agentId && this.agents) {
                    let name = agentNames.get(row.agentId);
                    if (name === undefined) {
                        name = (await this.agents.findById(row.agentId))?.name ?? '';
                        agentNames.set(row.agentId, name);
                    }
                    if (name) who = `${name} (Agent)`;
                }
                const ownerView = node.viewerRole === undefined || node.viewerRole === 'owner';
                const prompt = ownerView && attention?.prompt ? ` · "${attention.prompt}"` : '';
                items.push({
                    id: `session-needs-you:${row.id}`,
                    nodeId: row.nodeId,
                    severity: 'warn',
                    kind: 'session-needs-you',
                    title: `${who} waiting for you on ${node.name}${prompt}`,
                    detail: row.title,
                    action: { label: 'Answer', route: `/fleet/sessions/${encodeURIComponent(row.id)}` },
                    since: attention?.raisedAt ?? new Date(row.stateChangedAt ?? row.updatedAt ?? context.now).toISOString(),
                });
            } catch (error) {
                this.logger.debug(
                    `session ${row.id}: no needs-a-look row: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        const since = new Date(context.now.getTime() - UNCONFIRMED_WINDOW_MS);
        const ended = await this.sessions.findUnconfirmedEndedSince([...byId.keys()], since);
        const perNode = new Map<string, { count: number; first: Date }>();
        for (const row of ended) {
            if (row.endedReason !== 'node-restart') continue;
            const at = row.endedAt instanceof Date ? row.endedAt : new Date(row.endedAt ?? context.now);
            const entry = perNode.get(row.nodeId) ?? { count: 0, first: at };
            entry.count += 1;
            if (at < entry.first) entry.first = at;
            perNode.set(row.nodeId, entry);
        }
        for (const [nodeId, entry] of perNode) {
            const node = byId.get(nodeId);
            if (!node) continue;
            items.push({
                id: `session-unconfirmed:${nodeId}`,
                nodeId,
                severity: 'info',
                kind: 'session-unconfirmed',
                title: `${node.name} restarted — ${entry.count} ${entry.count === 1 ? 'session' : 'sessions'} ended without a result`,
                detail: 'Their last screens are kept on the computer’s Sessions tab.',
                action: { label: 'Open', route: `/fleet/computers/${encodeURIComponent(nodeId)}?tab=sessions` },
                since: entry.first.toISOString(),
            });
        }
        return items;
    }
}
