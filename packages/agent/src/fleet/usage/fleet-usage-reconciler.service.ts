import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
    fleetModelPluginId,
    normalizeFleetUsageReport,
    type FleetUsageProvider,
    type FleetUsageReport,
    type FleetUsageRow,
} from '@ever-works/contracts';
import { config } from '../../config';
import { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import { PluginUsageRepository } from '../../database/repositories/plugin-usage.repository';
import { AgentRun } from '../../entities/agent-run.entity';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetSession } from '../../entities/fleet-session.entity';
import { FleetUsageSample } from '../../entities/fleet-usage-sample.entity';
import { PluginUsageCapability } from '../../entities/plugin-usage-event.entity';
import { FleetJobCompletedEvent } from '../../events/fleet-job.events';
import { MODEL_LIST_PRICES, type ModelListPrices } from '../../usage/model-list-prices';
import { PluginUsageService } from '../../usage/plugin-usage.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import {
    fleetUsageCheckoutPath,
    fleetUsageDedupeKey,
    mergeBucket,
    priceUsageGroups,
    sampleTokens,
    toFleetSessionUsage,
    type PricedUsage,
    type UsageGroup,
} from './fleet-usage.math';

/** Keys per `IN (…)` read — well under every driver's bound-parameter limit. */
const CHUNK = 100;

/** What one ingest did — logged, returned to the specs. */
export interface FleetUsageIngestSummary {
    accepted: boolean;
    rows: number;
    droppedRows: number;
    created: number;
    updated: number;
    unchanged: number;
    sessions: number;
    runs: number;
    other: number;
}

interface KeyedRow {
    row: FleetUsageRow;
    key: string;
    checkoutPath: string | null;
}

type Attribution = { fleetSessionId: string; agentRunId?: undefined } | { agentRunId: string; fleetSessionId?: undefined };

const sessionKey = (provider: string, providerSessionId: string) => `${provider}\u0000${providerSessionId}`;

/**
 * Usage & cost on the fleet (FL-20, plan §10, T-12, T-13, T-23) — turn a
 * node's `usage-scan` report into stored samples, Session usage, Run cost and
 * the Agent's Budget.
 *
 * Per report, in this order:
 *
 *  1. **Read** the result through the contracts normaliser — every string
 *     checked against its allow-list shape; a report over the row cap, or not
 *     a report, is ignored (and its watermark never acknowledged, so the node
 *     re-sends);
 *  2. **attribute** each row (R-13): a `FleetSession` on that node with the
 *     same provider and provider session id; else a Task run of the node's
 *     owner whose `fleetCliSession` names this node and session (resumed runs
 *     share a session id — the newest run that started before the bucket's
 *     last record wins); else **other** (never a Run, never an Agent — FR-6);
 *  3. **merge** into `fleet_usage_samples` by `dedupeKey` with the field-wise
 *     MAXIMUM (rows are cumulative per bucket — never double counts, never
 *     subtracts); a sample stored as other is CLAIMED by a Session or run that
 *     appears later (U7). A sample keeps the price-list version it was first
 *     priced at (U8);
 *  4. **derive** each touched Session's `tokens` / `costCents` from ALL its
 *     samples, priced per (model, version) and rounded once;
 *  5. **settle** each touched Run: a non-debiting `plugin_usage_events` row
 *     (`pluginId: fleet-node:<provider>`, the Agent / Task / Run tags — the
 *     same row a headless fleet run writes) for only the DIFFERENCE between
 *     the scan's figure and what the Run's fleet rows already hold, then the
 *     Run's `costCents` re-stamped as the sum of its rows. So the Agent's
 *     Budget sees the spend (FR-15), a headless run's own CLI-reported row is
 *     never counted twice, and no credit is ever debited (the settlement
 *     treats the `fleet-node:` prefix as bring-your-own);
 *  6. **acknowledge** — `ingestedAt` is stamped on the job's result; the
 *     dispatcher hands the newest acknowledged watermark back as `since`.
 *
 * The scan is read-only on the machine: nothing here writes `fleet_audit`
 * (FR-20). Every step is idempotent; a listener failure is logged, never
 * thrown (an event has no caller to fail).
 */
