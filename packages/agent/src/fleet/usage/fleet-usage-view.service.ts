import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
    FLEET_USAGE_PAYER_NOTE,
    FLEET_USAGE_ZERO_TOKENS,
    fleetUsageOptInHint,
    isFleetUsagePeriodDays,
    type FleetUsageAgentLine,
    type FleetUsageCheckoutLine,
    type FleetUsageModelLine,
    type FleetUsageNodeLine,
    type FleetUsagePeriodDays,
    type FleetUsagePricesView,
    type FleetUsageProvider,
    type FleetUsageScanState,
    type FleetUsageView,
    type FleetViewerRole,
} from '@ever-works/contracts';
import { Agent } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { FleetCheckout } from '../../entities/fleet-checkout.entity';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FleetSession } from '../../entities/fleet-session.entity';
import { FleetUsageSample } from '../../entities/fleet-usage-sample.entity';
import { MODEL_LIST_PRICES, type ModelListPrices } from '../../usage/model-list-prices';
import { FleetAccessService, type FleetCaller } from '../fleet-access.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import { fleetUsageError } from './fleet-usage.errors';
import { bigintCount, priceUsageGroups, type UsageGroup } from './fleet-usage.math';
import { FleetUsageScanService, type FleetUsageScanFacts } from './fleet-usage-scan.service';

/** One grouped row of `fleet_usage_samples` for the period. */
interface GroupedRow extends UsageGroup {
    nodeId: string;
    fleetSessionId: string | null;
    agentRunId: string | null;
    checkoutPath: string | null;
    providerSessionId: string | null;
}

export interface FleetUsageQuery {
    days?: unknown;
    nodeId?: string | null;
    model?: string | null;
}

/** Busiest checkouts shown (the tab's line, spec §0). */
const MAX_CHECKOUT_LINES = 6;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Usage & cost on the fleet (FL-20, plan §5, T-15, T-24) — the ONE object the
 * hub's Usage tab, the computer page line, `fleet_usage_get` and
 * `ever-works fleet usage --json` all render (spec S6, FR-19).
 *
 * Scope and honesty rules:
 *
 *  - computers: the caller's own plus those shared with them whose `view`
 *    audience admits them (FR-17); with `nodeId`, exactly that one (existence
 *    and audience through `FleetAccessService`, so a foreign computer reads
 *    `not_found`) — `consent_missing` with the opt-in command when its owner
 *    has not switched the scan on, `unsupported_on_node` when its node predates
 *    the consent (FR-18, U1, U3);
 *  - a computer with the scan off stays in `byNode` with the opt-in hint and no
 *    numbers; an offline one keeps its numbers and its last-scan age (FR-13);
 *  - **other** sessions (not started from Ever Works) are the machine owner's
 *    alone by default (spec §8b): on a computer the caller does not own they
 *    are left out of every figure and `excluded.otherHidden` says so;
 *  - dollars are list price over PRICED models only, from summed tokens per
 *    (model, version), rounded once; unknown models are tokens only and
 *    counted in `unknownModels` (FR-8, S5); `note` is the payer sentence.
 */
@Injectable()
export class FleetUsageViewService {
    constructor(
        @InjectRepository(FleetUsageSample)
        private readonly samples: Repository<FleetUsageSample>,
        @InjectRepository(FleetSession)
        private readonly sessions: Repository<FleetSession>,
        @InjectRepository(AgentRun)
        private readonly runs: Repository<AgentRun>,
        @InjectRepository(Agent)
        private readonly agents: Repository<Agent>,
        @InjectRepository(FleetCheckout)
        private readonly checkouts: Repository<FleetCheckout>,
        private readonly nodes: FleetNodeRepository,
        private readonly access: FleetAccessService,
        private readonly scans: FleetUsageScanService,
        @Inject(MODEL_LIST_PRICES) private readonly prices: ModelListPrices,
    ) {}