@Injectable()
export class FleetUsageReconcilerService {
    private readonly logger = new Logger(FleetUsageReconcilerService.name);

    constructor(
        @InjectRepository(FleetUsageSample)
        private readonly samples: Repository<FleetUsageSample>,
        @InjectRepository(FleetSession)
        private readonly sessions: Repository<FleetSession>,
        @InjectRepository(AgentRun)
        private readonly runRows: Repository<AgentRun>,
        @InjectRepository(FleetJob)
        private readonly jobRows: Repository<FleetJob>,
        private readonly nodes: FleetNodeRepository,
        @Inject(MODEL_LIST_PRICES) private readonly prices: ModelListPrices,
        // @Optional() per the positional-construction rule: without them a Run's
        // cost is stamped directly and no ledger row is written.
        @Optional() private readonly runs?: AgentRunRepository,
        @Optional() private readonly pluginUsage?: PluginUsageService,
        @Optional() private readonly usageEvents?: PluginUsageRepository,
    ) {}

    @OnEvent(FleetJobCompletedEvent.EVENT_NAME, { async: true })
    async onCompleted(event: FleetJobCompletedEvent): Promise<void> {
        if (event.job.kind !== 'usage-scan') return;
        if (!event.succeeded || event.source !== 'node-report') return;
        if (!config.fleet.isUsageScanEnabled()) return;
        const nodeId = event.nodeId ?? event.job.nodeId ?? null;
        if (!nodeId) return;
        try {
            const summary = await this.ingest(nodeId, event.result, event.job.id);
            if (summary.accepted && summary.rows > 0) {
                this.logger.log(
                    `usage-scan ${event.job.id} on node ${nodeId}: ${summary.rows} row(s) — ${summary.created} new, ${summary.updated} grown, ${summary.unchanged} unchanged; ${summary.sessions} session(s), ${summary.runs} run(s), ${summary.other} other${
                        summary.droppedRows > 0 ? `; ${summary.droppedRows} refused` : ''
                    }`,
                );
            }
        } catch (error) {
            this.logger.warn(
                `usage-scan ${event.job.id} on node ${nodeId} could not be ingested: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /** Ingest one report for one node. Public for the specs and a manual replay. */
    async ingest(nodeId: string, raw: unknown, jobId?: string | null): Promise<FleetUsageIngestSummary> {
        const summary: FleetUsageIngestSummary = {
            accepted: false,
            rows: 0,
            droppedRows: 0,
            created: 0,
            updated: 0,
            unchanged: 0,
            sessions: 0,
            runs: 0,
            other: 0,
        };
        const node = await this.nodes.findById(nodeId);
        if (!node) return summary;
        const reading = normalizeFleetUsageReport(raw);
        if (!reading) {
            this.logger.warn(`usage-scan report from node ${nodeId} is not a report (or is over the row cap) — ignored`);
            return summary;
        }
        summary.accepted = true;
        summary.droppedRows = reading.droppedRows;
        const rows = this.keyRows(nodeId, reading.report);
        summary.rows = rows.length;

        const attribution = await this.attribute(node.id, node.userId, rows);
        const touchedSessions = new Set<string>();
        const touchedRuns = new Set<string>();

        for (let i = 0; i < rows.length; i += CHUNK) {
            const chunk = rows.slice(i, i + CHUNK);
            const existing = await this.samples.find({ where: { dedupeKey: In(chunk.map((r) => r.key)) } });
            const byKey = new Map(existing.map((sample) => [sample.dedupeKey, sample]));
            for (const keyed of chunk) {
                const owner = attribution.get(keyed.key) ?? null;
                const outcome = await this.upsert(node.id, keyed, owner, byKey.get(keyed.key) ?? null);
                summary[outcome.result] += 1;
                if (outcome.fleetSessionId) touchedSessions.add(outcome.fleetSessionId);
                else if (outcome.agentRunId) touchedRuns.add(outcome.agentRunId);
                else summary.other += 1;
            }
        }

        // U7 — a Session or run that appeared after its first buckets were stored
        // as other claims them now (rows this report did not carry included).
        for (const [, owner] of this.claimable(rows, attribution)) {
            await this.claim(node.id, owner.provider, owner.providerSessionId, owner.attribution);
        }

        for (const sessionId of touchedSessions) {
            await this.deriveSession(sessionId, node.id, jobId ?? null);
        }
        for (const runId of touchedRuns) {
            await this.deriveTaskRun(runId, node.id, jobId ?? null);
        }
        summary.sessions = touchedSessions.size;
        summary.runs = touchedRuns.size;

        if (jobId) await this.acknowledge(jobId, raw);
        return summary;
    }

    // ─── 1. keys ─────────────────────────────────────────────────────────

    private keyRows(nodeId: string, report: FleetUsageReport): KeyedRow[] {
        const byKey = new Map<string, KeyedRow>();
        for (const row of report.rows) {
            const key = fleetUsageDedupeKey({
                nodeId,
                bucketStart: row.bucketStart,
                provider: row.provider,
                model: row.model,
                providerSessionId: row.providerSessionId,
                folderBucket: row.folderBucket,
            });
            const seen = byKey.get(key);
            if (seen) {
                // The same bucket twice in one report: keep the larger reading.
                const merged = mergeBucket(
                    {
                        tokens: seen.row.tokens,
                        requests: seen.row.requests,
                        firstAt: new Date(seen.row.firstAt),
                        lastAt: new Date(seen.row.lastAt),
                    },
                    row,
                );
                seen.row = {
                    ...seen.row,
                    tokens: merged.tokens,
                    requests: merged.requests,
                    firstAt: merged.firstAt.toISOString(),
                    lastAt: merged.lastAt.toISOString(),
                };
                continue;
            }
            byKey.set(key, { row, key, checkoutPath: fleetUsageCheckoutPath(row.folderBucket) });
        }
        return [...byKey.values()];
    }

    // ─── 2. attribution ──────────────────────────────────────────────────

    private async attribute(
        nodeId: string,
        ownerUserId: string,
        rows: readonly KeyedRow[],
    ): Promise<Map<string, Attribution>> {
        const out = new Map<string, Attribution>();
        const ids = [...new Set(rows.map((r) => r.row.providerSessionId).filter((id): id is string => !!id))];
        if (ids.length === 0) return out;

        const sessionsByKey = new Map<string, FleetSession[]>();
        for (let i = 0; i < ids.length; i += CHUNK) {
            const found = await this.sessions.find({
                where: { nodeId, providerSessionId: In(ids.slice(i, i + CHUNK)) },
                select: { id: true, provider: true, providerSessionId: true, createdAt: true, agentRunId: true },
            });
            for (const session of found) {
                if (!session.providerSessionId) continue;
                const key = sessionKey(session.provider, session.providerSessionId);
                sessionsByKey.set(key, [...(sessionsByKey.get(key) ?? []), session]);
            }
        }

        const unmatched = ids.filter(
            (id) =>
                !sessionsByKey.has(sessionKey('claude-code', id)) && !sessionsByKey.has(sessionKey('codex', id)),
        );
        const runsByKey = new Map<string, AgentRun[]>();
        for (let i = 0; i < unmatched.length; i += CHUNK) {
            const found = await this.runRows.find({
                where: { userId: ownerUserId, cliSessionId: In(unmatched.slice(i, i + CHUNK)) },
                select: { id: true, cliSessionId: true, fleetCliSession: true, createdAt: true },
            });
            for (const run of found) {
                const session = run.fleetCliSession;
                if (!session || session.nodeId !== nodeId || session.sessionId !== run.cliSessionId) continue;
                const key = sessionKey(session.provider, session.sessionId);
                runsByKey.set(key, [...(runsByKey.get(key) ?? []), run]);
            }
        }

        for (const keyed of rows) {
            const id = keyed.row.providerSessionId;
            if (!id) continue;
            const key = sessionKey(keyed.row.provider, id);
            const session = newestBefore(sessionsByKey.get(key), keyed.row.lastAt);
            if (session) {
                out.set(keyed.key, { fleetSessionId: session.id });
                continue;
            }
            const run = newestBefore(runsByKey.get(key), keyed.row.lastAt);
            if (run) out.set(keyed.key, { agentRunId: run.id });
        }
        return out;
    }

    /** One claim per (provider, provider session) that this report attributed. */
    private claimable(
        rows: readonly KeyedRow[],
        attribution: Map<string, Attribution>,
    ): Map<string, { provider: FleetUsageProvider; providerSessionId: string; attribution: Attribution }> {
        const out = new Map<
            string,
            { provider: FleetUsageProvider; providerSessionId: string; attribution: Attribution }
        >();
        for (const keyed of rows) {
            const owner = attribution.get(keyed.key);
            const id = keyed.row.providerSessionId;
            if (!owner || !id) continue;
            const key = sessionKey(keyed.row.provider, id);
            if (!out.has(key)) out.set(key, { provider: keyed.row.provider, providerSessionId: id, attribution: owner });
        }
        return out;
    }

    private async claim(
        nodeId: string,
        provider: FleetUsageProvider,
        providerSessionId: string,
        owner: Attribution,
    ): Promise<void> {
        await this.samples.update(
            { nodeId, provider, providerSessionId, fleetSessionId: IsNull(), agentRunId: IsNull() },
            owner.fleetSessionId ? { fleetSessionId: owner.fleetSessionId } : { agentRunId: owner.agentRunId },
        );
    }

    // ─── 3. merge ────────────────────────────────────────────────────────

    private async upsert(
        nodeId: string,
        keyed: KeyedRow,
        owner: Attribution | null,
        stored: FleetUsageSample | null,
    ): Promise<{ result: 'created' | 'updated' | 'unchanged'; fleetSessionId?: string; agentRunId?: string }> {
        const { row } = keyed;
        if (!stored) {
            const priced = this.prices.price(row.tokens, row.model);
            const created = this.samples.create({
                nodeId,
                fleetSessionId: owner?.fleetSessionId ?? null,
                agentRunId: owner?.agentRunId ?? null,
                provider: row.provider,
                providerSessionId: row.providerSessionId,
                model: row.model,
                inputTokens: row.tokens.in,
                outputTokens: row.tokens.out,
                cacheReadTokens: row.tokens.cacheRead,
                cacheWriteTokens: row.tokens.cacheWrite,
                requests: row.requests,
                costCents: priced ? Math.round(priced.cents) : null,
                bucketStart: new Date(row.bucketStart),
                checkoutPath: keyed.checkoutPath,
                priceListVersion: priced ? priced.version : null,
                dedupeKey: keyed.key,
                firstAt: new Date(row.firstAt),
                lastAt: new Date(row.lastAt),
            });
            try {
                await this.samples.save(created);
                return {
                    result: 'created',
                    ...(owner?.fleetSessionId ? { fleetSessionId: owner.fleetSessionId } : {}),
                    ...(owner?.agentRunId ? { agentRunId: owner.agentRunId } : {}),
                };
            } catch (error) {
                // Another writer created the bucket between the read and the
                // insert (the unique `dedupeKey`): merge into theirs instead.
                const raced = await this.samples.findOne({ where: { dedupeKey: keyed.key } });
                if (!raced) throw error;
                return this.upsert(nodeId, keyed, owner, raced);
            }
        }

        const merged = mergeBucket(
            {
                tokens: sampleTokens(stored),
                requests: stored.requests ?? 0,
                firstAt: stored.firstAt ?? null,
                lastAt: stored.lastAt ?? null,
            },
            row,
        );
        const patch: Partial<FleetUsageSample> = {};
        if (merged.changed) {
            patch.inputTokens = merged.tokens.in;
            patch.outputTokens = merged.tokens.out;
            patch.cacheReadTokens = merged.tokens.cacheRead;
            patch.cacheWriteTokens = merged.tokens.cacheWrite;
            patch.requests = merged.requests;
            patch.firstAt = merged.firstAt;
            patch.lastAt = merged.lastAt;
            // Re-priced at the version the sample already carries (U8); one
            // never priced is priced at the current version now.
            const priced = this.prices.price(merged.tokens, stored.model, stored.priceListVersion ?? undefined);
            patch.costCents = priced ? Math.round(priced.cents) : null;
            if (priced && stored.priceListVersion == null) patch.priceListVersion = priced.version;
        }
        let fleetSessionId = stored.fleetSessionId ?? undefined;
        let agentRunId = stored.agentRunId ?? undefined;
        if (!fleetSessionId && !agentRunId && owner) {
            // U7 — the late claim of a bucket first stored as other.
            if (owner.fleetSessionId) patch.fleetSessionId = fleetSessionId = owner.fleetSessionId;
            else patch.agentRunId = agentRunId = owner.agentRunId;
        }
        if (Object.keys(patch).length === 0) {
            return { result: 'unchanged', fleetSessionId, agentRunId };
        }
        await this.samples.update(stored.id, patch);
        return { result: 'updated', fleetSessionId, agentRunId };
    }

    // ─── 4. Sessions ─────────────────────────────────────────────────────

    /** The priced usage of every sample matching `where` (one Session's or one run's). */
    async pricedFor(where: { fleetSessionId: string } | { agentRunId: string }): Promise<PricedUsage> {
        const rows = await this.samples.find({ where });
        return priceUsageGroups(groupFleetUsageSamples(rows), this.prices);
    }

    private async deriveSession(sessionId: string, nodeId: string, jobId: string | null): Promise<void> {
        const session = await this.sessions.findOne({ where: { id: sessionId } });
        if (!session) return;
        const priced = await this.pricedFor({ fleetSessionId: sessionId });
        await this.sessions.update(sessionId, {
            tokens: toFleetSessionUsage(priced, new Date()),
            costCents: priced.costCents,
        });
        if (session.agentRunId && (session.provider === 'claude-code' || session.provider === 'codex')) {
            await this.settleRun(session.agentRunId, session.provider, priced, nodeId, jobId);
        }
    }

    private async deriveTaskRun(runId: string, nodeId: string, jobId: string | null): Promise<void> {
        const run = await this.runRows.findOne({ where: { id: runId }, select: { id: true, fleetCliSession: true } });
        const provider = run?.fleetCliSession?.provider;
        if (!run || (provider !== 'claude-code' && provider !== 'codex')) return;
        const priced = await this.pricedFor({ agentRunId: runId });
        await this.settleRun(runId, provider, priced, nodeId, jobId);
    }

    // ─── 5. Runs and Budgets ─────────────────────────────────────────────

    /**
     * Top the Run's non-debiting fleet ledger row up to the scan's figure (only
     * the difference — a headless run's own CLI-reported row already counts),
     * then re-stamp the Run's `costCents` as the sum of its rows, exactly what
     * the run-cost settlement stamps at a terminal transition.
     */
    private async settleRun(
        runId: string,
        provider: FleetUsageProvider,
        priced: PricedUsage,
        nodeId: string,
        jobId: string | null,
    ): Promise<void> {
        if (priced.costCents === null) return;
        const run = await this.runRows.findOne({ where: { id: runId } });
        if (!run) return;
        const pluginId = fleetModelPluginId(provider);
        try {
            if (this.pluginUsage && this.usageEvents) {
                const byPlugin = await this.usageEvents.getRunCostByPlugin(runId);
                const already = byPlugin.find((line) => line.pluginId === pluginId)?.costCents ?? 0;
                const delta = priced.costCents - already;
                if (delta >= 1) {
                    const recorded = await this.pluginUsage.record({
                        workId: run.workId ?? undefined,
                        userId: run.userId,
                        pluginId,
                        capability: PluginUsageCapability.AI,
                        units: 1,
                        costCents: delta,
                        modelId: priced.byModel[0]?.model ?? null,
                        requestId: jobId ? `usage-scan:${jobId}` : null,
                        metadata: {
                            source: 'fleet-usage-scan',
                            provider,
                            nodeId,
                            fleetJobId: jobId,
                            listPrice: true,
                            priceListVersions: priced.versionsUsed,
                            inputTokens: priced.tokens.in,
                            outputTokens: priced.tokens.out,
                            cacheReadTokens: priced.tokens.cacheRead,
                            cacheCreationTokens: priced.tokens.cacheWrite,
                            requests: priced.requests,
                        },
                        agentId: run.agentId,
                        taskId: run.taskId ?? null,
                        runId,
                    });
                    if (!recorded) {
                        await this.stampDirect(run, priced.costCents);
                        return;
                    }
                }
                const total = (await this.usageEvents.getRunCostByPlugin(runId)).reduce(
                    (sum, line) => sum + line.costCents,
                    0,
                );
                if (total !== run.costCents) await this.stampRun(runId, total);
                return;
            }
            await this.stampDirect(run, priced.costCents);
        } catch (error) {
            this.logger.warn(
                `Run ${runId}: fleet usage could not be settled: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /** No ledger bound (or the row had no scope anchor): the Run's cost never falls below the scan's. */
    private async stampDirect(run: AgentRun, cents: number): Promise<void> {
        const next = Math.max(run.costCents ?? 0, cents);
        if (next !== run.costCents) await this.stampRun(run.id, next);
    }

    private async stampRun(runId: string, costCents: number): Promise<void> {
        if (this.runs) await this.runs.stampCostCents(runId, costCents);
        else await this.runRows.update(runId, { costCents });
    }

    // ─── 6. acknowledgement ──────────────────────────────────────────────

    private async acknowledge(jobId: string, raw: unknown): Promise<void> {
        const result = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        await this.jobRows.update(jobId, { result: { ...result, ingestedAt: new Date().toISOString() } });
    }
}

/** The newest candidate created at or before `at` (else the oldest one). */
function newestBefore<T extends { createdAt: Date }>(candidates: T[] | undefined, at: string): T | null {
    if (!candidates || candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const limit = Date.parse(at);
    let best: T | null = null;
    for (const candidate of sorted) {
        if (new Date(candidate.createdAt).getTime() <= limit) best = candidate;
    }
    return best ?? sorted[0];
}

/** Stored samples summed per (model, price-list version). */
export function groupFleetUsageSamples(rows: readonly FleetUsageSample[]): UsageGroup[] {
    const groups = new Map<string, UsageGroup>();
    for (const row of rows) {
        const key = `${row.model}\u0000${row.priceListVersion ?? ''}`;
        const tokens = sampleTokens(row);
        const group = groups.get(key);
        if (!group) {
            groups.set(key, {
                model: row.model,
                provider: row.provider,
                priceListVersion: row.priceListVersion ?? null,
                tokens,
                requests: row.requests ?? 0,
                firstAt: row.firstAt ?? null,
                lastAt: row.lastAt ?? null,
            });
            continue;
        }
        group.tokens = {
            in: group.tokens.in + tokens.in,
            out: group.tokens.out + tokens.out,
            cacheRead: group.tokens.cacheRead + tokens.cacheRead,
            cacheWrite: group.tokens.cacheWrite + tokens.cacheWrite,
        };
        group.requests += row.requests ?? 0;
        if (row.firstAt && (!group.firstAt || row.firstAt < group.firstAt)) group.firstAt = row.firstAt;
        if (row.lastAt && (!group.lastAt || row.lastAt > group.lastAt)) group.lastAt = row.lastAt;
    }
    return [...groups.values()];
}