    async view(caller: FleetCaller, query: FleetUsageQuery = {}, now: Date = new Date()): Promise<FleetUsageView> {
        const days = parseDays(query.days);
        const model = typeof query.model === 'string' && query.model.trim() ? query.model.trim().slice(0, 120) : null;
        const scope = await this.scope(caller, query.nodeId ?? null);
        const to = now;
        const from = new Date(now.getTime() - days * DAY_MS);

        const reporting = scope.filter((entry) => fleetUsageScanState(entry.node).state === 'on');
        const rows = await this.grouped(
            reporting.map((entry) => entry.node.id),
            from,
            model,
        );
        const owned = new Set(scope.filter((entry) => entry.role === 'owner').map((entry) => entry.node.id));
        // Other sessions are the machine owner's alone (spec §8b).
        const visible = rows.filter((row) => owned.has(row.nodeId) || row.fleetSessionId || row.agentRunId);
        const otherHidden = visible.length !== rows.length;

        const priced = priceUsageGroups(visible, this.prices);
        const facts = await this.scans.factsFor(scope.map((entry) => entry.node.id));

        const byModel: FleetUsageModelLine[] = priced.byModel.map((line) => ({
            model: line.model,
            provider: line.provider,
            tokens: line.tokens,
            requests: line.requests,
            costCents: line.cents === null ? null : Math.round(line.cents),
        }));

        const byNode: FleetUsageNodeLine[] = scope.map(({ node }) => {
            const scan = fleetUsageScanStateWithFacts(node, facts.get(node.id) ?? null);
            if (scan.state !== 'on') {
                return {
                    nodeId: node.id,
                    name: node.name,
                    scan,
                    costCents: null,
                    tokens: { ...FLEET_USAGE_ZERO_TOKENS },
                    requests: 0,
                };
            }
            const mine = priceUsageGroups(
                visible.filter((row) => row.nodeId === node.id),
                this.prices,
            );
            return {
                nodeId: node.id,
                name: node.name,
                scan,
                costCents: mine.costCents,
                tokens: mine.tokens,
                requests: mine.requests,
            };
        });
        byNode.sort((a, b) => (b.costCents ?? -1) - (a.costCents ?? -1) || a.name.localeCompare(b.name));

        const busiestCheckouts = await this.busiestCheckouts(visible, scope);
        const sessions = await this.sessionsBreakdown(visible, rows, owned);

        let catchingUp: FleetUsageView['catchingUp'] = null;
        for (const line of byNode) {
            const backlog = line.scan.backlogPct;
            if (line.scan.state !== 'on' || backlog === null || backlog <= 0) continue;
            const scannedPct = Math.max(0, Math.min(99, 100 - Math.round(backlog)));
            if (!catchingUp || scannedPct < catchingUp.scannedPct) {
                catchingUp = { nodeId: line.nodeId, nodeName: line.name, scannedPct };
            }
        }

        const current = this.prices.getVersion();
        return {
            days,
            from: from.toISOString(),
            to: to.toISOString(),
            nodeId: query.nodeId ?? null,
            model,
            totals: {
                costCents: priced.costCents,
                tokens: priced.tokens,
                requests: priced.requests,
                topModel: byModel.find((line) => line.costCents !== null)?.model ?? byModel[0]?.model ?? null,
            },
            byModel,
            byNode,
            busiestCheckouts,
            sessions,
            unknownModels: { models: priced.unknownModels, requests: priced.unknownRequests },
            excluded: { nodes: 0, otherHidden },
            catchingUp,
            priceList: {
                version: this.prices.currentVersion,
                effectiveFrom: current?.effectiveFrom ?? '',
                versionsUsed: priced.versionsUsed,
            },
            note: FLEET_USAGE_PAYER_NOTE,
        };
    }

    /** `GET /api/fleet/usage/prices` — the list in effect and its history (read-only). */
    pricesView(): FleetUsagePricesView {
        const current = this.prices.getVersion();
        return {
            version: this.prices.currentVersion,
            effectiveFrom: current?.effectiveFrom ?? '',
            entries: (current?.entries ?? []).map((entry) => ({
                model: entry.model,
                provider: entry.provider,
                perMillionUsd: { ...entry.perMillionUsd },
            })),
            history: this.prices
                .versions()
                .map((version) => ({ version, effectiveFrom: this.prices.getVersion(version)?.effectiveFrom ?? '' })),
            note: FLEET_USAGE_PAYER_NOTE,
        };
    }

    // ─── scope ───────────────────────────────────────────────────────────

    private async scope(
        caller: FleetCaller,
        nodeId: string | null,
    ): Promise<Array<{ node: FleetNode; role: FleetViewerRole }>> {
        if (nodeId) {
            const { node, role } = await this.access.resolveVisible(nodeId, caller);
            const state = fleetUsageScanState(node);
            if (state.state === 'unsupported') {
                throw fleetUsageError('unsupported_on_node', `update the node on ${node.name}`, { nodeId: node.id });
            }
            if (state.state === 'off') {
                throw fleetUsageError('consent_missing', fleetUsageOptInHint(node.name), {
                    nodeId: node.id,
                    consent: 'usageScan',
                });
            }
            return [{ node, role }];
        }
        const userId = typeof caller === 'string' ? caller : caller.userId;
        const own = (await this.nodes.findByUser(userId)).filter((node) => node.status !== 'enrolling');
        const shared = await this.access.listSharedWith(caller);
        return [
            ...own.map((node) => ({ node, role: 'owner' as FleetViewerRole })),
            ...shared.map((entry) => ({ node: entry.node, role: entry.role })),
        ];
    }

    // ─── the grouped read ────────────────────────────────────────────────

    private async grouped(nodeIds: string[], from: Date, model: string | null): Promise<GroupedRow[]> {
        if (nodeIds.length === 0) return [];
        const out: GroupedRow[] = [];
        for (let i = 0; i < nodeIds.length; i += 200) {
            const qb = this.samples
                .createQueryBuilder('s')
                .select('s.nodeId', 'nodeId')
                .addSelect('s.model', 'model')
                .addSelect('s.provider', 'provider')
                .addSelect('s.priceListVersion', 'priceListVersion')
                .addSelect('s.fleetSessionId', 'fleetSessionId')
                .addSelect('s.agentRunId', 'agentRunId')
                .addSelect('s.checkoutPath', 'checkoutPath')
                .addSelect('s.providerSessionId', 'providerSessionId')
                .addSelect('COALESCE(SUM(s.inputTokens), 0)', 'inputTokens')
                .addSelect('COALESCE(SUM(s.outputTokens), 0)', 'outputTokens')
                .addSelect('COALESCE(SUM(s.cacheReadTokens), 0)', 'cacheReadTokens')
                .addSelect('COALESCE(SUM(s.cacheWriteTokens), 0)', 'cacheWriteTokens')
                .addSelect('COALESCE(SUM(s.requests), 0)', 'requests')
                .where('s.nodeId IN (:...ids)', { ids: nodeIds.slice(i, i + 200) })
                .andWhere('s.bucketStart >= :from', { from })
                .groupBy('s.nodeId')
                .addGroupBy('s.model')
                .addGroupBy('s.provider')
                .addGroupBy('s.priceListVersion')
                .addGroupBy('s.fleetSessionId')
                .addGroupBy('s.agentRunId')
                .addGroupBy('s.checkoutPath')
                .addGroupBy('s.providerSessionId');
            if (model) qb.andWhere('s.model = :model', { model });
            const raw = await qb.getRawMany<Record<string, unknown>>();
            for (const row of raw) {
                const version =
                    row.priceListVersion === null || row.priceListVersion === undefined
                        ? null
                        : Number(row.priceListVersion);
                out.push({
                    nodeId: String(row.nodeId),
                    model: String(row.model),
                    provider: row.provider as FleetUsageProvider,
                    priceListVersion: version !== null && Number.isFinite(version) ? version : null,
                    fleetSessionId: (row.fleetSessionId as string | null) ?? null,
                    agentRunId: (row.agentRunId as string | null) ?? null,
                    checkoutPath: (row.checkoutPath as string | null) ?? null,
                    providerSessionId: (row.providerSessionId as string | null) ?? null,
                    tokens: {
                        in: bigintCount(row.inputTokens),
                        out: bigintCount(row.outputTokens),
                        cacheRead: bigintCount(row.cacheReadTokens),
                        cacheWrite: bigintCount(row.cacheWriteTokens),
                    },
                    requests: bigintCount(row.requests),
                });
            }
        }
        return out;
    }

    // ─── blocks ──────────────────────────────────────────────────────────

    private async busiestCheckouts(
        rows: readonly GroupedRow[],
        scope: ReadonlyArray<{ node: FleetNode }>,
    ): Promise<FleetUsageCheckoutLine[]> {
        const names = new Map(scope.map((entry) => [entry.node.id, entry.node.name]));
        const byPath = new Map<string, GroupedRow[]>();
        for (const row of rows) {
            const key = `${row.nodeId}\u0000${row.checkoutPath ?? ''}`;
            byPath.set(key, [...(byPath.get(key) ?? []), row]);
        }
        const lines: FleetUsageCheckoutLine[] = [];
        for (const group of byPath.values()) {
            const first = group[0];
            const priced = priceUsageGroups(group, this.prices);
            lines.push({
                nodeId: first.nodeId,
                nodeName: names.get(first.nodeId) ?? first.nodeId,
                path: first.checkoutPath,
                checkoutId: null,
                costCents: priced.costCents,
                tokens: priced.tokens,
            });
        }
        lines.sort(
            (a, b) =>
                (b.costCents ?? -1) - (a.costCents ?? -1) ||
                b.tokens.in + b.tokens.out - (a.tokens.in + a.tokens.out),
        );
        const top = lines.slice(0, MAX_CHECKOUT_LINES);
        const paths = top.filter((line) => line.path).map((line) => line.path as string);
        if (paths.length > 0) {
            const known = await this.checkouts.find({
                where: { nodeId: In([...new Set(top.map((line) => line.nodeId))]), path: In(paths) },
                select: { id: true, nodeId: true, path: true },
            });
            for (const line of top) {
                const hit = known.find((checkout) => checkout.nodeId === line.nodeId && checkout.path === line.path);
                if (hit) line.checkoutId = hit.id;
            }
        }
        return top;
    }

    private async sessionsBreakdown(
        visible: readonly GroupedRow[],
        all: readonly GroupedRow[],
        owned: ReadonlySet<string>,
    ): Promise<FleetUsageView['sessions']> {
        const sessionIds = [...new Set(visible.map((row) => row.fleetSessionId).filter((id): id is string => !!id))];
        const runIds = [...new Set(visible.map((row) => row.agentRunId).filter((id): id is string => !!id))];
        const sessionRows = sessionIds.length
            ? await this.sessions.find({
                  where: { id: In(sessionIds) },
                  select: { id: true, kind: true, agentId: true },
              })
            : [];
        const runRows = runIds.length
            ? await this.runs.find({ where: { id: In(runIds) }, select: { id: true, agentId: true } })
            : [];
        const sessionById = new Map(sessionRows.map((session) => [session.id, session]));
        const runById = new Map(runRows.map((run) => [run.id, run]));

        const agentGroups = new Map<string, { units: Set<string>; rows: GroupedRow[] }>();
        const ownerGroup = { units: new Set<string>(), rows: [] as GroupedRow[] };
        for (const row of visible) {
            if (row.fleetSessionId) {
                const session = sessionById.get(row.fleetSessionId);
                if (session?.kind === 'agent' && session.agentId) {
                    const group = agentGroups.get(session.agentId) ?? { units: new Set<string>(), rows: [] };
                    group.units.add(`s:${row.fleetSessionId}`);
                    group.rows.push(row);
                    agentGroups.set(session.agentId, group);
                } else {
                    ownerGroup.units.add(row.fleetSessionId);
                    ownerGroup.rows.push(row);
                }
            } else if (row.agentRunId) {
                const agentId = runById.get(row.agentRunId)?.agentId;
                if (!agentId) continue;
                const group = agentGroups.get(agentId) ?? { units: new Set<string>(), rows: [] };
                group.units.add(`r:${row.agentRunId}`);
                group.rows.push(row);
                agentGroups.set(agentId, group);
            }
        }
        const agentIds = [...agentGroups.keys()];
        const names = agentIds.length
            ? await this.agents.find({ where: { id: In(agentIds) }, select: { id: true, name: true } })
            : [];
        const nameById = new Map(names.map((agent) => [agent.id, agent.name]));
        const agents: FleetUsageAgentLine[] = agentIds
            .map((agentId) => {
                const group = agentGroups.get(agentId)!;
                return {
                    agentId,
                    name: nameById.get(agentId) ?? null,
                    sessions: group.units.size,
                    costCents: priceUsageGroups(group.rows, this.prices).costCents,
                };
            })
            .sort((a, b) => (b.costCents ?? -1) - (a.costCents ?? -1) || b.sessions - a.sessions);

        // Other: unattributed rows on computers the caller owns, counted by provider session.
        const otherRows = all.filter((row) => !row.fleetSessionId && !row.agentRunId && owned.has(row.nodeId));
        const otherSessions = new Set(otherRows.map((row) => `${row.nodeId}:${row.providerSessionId ?? '?'}`));
        // Null when the caller owns none of these computers: they may see no other sessions at all.
        const other =
            owned.size === 0
                ? null
                : { sessions: otherSessions.size, costCents: priceUsageGroups(otherRows, this.prices).costCents };
        return {
            agents,
            owner: { sessions: ownerGroup.units.size, costCents: priceUsageGroups(ownerGroup.rows, this.prices).costCents },
            other,
        };
    }
}

function parseDays(value: unknown): FleetUsagePeriodDays {
    if (value === undefined || value === null || value === '') return 7;
    const n = typeof value === 'string' ? Number(value) : value;
    if (!isFleetUsagePeriodDays(n)) {
        throw fleetUsageError('invalid', 'days must be one of 1, 7, 30 or 90', { field: 'days' });
    }
    return n;
}

/** The consent as the node last reported it (no job facts). */
export function fleetUsageScanState(node: Pick<FleetNode, 'name' | 'consents'>): Pick<FleetUsageScanState, 'state' | 'hint'> {
    if (!node.consents) return { state: 'unsupported', hint: `update the node on ${node.name}` };
    if (node.consents.usageScan !== true) return { state: 'off', hint: fleetUsageOptInHint(node.name) };
    return { state: 'on', hint: null };
}

export function fleetUsageScanStateWithFacts(
    node: Pick<FleetNode, 'name' | 'consents' | 'status'>,
    facts: FleetUsageScanFacts | null,
): FleetUsageScanState {
    const base = fleetUsageScanState(node);
    return {
        state: base.state,
        hint: base.hint,
        online: node.status === 'online',
        lastScanAt: facts?.lastScanAt ? new Date(facts.lastScanAt).toISOString() : null,
        backlogPct: facts?.backlogPct ?? null,
    };
}
