import { randomBytes } from 'crypto';
import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    FLEET_CLOUD_ACTION_CLASS,
    FLEET_CLOUD_BUSY_SESSION_STATES,
    FLEET_CLOUD_DEFAULT_IDLE_POLICY,
    FLEET_CLOUD_IDLE_MAX_HOURS,
    FLEET_CLOUD_IDLE_MIN_HOURS,
    FLEET_CLOUD_IDLE_REQUESTER,
    FLEET_CLOUD_MAX_PER_OWNER,
    FLEET_CLOUD_OPTIONS_CACHE_MS,
    FLEET_CLOUD_SOFTWARE_IDS,
    FLEET_CLOUD_TAG,
    FLEET_CLOUD_UNENROLLED_AFTER_MIN,
    FLEET_CLOUD_USAGE_FRESH_MS,
    fleetCloudCost,
    fleetCloudCreateSummary,
    fleetCloudIdleHours,
    fleetCloudMonthStartMs,
    fleetCloudDestroySummary,
    fleetCloudNodeTag,
    fleetCloudPowerOffSummary,
    fleetCloudPriceSentence,
    fleetMissingConfirmation,
    formatFleetCloudMoney,
    isFleetCloudIdlePolicyMode,
    isFleetCloudName,
    isFleetCloudPowerAction,
    normalizeFleetCloudSoftware,
    type FleetActionConfirmFields,
    type FleetAuditAction,
    type FleetCloudCreateRequest,
    type FleetCloudCreateResponse,
    type FleetCloudIdlePolicy,
    type FleetCloudUsageRow,
    type FleetCloudListView,
    type FleetCloudMeta,
    type FleetCloudOperationResponse,
    type FleetCloudOptionsView,
    type FleetCloudProviderMonthToDate,
    type FleetCloudProvidersView,
    type FleetCloudSoftwareId,
    type FleetCloudUsageView,
    type FleetConfirmationClass,
    type FleetLinkErrorCode,
    type FleetNodeView,
    type FleetViewerRole,
} from '@ever-works/contracts';
import { isMachineProviderError, type MachineProviderOptions } from '@ever-works/plugin';
import { config } from '../../config';
import type { FleetNode } from '../../entities/fleet-node.entity';
import { NoProviderError, ProviderNotFoundError } from '../../facades/base.facade';
import { MachineProviderFacadeService } from '../../facades/machine-provider.facade';
import { FleetAccessService } from '../fleet-access.service';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetJobService } from '../fleet-job.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { sha256Hex } from '../fleet-node-credential';
import { FleetNodeRepository } from '../fleet-node.repository';
import { FleetService } from '../fleet.service';
import { fleetMachineError, readFleetMachineError } from '../machine/fleet-machine.errors';
import {
    describeFleetMachineCaller,
    fleetMachineCallerUserId,
    type FleetMachineCaller,
} from '../machine/fleet-machine-node.port';
import { FleetSessionRepository } from '../sessions/fleet-session.repository';
import { FleetNodeHealthSampleRepository } from '../fleet-node-health-sample.repository';
import { INBOX_PRODUCER, type InboxProducer } from '../../inbox/inbox-producer.port';
import { evaluateCloudIdle } from './idle-policy';
import { buildCloudBootstrap, FLEET_CLOUD_DEFAULT_RUNTIME_VERSION } from './bootstrap-script';
import {
    appendPowerEvent,
    cloudHasMachine,
    fleetCloudIdlePolicyLabel,
    fleetCloudViewOf,
    normalizeCloudMeta,
} from './fleet-cloud.view';
import { generateThrowawayPublicKey } from './throwaway-key';

/**
 * Cloud computers (FL-17) — the platform half of creating machines at a cloud
 * provider: the provider picker and its options, Create (row first, then the
 * provider), Power on / off, Destroy, and the sweeps that keep each row true
 * to its provider (reconcile, bootstrap watch). Every surface — the web, the
 * Agent tools, MCP and the CLI — calls this; the provider is reached only
 * through {@link MachineProviderFacadeService} and is never named here.
 *
 * An act runs in this order, and the first refusal is the answer (CONTRACTS
 * §2.1 gate order, spec §4.1):
 *
 *  1. **existence** — a caller outside the Node's `view` audience reads
 *     `not_found`;
 *  2. **the kill switch** — read fail-closed; Create and Power on refuse
 *     `kill_switch`, Power off and Destroy proceed (they stop spending — R-36);
 *  3. **the `machines` audience** — `permission_denied` outside it (S10);
 *  4. **the request** — name, provider, region, size, price (`invalid`,
 *     the field named), the limit (`limit_exceeded`), busy (`busy`);
 *  5. **the confirmation** (CONTRACTS §2.2) — `confirmation_required` with the
 *     dialog's summary (the price sentence for Create) until `confirm` /
 *     `confirmName` is sent.
 *
 * Secrets: the provider token lives in the plugin's `x-secret` settings and is
 * read by the facade only; the one-time enrolment token exists in memory
 * between minting and the provider call and is written nowhere but the
 * bootstrap document (FR-8, FR-9); audit rows carry ids and prices, never a
 * token (FR-35). The platform keeps no key for any machine it created.
 */

/** A provider create that has not answered after this long is marked failed by the watch. */
const ASKING_PROVIDER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * P2 — how far back the idle pass reads health samples: two of its 10-minute
 * cadences, so a pass that ran late still sees every sample since the last.
 */
const IDLE_SAMPLE_LOOKBACK_MS = 20 * 60 * 1000;

/** The hint for a disabled / unusable provider plugin (spec U5). */
function pluginDisabledHint(providerName: string): string {
    return `${providerName} plugin is disabled — enable it to power or destroy this computer`;
}

interface CachedOptions {
    at: number;
    value: Omit<FleetCloudOptionsView, 'limits'>;
}

export interface FleetCloudCreateInput extends Partial<FleetCloudCreateRequest> {
    fields?: FleetActionConfirmFields | null;
    /** The Organization the owner is acting in (spec FR-14), when the surface knows it. */
    organizationId?: string | null;
}

@Injectable()
export class FleetCloudService {
    private readonly logger = new Logger(FleetCloudService.name);
    private readonly optionsCache = new Map<string, CachedOptions>();

    constructor(
        private readonly nodes: FleetNodeRepository,
        private readonly fleet: FleetService,
        // Bound by FacadesModule; absent, every provider read answers "no provider".
        @Optional() private readonly machines?: MachineProviderFacadeService,
        @Optional() private readonly access?: FleetAccessService,
        @Optional() private readonly killSwitch?: FleetKillSwitchService,
        @Optional() private readonly audit?: FleetAuditService,
        // Live Runs / Sessions block a destroy (FR-20). Absent, only what is bound is checked.
        @Optional() private readonly jobs?: FleetJobService,
        @Optional() private readonly sessions?: FleetSessionRepository,
        // P2: the idle evaluation reads the health samples and files Inbox notices.
        @Optional() private readonly healthSamples?: FleetNodeHealthSampleRepository,
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
    ) {}

    // ─── Reads ────────────────────────────────────────────────────────────

    /** The providers the caller may create with (spec FR-2): enabled for them, configured or not. */
    async listProviders(caller: FleetMachineCaller): Promise<FleetCloudProvidersView> {
        this.requireEnabled();
        if (!this.machines) return { providers: [] };
        const userId = fleetMachineCallerUserId(caller);
        const summaries = await this.machines.listProviders(userId);
        const providers = [];
        for (const summary of summaries) {
            const cached = this.optionsCache.get(this.cacheKey(summary.pluginId, userId));
            providers.push({
                pluginId: summary.pluginId,
                name: summary.name,
                providerName: summary.providerName,
                configured: summary.configured,
                account: cached && Date.now() - cached.at < FLEET_CLOUD_OPTIONS_CACHE_MS ? cached.value.account.label : null,
                oauthAvailable: summary.oauthAvailable,
            });
        }
        return { providers };
    }

    /**
     * Regions, sizes with the provider's CURRENT list prices, software presets
     * and the connected account (spec FR-3, FR-4) — cached 10 minutes per
     * provider + owner (plan §5). `fresh` skips the cache (Create's price check).
     */
    async options(caller: FleetMachineCaller, pluginId: string, fresh = false): Promise<FleetCloudOptionsView> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const value = await this.readOptions(pluginId, userId, fresh);
        const used = (await this.ownCloudNodes(userId)).length;
        return { ...value, limits: { maxPerOwner: FLEET_CLOUD_MAX_PER_OWNER, used } };
    }

    /** Every cloud computer the caller may see, with the usage block and the providers (`fleet_cloud_list`). */
    async list(caller: FleetMachineCaller): Promise<FleetCloudListView & FleetCloudProvidersView> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const visible = await this.visibleCloudNodes(userId);
        const machines = visible.map(({ node, role }) => this.fleet.viewForRole(node, role));
        const { providers } = await this.listProviders(caller).catch(() => ({ providers: [] }));
        const nowMs = Date.now();
        const usage = usageOf(
            visible.map((entry) => entry.node),
            nowMs,
            await this.destroyedThisMonth(userId, nowMs),
            userId,
        );
        return { machines, usage, providers };
    }

    /** One cloud computer (`GET /api/fleet/cloud/:id`), for anyone in its `view` audience. */
    async get(caller: FleetMachineCaller, nodeId: string): Promise<FleetNodeView> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const { node, role } = await this.resolve(nodeId, userId, 'view');
        this.requireCloud(node);
        return this.fleet.viewForRole(node, role);
    }

    /** The usage block (spec FR-23): every cloud computer the caller owns, or one. */
    async usage(caller: FleetMachineCaller, nodeId?: string | null): Promise<FleetCloudUsageView> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        if (nodeId) {
            const { node } = await this.resolve(nodeId, userId, 'view');
            this.requireCloud(node);
            return usageOf([node], Date.now(), [], node.userId === userId ? userId : null);
        }
        return this.usageSummary(userId);
    }

    /**
     * The owner's Cloud computers usage block (spec FR-22, FR-23, S8) — every
     * cloud computer they own, the ones destroyed this month (from their
     * `node.cloud.destroy` audit rows) and the providers' own month-to-date
     * figures. List-price estimates: never added to model-spend Budgets or the
     * fleet model-cost ceiling (FR-24). FL-20's `GET /api/fleet/usage`
     * composes its `cloud` block from this method (plan §5).
     */
    async usageSummary(userId: string, nowMs: number = Date.now()): Promise<FleetCloudUsageView> {
        return usageOf(await this.ownCloudNodes(userId), nowMs, await this.destroyedThisMonth(userId, nowMs), userId);
    }

    /**
     * Machines destroyed this month still count toward it (spec FR-22): their
     * registration is gone, so their figures come from their `node.cloud.destroy`
     * audit rows (the cost this month at destroy time). Best-effort.
     */
    private async destroyedThisMonth(userId: string, nowMs: number = Date.now()): Promise<FleetCloudUsageRow[]> {
        if (!this.audit || typeof this.audit.forOwnerActionSince !== 'function') return [];
        const since = new Date(fleetCloudMonthStartMs(nowMs));
        const rows = await this.audit.forOwnerActionSince(userId, 'node.cloud.destroy', since).catch(() => []);
        const out: FleetCloudUsageRow[] = [];
        for (const row of rows) {
            const details = (row.details ?? {}) as Record<string, unknown>;
            if (details.outcome !== 'ok' || !row.nodeId) continue;
            const monthToDate = typeof details.monthToDateCents === 'number' ? details.monthToDateCents : 0;
            out.push({
                nodeId: row.nodeId,
                name: typeof details.targetName === 'string' ? details.targetName : row.nodeId,
                providerName: typeof details.providerName === 'string' ? details.providerName : '',
                regionId: typeof details.regionId === 'string' ? details.regionId : '',
                sizeLabel: typeof details.sizeLabel === 'string' ? details.sizeLabel : '',
                hourlyCents: 0,
                monthToDateCents: monthToDate,
                sinceCreatedCents: typeof details.finalCostCents === 'number' ? details.finalCostCents : monthToDate,
                state: 'gone',
                destroyedAt: row.occurredAt,
            });
        }
        return out;
    }

    // ─── Idle policy (P2, spec FR-25 – FR-28) ────────────────────────────

    /** A requested policy, validated (FR-25): `invalid` naming the field, else the policy. */
    private readIdlePolicy(input: Partial<FleetCloudIdlePolicy> | null | undefined): FleetCloudIdlePolicy {
        const mode = input?.mode;
        if (!isFleetCloudIdlePolicyMode(mode)) {
            throw fleetMachineError('invalid', 'mode must be nothing, tell-me or power-off', { field: 'mode' });
        }
        const hours = input?.afterHours;
        if (
            typeof hours !== 'number' ||
            !Number.isInteger(hours) ||
            hours < FLEET_CLOUD_IDLE_MIN_HOURS ||
            hours > FLEET_CLOUD_IDLE_MAX_HOURS
        ) {
            throw fleetMachineError(
                'invalid',
                `afterHours must be a whole number of hours from ${FLEET_CLOUD_IDLE_MIN_HOURS} to ${FLEET_CLOUD_IDLE_MAX_HOURS}`,
                { field: 'afterHours' },
            );
        }
        return { mode, afterHours: hours };
    }

    /**
     * Every gate of an idle-policy change WITHOUT writing it — the Agent tool
     * runs this, then holds the change for the owner's approval with the
     * returned sentence as the Decision text (lane decision 13). Refusals are
     * the same `invalid` / `not_found` / `permission_denied` a write answers.
     */
    async previewIdlePolicy(
        caller: FleetMachineCaller,
        nodeId: string,
        input: Partial<FleetCloudIdlePolicy> | null | undefined,
    ): Promise<{ nodeId: string; name: string; from: FleetCloudIdlePolicy; to: FleetCloudIdlePolicy; summary: string }> {
        this.requireEnabled();
        const to = this.readIdlePolicy(input);
        const { node, meta } = await this.resolveForAct(caller, nodeId, 'node.policy.change', false);
        return {
            nodeId: node.id,
            name: node.name,
            from: meta.idlePolicy,
            to,
            summary: `Change ${node.name}'s idle policy from ${fleetCloudIdlePolicyLabel(meta.idlePolicy)} to ${fleetCloudIdlePolicyLabel(to)}. Ever Works never destroys a cloud computer on its own.`,
        };
    }

    /**
     * Change a cloud computer's idle policy (FR-25): nothing · tell me after N
     * hours · power off after N hours, N 1–72. `machines` audience, `plain`.
     * Audited `node.policy.change` with `{ policy: 'idle', from, to }` (C §7).
     * A change starts the idle window again, so the new policy waits its full
     * hours from now — switching to "power off after 1 h" never powers a machine
     * off the moment it is saved (lane decision 14).
     */
    async setIdlePolicy(
        caller: FleetMachineCaller,
        nodeId: string,
        input: Partial<FleetCloudIdlePolicy> | null | undefined,
    ): Promise<FleetNodeView> {
        this.requireEnabled();
        const to = this.readIdlePolicy(input);
        const { node, meta, role } = await this.resolveForAct(caller, nodeId, 'node.policy.change', false);
        const from = meta.idlePolicy;
        await this.patchMeta(node.id, (fresh) => ({ ...fresh, idlePolicy: to, idleSince: null, idleNotifiedKey: null }));
        await this.record('node.policy.change', fleetMachineCallerUserId(caller), node.userId, node.id, {
            targetName: node.name,
            requestedBy: describeFleetMachineCaller(caller),
            confirmationClass: FLEET_CLOUD_ACTION_CLASS['idle-policy'],
            outcome: 'ok',
            policy: 'idle',
            from,
            to,
        });
        const updated = (await this.nodes.findById(node.id)) ?? node;
        return this.fleet.viewForRole(updated, role);
    }

    /**
     * "Keep running" (spec S6, §5.7): start the idle window again now, so the
     * policy waits its hours again before it tells or powers off. Audited
     * `node.policy.change` (`act: 'keep-running'`). Nothing changes on a
     * machine that is not idle.
     */
    async keepRunning(caller: FleetMachineCaller, nodeId: string): Promise<FleetNodeView> {
        this.requireEnabled();
        const { node, meta, role } = await this.resolveForAct(caller, nodeId, 'node.policy.change', false);
        const now = new Date().toISOString();
        if (meta.idleSince) {
            await this.patchMeta(node.id, (fresh) => (fresh.idleSince ? { ...fresh, idleSince: now } : null));
            await this.record('node.policy.change', fleetMachineCallerUserId(caller), node.userId, node.id, {
                targetName: node.name,
                requestedBy: describeFleetMachineCaller(caller),
                confirmationClass: FLEET_CLOUD_ACTION_CLASS['idle-policy'],
                outcome: 'ok',
                policy: 'idle',
                act: 'keep-running',
                from: meta.idlePolicy,
                to: meta.idlePolicy,
                idleSince: meta.idleSince,
            });
        }
        const updated = (await this.nodes.findById(node.id)) ?? node;
        return this.fleet.viewForRole(updated, role);
    }

    /**
     * The idle sweep (every 10 minutes, offset 5 — plan §10, FR-27). For every
     * cloud computer: judge the evidence (sessions, jobs, the CPU samples since
     * the last pass), keep the window on the row, and — once per window — tell
     * the owner (one Inbox notice; the `cloud-idle` item is computed on read
     * from the window) or power the machine off (`node.cloud.power` with
     * `requestedBy: system:idle-policy`, CONTRACTS §2.3). NEVER destroys
     * anything (FR-28): the only provider call here is a power-off. Best-effort
     * per machine; every write goes onto the freshest row.
     */
    async evaluateIdle(nowMs: number = Date.now()): Promise<{ machines: number; acted: number }> {
        if (!config.fleet.isCloudEnabled()) return { machines: 0, acted: 0 };
        const loads = new Map<string, Record<string, { activeJobCount: number }>>();
        let machines = 0;
        let acted = 0;
        for (const node of await this.nodes.findCloudNodes()) {
            const meta = normalizeCloudMeta(node.providerMeta);
            if (!meta || !cloudHasMachine(node) || meta.powerState === 'gone' || !node.providerPluginId) continue;
            // A "nothing" policy keeps no window; an open one from an earlier policy is closed below.
            if (meta.idlePolicy.mode === 'nothing' && !meta.idleSince) continue;
            machines += 1;
            try {
                if (!loads.has(node.userId)) {
                    const load = this.jobs ? await this.jobs.loadByNodeForUser(node.userId).catch(() => ({})) : {};
                    loads.set(node.userId, load as Record<string, { activeJobCount: number }>);
                }
                const live = this.sessions ? await this.sessions.findLiveForNode(node.id).catch(() => []) : [];
                const busySessions = live.filter((session) =>
                    FLEET_CLOUD_BUSY_SESSION_STATES.includes(String((session as { state?: unknown }).state)),
                ).length;
                // Every earlier sample of an open window was already judged flat (a
                // busy one would have closed it), so only the samples since the last
                // pass are read — two cadences back, never before the window opened.
                const lookback = nowMs - IDLE_SAMPLE_LOOKBACK_MS;
                const opened = meta.idleSince ? Date.parse(meta.idleSince) : NaN;
                const since = new Date(Number.isFinite(opened) ? Math.max(opened, lookback) : lookback);
                const samples = this.healthSamples
                    ? await this.healthSamples.series(node.id, 'raw', since).catch(() => [])
                    : [];
                const latestCpu = (node.health as { cpuPercent?: unknown } | null | undefined)?.cpuPercent;
                const cpuSamples =
                    samples.length > 0
                        ? samples.map((sample) => (typeof sample.cpuPercent === 'number' ? sample.cpuPercent : null))
                        : [typeof latestCpu === 'number' ? latestCpu : null];
                const decision =
                    meta.idlePolicy.mode === 'nothing'
                        ? { idleSince: null, windowReached: false, act: 'none' as const, attentionKey: null }
                        : evaluateCloudIdle({
                              nodeId: node.id,
                              status: node.status,
                              meta,
                              busySessions,
                              activeJobs: loads.get(node.userId)?.[node.id]?.activeJobCount ?? 0,
                              cpuSamples,
                              nowMs,
                          });
                if (decision.act === 'tell-me') {
                    const wrote = await this.patchMeta(node.id, (fresh) =>
                        fresh.idleNotifiedKey === decision.attentionKey
                            ? null
                            : { ...fresh, idleSince: decision.idleSince, idleNotifiedKey: decision.attentionKey },
                    );
                    if (wrote) {
                        await this.notice(node, meta, decision.idleSince, 'idle', nowMs);
                        acted += 1;
                    }
                    continue;
                }
                if (decision.act === 'power-off') {
                    if (await this.powerOffByPolicy(node, decision, nowMs)) acted += 1;
                    continue;
                }
                if (decision.idleSince !== (meta.idleSince ?? null)) {
                    await this.patchMeta(node.id, (fresh) => ({ ...fresh, idleSince: decision.idleSince }));
                }
            } catch (error) {
                this.logger.debug(
                    `idle evaluation skipped ${node.id}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        return { machines, acted };
    }

    /**
     * The idle policy powers a machine off (S7, FR-27): re-read the row and act
     * only if it still runs with nothing pending and this window was not acted
     * on; the provider call is a power-off, never a destroy (FR-28). Allowed
     * while the kill switch is on — it stops spending (R-36). Audited as
     * `node.cloud.power` by `system:idle-policy` (no person acted).
     */
    private async powerOffByPolicy(
        node: FleetNode,
        decision: { idleSince: string | null; attentionKey: string | null },
        nowMs: number,
    ): Promise<boolean> {
        if (!this.machines || !node.providerPluginId || !node.providerMachineRef) return false;
        const fresh = await this.nodes.findById(node.id);
        const meta = fresh ? normalizeCloudMeta(fresh.providerMeta) : null;
        if (!fresh || !meta || meta.powerState !== 'running' || meta.pending !== null) return false;
        if (meta.idleNotifiedKey === decision.attentionKey) return false;
        try {
            await this.machines.power(node.providerPluginId, node.userId, node.providerMachineRef, 'off');
        } catch (error) {
            const hint = await this.providerFailureHint(error, node.providerPluginId, node.userId, meta.providerName);
            this.logger.warn(`idle policy could not power off ${node.id}: ${hint}`);
            await this.record('node.cloud.power', null, node.userId, node.id, {
                targetName: node.name,
                requestedBy: FLEET_CLOUD_IDLE_REQUESTER,
                confirmationClass: FLEET_CLOUD_ACTION_CLASS['idle-policy'],
                outcome: 'failed',
                code: 'operation_failed',
                hint,
                action: 'off',
                ...this.priceExtra(node, meta),
            });
            return false;
        }
        const at = new Date(nowMs).toISOString();
        await this.patchMeta(node.id, (latest) => ({
            ...latest,
            idleSince: decision.idleSince,
            idleNotifiedKey: decision.attentionKey,
            pending: 'powering-off',
            powerStateAt: at,
            poweredOffByPolicyAt: at,
        }));
        await this.record('node.cloud.power', null, node.userId, node.id, {
            targetName: node.name,
            requestedBy: FLEET_CLOUD_IDLE_REQUESTER,
            confirmationClass: FLEET_CLOUD_ACTION_CLASS['idle-policy'],
            outcome: 'ok',
            action: 'off',
            idleHours: fleetCloudIdleHours(decision.idleSince, nowMs),
            policy: meta.idlePolicy,
            ...this.priceExtra(node, meta),
        });
        await this.notice(node, meta, decision.idleSince, 'powered-off', nowMs);
        return true;
    }

    /** One Inbox notice per idle window (FR-27). Never throws. */
    private async notice(
        node: FleetNode,
        meta: FleetCloudMeta,
        idleSince: string | null,
        variant: 'idle' | 'powered-off',
        nowMs: number = Date.now(),
    ): Promise<void> {
        if (!this.inbox) return;
        const hours = fleetCloudIdleHours(idleSince, nowMs) ?? meta.idlePolicy.afterHours;
        const rate = formatFleetCloudMoney(meta.hourlyRateCents, { currency: meta.currency, perHour: true });
        const message =
            variant === 'idle'
                ? {
                      title: `${node.name} has been idle for ${hours} h`,
                      body: `It bills about ${rate}/hour at ${meta.providerName}. Power it off or destroy it from the Fleet, or keep it running.`,
                  }
                : {
                      title: `${node.name} was powered off after ${hours} h idle`,
                      body: meta.billsWhileOff
                          ? `${meta.providerName} still bills this size while it is off. Destroy it to stop the bill, or power it on when you need it.`
                          : 'Power it on from the Fleet when you need it again.',
                  };
        try {
            await this.inbox.notice(node.userId, { ...message, organizationId: node.organizationId ?? null });
        } catch (error) {
            this.logger.warn(
                `cloud idle notice for ${node.id} was not filed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    // ─── Cost refresh (P2, spec FR-21, FR-23) ────────────────────────────

    /**
     * The cost sweep (every 10 minutes, FR-21): recompute every machine's cost
     * snapshot from the pure model (`fleetCloudCost`, per second, capped per
     * calendar month) and, where the plugin can read it, the provider's own
     * account-wide month-to-date figure (one call per provider and owner).
     * Compare-and-set on `cost.computedAt`: a snapshot younger than five
     * minutes, or one another pass wrote since this one read the row, is left
     * alone — two overlapping fires write once.
     */
    async refreshUsage(nowMs: number = Date.now()): Promise<{ machines: number; changed: number }> {
        if (!config.fleet.isCloudEnabled()) return { machines: 0, changed: 0 };
        const nodes = (await this.nodes.findCloudNodes()).filter(
            (node) => node.providerPluginId && normalizeCloudMeta(node.providerMeta),
        );
        // One provider read per provider + owner, with every machine ref the owner has there.
        const groups = new Map<string, { pluginId: string; userId: string; refs: string[] }>();
        for (const node of nodes) {
            const key = `${node.providerPluginId}::${node.userId}`;
            const group = groups.get(key) ?? { pluginId: node.providerPluginId!, userId: node.userId, refs: [] };
            if (cloudHasMachine(node)) group.refs.push(node.providerMachineRef!);
            groups.set(key, group);
        }
        const figures = new Map<string, number | null>();
        for (const [key, group] of groups) {
            let figure: number | null = null;
            if (this.machines && group.refs.length > 0) {
                const usage = await this.machines.usage(group.pluginId, group.userId, group.refs).catch(() => null);
                const cents = usage?.providerMonthToDateCents;
                figure = typeof cents === 'number' && Number.isFinite(cents) && cents >= 0 ? cents : null;
            }
            figures.set(key, figure);
        }
        let changed = 0;
        const computedAt = new Date(nowMs).toISOString();
        for (const node of nodes) {
            const read = normalizeCloudMeta(node.providerMeta)!;
            const readAt = read.cost?.computedAt ?? null;
            const last = readAt ? Date.parse(readAt) : NaN;
            if (Number.isFinite(last) && nowMs - last < FLEET_CLOUD_USAGE_FRESH_MS) continue;
            const key = `${node.providerPluginId}::${node.userId}`;
            const wrote = await this.patchMeta(node.id, (fresh) => {
                if ((fresh.cost?.computedAt ?? null) !== readAt) return null;
                return {
                    ...fresh,
                    cost: {
                        ...fleetCloudCost(fresh, nowMs),
                        providerMonthToDateCents: figures.get(key) ?? null,
                        computedAt,
                    },
                };
            }).catch(() => false);
            if (wrote) changed += 1;
        }
        return { machines: nodes.length, changed };
    }

    // ─── Create (spec FR-6 – FR-14) ──────────────────────────────────────

    async create(caller: FleetMachineCaller, input: FleetCloudCreateInput): Promise<FleetCloudCreateResponse> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const requestedBy = describeFleetMachineCaller(caller);

        // 2: the kill switch (create refuses, R-36).
        if (await this.isStopped()) {
            await this.record('node.cloud.create', userId, userId, null, {
                requestedBy,
                outcome: 'refused',
                code: 'kill_switch',
            });
            throw fleetMachineError('kill_switch', 'the Fleet is stopped; clear it under Settings → Fleet');
        }

        // 4: the request.
        const pluginId = typeof input.providerPluginId === 'string' ? input.providerPluginId.trim() : '';
        if (!pluginId) throw fleetMachineError('invalid', 'choose a cloud provider', { field: 'providerPluginId' });
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!isFleetCloudName(name)) {
            throw fleetMachineError(
                'invalid',
                'the name must be 2–39 lower-case letters, digits and hyphens, starting with a letter or digit',
                { field: 'name' },
            );
        }
        const ownerNodes = await this.nodes.findByUser(userId);
        if (ownerNodes.some((node) => node.name.toLowerCase() === name)) {
            throw fleetMachineError('invalid', `the name ${name} is already used by another computer`, { field: 'name' });
        }
        const cloudCount = ownerNodes.filter((node) => node.origin === 'cloud').length;
        if (cloudCount >= FLEET_CLOUD_MAX_PER_OWNER) {
            await this.record('node.cloud.create', userId, userId, null, {
                requestedBy,
                outcome: 'refused',
                code: 'limit_exceeded',
                providerPluginId: pluginId,
            });
            throw fleetMachineError(
                'limit_exceeded',
                `you already have ${FLEET_CLOUD_MAX_PER_OWNER} cloud computers; destroy one first`,
                { limit: FLEET_CLOUD_MAX_PER_OWNER },
            );
        }
        const software = normalizeFleetCloudSoftware(input.software ?? undefined).filter(
            // The overlay-VPN client needs its operator install script (P3); not offered until then.
            (id) => id !== 'overlay-vpn' || this.overlayVpnInstallUrl() !== null,
        );
        // Fresh prices: the acknowledged price is checked against what the provider says NOW (FR-4).
        const options = await this.readOptions(pluginId, userId, true);
        const region = options.regions.find((entry) => entry.id === input.regionId);
        if (!region || !region.available) {
            throw fleetMachineError('invalid', 'choose one of the listed regions', { field: 'regionId' });
        }
        const size = options.sizes.find((entry) => entry.id === input.sizeId);
        if (!size || !size.available || (size.regions.length > 0 && !size.regions.includes(region.id))) {
            throw fleetMachineError('invalid', `choose a size available in ${region.label}`, { field: 'sizeId' });
        }
        const acknowledged = input.acknowledgedPriceCents;
        if (typeof acknowledged !== 'number' || !Number.isFinite(acknowledged)) {
            throw fleetMachineError('invalid', 'acknowledgedPriceCents (the monthly price you were shown) is required', {
                field: 'acknowledgedPriceCents',
                currentPriceCents: size.priceMonthlyCents,
            });
        }
        if (Math.round(acknowledged) !== Math.round(size.priceMonthlyCents)) {
            throw fleetMachineError(
                'invalid',
                `the price changed — now ${formatFleetCloudMoney(size.priceMonthlyCents, { currency: options.currency })}/month; check and create again`,
                { field: 'acknowledgedPriceCents', currentPriceCents: size.priceMonthlyCents },
            );
        }
        const apiUrl = this.enrollApiUrl();
        if (!apiUrl) {
            throw fleetMachineError(
                'operation_failed',
                'this deployment has no public API address for a new machine to enrol against (set FLEET_NODE_API_URL)',
            );
        }

        // 5: the confirmation — the price sentence (FR-6), plus the Agent's
        // Decision text in `details.decision` (S9).
        const priceFacts = {
            providerName: options.providerName,
            monthlyPriceCents: size.priceMonthlyCents,
            hourlyRateCents: size.priceHourlyCents,
            billsWhileOff: options.billsWhileOff,
            currency: options.currency,
        };
        this.requireConfirmation('create', name, fleetCloudPriceSentence(priceFacts), input.fields ?? { confirm: input.confirm }, {
            decision: fleetCloudCreateSummary({
                ...priceFacts,
                name,
                regionId: region.id,
                vcpus: size.vcpus,
                memoryMiB: size.memoryMiB,
            }),
            priceMonthlyCents: size.priceMonthlyCents,
            priceHourlyCents: size.priceHourlyCents,
            providerPluginId: pluginId,
            regionId: region.id,
            sizeId: size.id,
        });

        // The registration FIRST (FR-7): `enrolling`, `origin: cloud`, the
        // provider facts, a one-time token whose hash alone is stored.
        const token = randomBytes(32).toString('base64url');
        const now = new Date();
        const meta: FleetCloudMeta = {
            providerName: options.providerName,
            regionId: region.id,
            regionLabel: region.label,
            sizeId: size.id,
            sizeLabel: size.label,
            vcpus: size.vcpus,
            memoryMiB: size.memoryMiB,
            diskGiB: size.diskGiB,
            hourlyRateCents: size.priceHourlyCents,
            monthlyPriceCents: size.priceMonthlyCents,
            currency: options.currency,
            billsWhileOff: options.billsWhileOff,
            imageLabel: options.imageLabel,
            createdAt: now.toISOString(),
            machineCreatedAt: null,
            phase: 'asking-provider',
            phaseAt: now.toISOString(),
            powerState: 'unknown',
            powerStateAt: now.toISOString(),
            pending: null,
            powerTimeline: [],
            error: null,
            idlePolicy: { ...FLEET_CLOUD_DEFAULT_IDLE_POLICY },
            idleSince: null,
            cost: null,
            software,
            tags: [FLEET_CLOUD_TAG],
            ipv4: null,
        };
        const node = await this.nodes.create({
            userId,
            organizationId: input.organizationId ?? null,
            name,
            kind: 'node',
            status: 'enrolling',
            enrollmentTokenHash: sha256Hex(token),
            credentialIssuedAt: now,
            capabilities: [],
            origin: 'cloud',
            providerPluginId: pluginId,
            providerMachineRef: null,
            providerMeta: meta,
        });
        // The per-Node tag needs the id the insert just generated (FR-10).
        const tags = [FLEET_CLOUD_TAG, fleetCloudNodeTag(node.id)];
        await this.nodes.update(node.id, { providerMeta: { ...meta, tags } });

        // Then the provider — not awaited, so Create answers within 500 ms (FR-7);
        // the row carries the phase, and the watch fails a create that never answers.
        void this.provision(node.id, {
            pluginId,
            userId,
            name,
            token,
            apiUrl,
            regionId: region.id,
            sizeId: size.id,
            software,
            tags,
            requestedBy,
        });

        await this.record('node.cloud.create', userId, userId, node.id, {
            targetName: name,
            requestedBy,
            confirmationClass: FLEET_CLOUD_ACTION_CLASS.create,
            outcome: 'ok',
            providerPluginId: pluginId,
            regionId: region.id,
            sizeId: size.id,
            hourlyRateCents: size.priceHourlyCents,
            monthlyPriceCents: size.priceMonthlyCents,
            software,
        });
        return { nodeId: node.id, operationId: node.id };
    }

    /**
     * The provider half of a create, after the row exists: generate the
     * bootstrap (with the token and a throwaway public key whose private half
     * is never kept), ask the provider, and record the machine ref — or the
     * provider's first message as `failed` (U2). Never throws.
     */
    private async provision(
        nodeId: string,
        args: {
            pluginId: string;
            userId: string;
            name: string;
            token: string;
            apiUrl: string;
            regionId: string;
            sizeId: string;
            software: FleetCloudSoftwareId[];
            tags: string[];
            requestedBy: string;
        },
    ): Promise<void> {
        try {
            if (!this.machines) throw new NoProviderError('machine-provider');
            const publicKey = generateThrowawayPublicKey();
            const bootstrapScript = buildCloudBootstrap({
                nodeId,
                name: args.name,
                apiUrl: args.apiUrl,
                token: args.token,
                runtimeSpec: this.runtimeSpec(),
                software: args.software,
                publicKey,
                overlayVpn: null,
            });
            const result = await this.machines.create(args.pluginId, args.userId, {
                name: args.name,
                regionId: args.regionId,
                sizeId: args.sizeId,
                bootstrapScript,
                publicKey,
                tags: args.tags,
            });
            const node = await this.nodes.findById(nodeId);
            const meta = node ? normalizeCloudMeta(node.providerMeta) : null;
            if (!node || !meta) return;
            const now = new Date().toISOString();
            const running = result.state === 'running';
            const ipv4 = typeof result.meta?.ipv4 === 'string' ? result.meta.ipv4 : null;
            await this.nodes.update(nodeId, {
                providerMachineRef: String(result.machineRef).slice(0, 128),
                providerMeta: {
                    ...meta,
                    machineCreatedAt: now,
                    phase: running ? 'installing' : 'booting',
                    phaseAt: now,
                    powerState: running ? 'running' : 'provisioning',
                    powerStateAt: now,
                    // Billing starts when the provider accepted the create.
                    powerTimeline: appendPowerEvent(meta.powerTimeline, 'running', now),
                    ipv4,
                },
            });
        } catch (error) {
            const hint = await this.providerFailureHint(error, args.pluginId, args.userId);
            this.logger.warn(`cloud create for ${nodeId} failed: ${hint}`);
            const node = await this.nodes.findById(nodeId).catch(() => null);
            const meta = node ? normalizeCloudMeta(node.providerMeta) : null;
            if (node && meta) {
                const now = new Date().toISOString();
                await this.nodes
                    .update(nodeId, { providerMeta: { ...meta, phase: 'failed', phaseAt: now, error: hint } })
                    .catch(() => undefined);
            }
            await this.record('node.cloud.create', args.userId, args.userId, nodeId, {
                targetName: args.name,
                requestedBy: args.requestedBy,
                confirmationClass: FLEET_CLOUD_ACTION_CLASS.create,
                outcome: 'failed',
                code: 'operation_failed',
                hint,
                providerPluginId: args.pluginId,
                regionId: args.regionId,
                sizeId: args.sizeId,
            });
        }
    }

    // ─── Power and destroy (spec FR-16 – FR-20) ──────────────────────────

    async power(
        caller: FleetMachineCaller,
        nodeId: string,
        action: unknown,
        fields?: FleetActionConfirmFields | null,
    ): Promise<FleetCloudOperationResponse> {
        this.requireEnabled();
        if (!isFleetCloudPowerAction(action)) {
            throw fleetMachineError('invalid', 'action must be on or off', { field: 'action' });
        }
        const { node, meta } = await this.resolveForAct(caller, nodeId, 'node.cloud.power', action === 'on');
        const ref = this.requireMachine(node, meta);
        if (meta.pending) {
            throw fleetMachineError('busy', `${node.name} is ${meta.pending.replace('-', ' ')} already`, { pending: meta.pending });
        }
        if (action === 'off' && meta.powerState === 'off') {
            throw fleetMachineError('busy', `${node.name} is already powered off`, { state: meta.powerState });
        }
        if (action === 'on' && meta.powerState === 'running') {
            throw fleetMachineError('busy', `${node.name} is already running`, { state: meta.powerState });
        }
        const summary =
            action === 'off'
                ? fleetCloudPowerOffSummary(node.name, meta.providerName, meta.billsWhileOff)
                : `Power on ${node.name}? It bills about ${formatFleetCloudMoney(meta.hourlyRateCents, { currency: meta.currency, perHour: true })}/hour while it runs.`;
        this.requireConfirmation(action === 'off' ? 'power-off' : 'power-on', node.name, summary, fields);
        await this.callProvider(node, meta, () => this.machines!.power(node.providerPluginId!, node.userId, ref, action));
        const now = new Date().toISOString();
        await this.nodes.update(node.id, {
            providerMeta: { ...meta, pending: action === 'off' ? 'powering-off' : 'starting', powerStateAt: now },
        });
        await this.record('node.cloud.power', fleetMachineCallerUserId(caller), node.userId, node.id, {
            targetName: node.name,
            requestedBy: describeFleetMachineCaller(caller),
            confirmationClass: FLEET_CLOUD_ACTION_CLASS[action === 'off' ? 'power-off' : 'power-on'],
            outcome: 'ok',
            action,
            ...this.priceExtra(node, meta),
        });
        return { operationId: node.id };
    }

    async destroy(
        caller: FleetMachineCaller,
        nodeId: string,
        fields?: FleetActionConfirmFields | null,
    ): Promise<FleetCloudOperationResponse> {
        this.requireEnabled();
        const { node, meta } = await this.resolveForAct(caller, nodeId, 'node.cloud.destroy', false);
        if (meta.pending === 'destroying') {
            throw fleetMachineError('busy', `${node.name} is already being destroyed`, { pending: meta.pending });
        }
        if (meta.phase === 'asking-provider' && !cloudHasMachine(node)) {
            throw fleetMachineError('busy', `${node.name} is still being created at ${meta.providerName}; try again in a minute`, {
                phase: meta.phase,
            });
        }
        // Busy first (FR-20): a person never types the name only to be told to wait.
        await this.assertNotWorking(node, caller);
        const cost = fleetCloudCost(meta);
        this.requireConfirmation(
            'destroy',
            node.name,
            fleetCloudDestroySummary({
                name: node.name,
                providerName: meta.providerName,
                costSoFarCents: cost.sinceCreatedCents,
                createdAt: meta.machineCreatedAt ?? meta.createdAt,
                currency: meta.currency,
            }),
            fields,
            { costSoFarCents: cost.sinceCreatedCents },
        );
        if (cloudHasMachine(node) && meta.powerState !== 'gone') {
            await this.nodes.update(node.id, { providerMeta: { ...meta, pending: 'destroying' } });
            try {
                await this.callProvider(node, meta, () =>
                    this.machines!.destroy(node.providerPluginId!, node.userId, node.providerMachineRef!),
                );
            } catch (error) {
                await this.nodes.update(node.id, { providerMeta: { ...meta, pending: null } }).catch(() => undefined);
                throw error;
            }
        }
        // The provider confirmed (or the machine never existed / is gone): the
        // registration goes, job history stays (FR-18).
        const final = fleetCloudCost({ ...meta, destroyedAt: new Date().toISOString() });
        await this.nodes.delete(node.id);
        await this.record('node.cloud.destroy', fleetMachineCallerUserId(caller), node.userId, node.id, {
            targetName: node.name,
            requestedBy: describeFleetMachineCaller(caller),
            confirmationClass: FLEET_CLOUD_ACTION_CLASS.destroy,
            outcome: 'ok',
            finalCostCents: final.sinceCreatedCents,
            monthToDateCents: final.monthToDateCents,
            ...this.priceExtra(node, meta),
        });
        return { operationId: node.id, costSoFarCents: final.sinceCreatedCents };
    }

    /**
     * Retry enrolment (spec U3) — the machine runs but never came online. The
     * bootstrap is the provider's user data, which the first provider cannot
     * replace on a running machine, so a fresh token cannot reach it: Destroy
     * and create again is the fix, and the refusal says so.
     */
    async retryEnrollment(caller: FleetMachineCaller, nodeId: string): Promise<FleetCloudOperationResponse> {
        this.requireEnabled();
        const { node } = await this.resolveForAct(caller, nodeId, 'node.cloud.power', false);
        if (node.status !== 'enrolling') {
            throw fleetMachineError('busy', `${node.name} is already enrolled`, { status: node.status });
        }
        throw fleetMachineError(
            'unsupported_on_node',
            `${node.name}'s first-boot script cannot be replaced at its provider; destroy it and create a new one`,
        );
    }

    // ─── Sweeps (spec FR-11, FR-29, U6) ──────────────────────────────────

    /**
     * Reconciliation (hourly, FR-29): ask the provider for every cloud
     * computer's machine. One the provider no longer knows is marked `gone`
     * (cost stops, Remove becomes available — U6); a running / off machine
     * updates the power state and settles a pending power act. Best-effort per
     * machine; a disabled plugin is skipped (U5: cost keeps being estimated).
     */
    async reconcile(): Promise<{ machines: number; changed: number }> {
        if (!config.fleet.isCloudEnabled() || !this.machines) return { machines: 0, changed: 0 };
        let machines = 0;
        let changed = 0;
        for (const node of await this.nodes.findCloudNodes()) {
            const meta = normalizeCloudMeta(node.providerMeta);
            if (!meta || !cloudHasMachine(node) || meta.powerState === 'gone' || !node.providerPluginId) continue;
            machines += 1;
            if (await this.refreshMachine(node, meta)) changed += 1;
        }
        return { machines, changed };
    }

    /**
     * The bootstrap watch (every minute, plan §10): settle what is in flight —
     * a create the provider never answered within 10 minutes becomes `failed`;
     * a booting machine the provider reports running moves to `installing`; a
     * pending power or destroy is settled from the provider's state. The
     * "never came online" item itself is computed on read by the `cloud-idle`
     * producer, from the same row.
     */
    async watchBootstrap(): Promise<{ checked: number; changed: number }> {
        if (!config.fleet.isCloudEnabled()) return { checked: 0, changed: 0 };
        let checked = 0;
        let changed = 0;
        const now = Date.now();
        for (const node of await this.nodes.findCloudNodes()) {
            const meta = normalizeCloudMeta(node.providerMeta);
            if (!meta) continue;
            if (meta.phase === 'asking-provider' && !cloudHasMachine(node)) {
                if (now - Date.parse(meta.phaseAt) > ASKING_PROVIDER_TIMEOUT_MS) {
                    const at = new Date(now).toISOString();
                    await this.nodes.update(node.id, {
                        providerMeta: {
                            ...meta,
                            phase: 'failed',
                            phaseAt: at,
                            error: `${meta.providerName} did not answer the create; no machine is known to exist`,
                        },
                    });
                    changed += 1;
                }
                continue;
            }
            const inFlight =
                meta.pending !== null ||
                (node.status === 'enrolling' && (meta.phase === 'booting' || meta.powerState === 'provisioning'));
            if (!inFlight || !cloudHasMachine(node) || !this.machines || !node.providerPluginId) continue;
            checked += 1;
            if (await this.refreshMachine(node, meta)) changed += 1;
        }
        return { checked, changed };
    }

    /** True when the node is a cloud computer that should have enrolled by now and has not (FR-11). */
    static isUnenrolled(node: Pick<FleetNode, 'status'>, meta: FleetCloudMeta, nowMs: number): boolean {
        if (node.status !== 'enrolling' || meta.phase === 'failed' || meta.powerState === 'gone') return false;
        const created = Date.parse(meta.machineCreatedAt ?? '');
        return Number.isFinite(created) && nowMs - created > FLEET_CLOUD_UNENROLLED_AFTER_MIN * 60_000;
    }

    // ─── Shared ───────────────────────────────────────────────────────────

    /** Read the provider's machine and fold it into the row; true when something changed. */
    private async refreshMachine(node: FleetNode, meta: FleetCloudMeta): Promise<boolean> {
        let machine;
        try {
            machine = await this.machines!.getMachine(node.providerPluginId!, node.userId, node.providerMachineRef!);
        } catch (error) {
            this.logger.debug(
                `cloud reconcile: ${node.id} could not be read: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
        }
        const now = new Date().toISOString();
        const next: FleetCloudMeta = { ...meta };
        let dirty = false;
        if (machine.state === 'gone') {
            next.powerState = 'gone';
            next.powerStateAt = now;
            next.goneAt = meta.goneAt ?? now;
            next.pending = null;
            next.powerTimeline = appendPowerEvent(meta.powerTimeline, 'gone', now);
            dirty = true;
        } else if (machine.state === 'running' || machine.state === 'off') {
            if (meta.powerState !== machine.state) {
                next.powerState = machine.state;
                next.powerStateAt = now;
                next.powerTimeline = appendPowerEvent(meta.powerTimeline, machine.state, now);
                dirty = true;
            }
            if (
                (meta.pending === 'powering-off' && machine.state === 'off') ||
                (meta.pending === 'starting' && machine.state === 'running')
            ) {
                next.pending = null;
                dirty = true;
            }
            // P2: once it runs again, the "powered off by policy" item is history.
            if (machine.state === 'running' && meta.poweredOffByPolicyAt) {
                next.poweredOffByPolicyAt = null;
                dirty = true;
            }
            if (machine.state === 'running' && meta.phase === 'booting') {
                next.phase = 'installing';
                next.phaseAt = now;
                dirty = true;
            }
        }
        if (machine.ipv4 && machine.ipv4 !== meta.ipv4) {
            next.ipv4 = machine.ipv4;
            dirty = true;
        }
        if (!dirty) return false;
        await this.nodes.update(node.id, { providerMeta: next });
        return true;
    }

    private requireEnabled(): void {
        if (!config.fleet.isCloudEnabled()) {
            throw fleetMachineError('not_found', 'cloud computers are not switched on in this deployment');
        }
    }

    private requireCloud(node: FleetNode): void {
        if (node.origin !== 'cloud' || !node.providerPluginId) {
            throw fleetMachineError('not_found', 'this computer is not a cloud computer');
        }
    }

    private requireMachine(node: FleetNode, meta: FleetCloudMeta): string {
        if (meta.powerState === 'gone') {
            throw fleetMachineError(
                'unsupported_on_node',
                `${node.name} is gone at ${meta.providerName}; remove it from the Fleet`,
            );
        }
        if (!cloudHasMachine(node)) {
            throw fleetMachineError(
                'busy',
                meta.phase === 'failed'
                    ? `${node.name} was never created at ${meta.providerName}`
                    : `${node.name} is still being created at ${meta.providerName}`,
                { phase: meta.phase },
            );
        }
        return node.providerMachineRef!;
    }

    /**
     * Existence, the kill switch (power-on only — off and destroy stop
     * spending, R-36), the `machines` audience, the cloud facts. A refusal
     * after existence writes its audit row.
     */
    private async resolveForAct(
        caller: FleetMachineCaller,
        nodeId: string,
        auditAction: FleetAuditAction,
        refusedWhileStopped: boolean,
    ): Promise<{ node: FleetNode; meta: FleetCloudMeta; role: FleetViewerRole }> {
        const userId = fleetMachineCallerUserId(caller);
        const { node, role } = await this.resolve(nodeId, userId, 'view');
        this.requireCloud(node);
        const meta = normalizeCloudMeta(node.providerMeta);
        if (!meta) throw fleetMachineError('not_found', 'this computer carries no cloud facts');
        const refuse = async (code: FleetLinkErrorCode, hint: string, details?: Record<string, unknown>) => {
            await this.record(auditAction, userId, node.userId, node.id, {
                targetName: node.name,
                requestedBy: describeFleetMachineCaller(caller),
                outcome: 'refused',
                code,
            });
            return fleetMachineError(code, hint, details);
        };
        if (refusedWhileStopped && (await this.isStopped())) {
            throw await refuse('kill_switch', 'the Fleet is stopped; power-off and destroy stay available');
        }
        if (!(await this.allows(node, role, userId))) {
            throw await refuse('permission_denied', `Only the owner of ${node.name} can power or destroy it`, {
                family: 'machines',
            });
        }
        return { node, meta, role };
    }

    /** Destroy is refused `busy` while a Run or a Session is live on the machine (FR-20). */
    private async assertNotWorking(node: FleetNode, caller: FleetMachineCaller): Promise<void> {
        const load = this.jobs ? (await this.jobs.loadByNodeForUser(node.userId).catch(() => ({})))[node.id] : undefined;
        const live = this.sessions ? await this.sessions.findLiveForNode(node.id).catch(() => []) : [];
        if ((load && load.activeJobCount > 0) || live.length > 0) {
            await this.record('node.cloud.destroy', fleetMachineCallerUserId(caller), node.userId, node.id, {
                targetName: node.name,
                requestedBy: describeFleetMachineCaller(caller),
                outcome: 'refused',
                code: 'busy',
            });
            throw fleetMachineError('busy', `Something is working on ${node.name} right now; end the session or wait`, {
                activeJobs: load?.activeJobCount ?? 0,
                liveSessions: live.length,
            });
        }
    }

    /** Run a provider call; a disabled plugin or a provider refusal becomes `operation_failed` with its first line. */
    private async callProvider<T>(node: FleetNode, meta: FleetCloudMeta, call: () => Promise<T>): Promise<T> {
        if (!this.machines || !node.providerPluginId) {
            throw fleetMachineError('operation_failed', pluginDisabledHint(meta.providerName));
        }
        try {
            return await call();
        } catch (error) {
            const hint = await this.providerFailureHint(error, node.providerPluginId, node.userId, meta.providerName);
            throw fleetMachineError('operation_failed', hint);
        }
    }

    /** The person-readable first line of a provider failure (U2, U5) — never a token or a body. */
    private async providerFailureHint(
        error: unknown,
        pluginId: string,
        userId: string,
        knownName?: string,
    ): Promise<string> {
        const providerName = knownName ?? (await this.machines?.providerName(pluginId, userId)) ?? 'the provider';
        if (error instanceof ProviderNotFoundError || error instanceof NoProviderError) {
            return pluginDisabledHint(providerName);
        }
        if (isMachineProviderError(error)) {
            return `${providerName}: ${error.hint.split(/\r?\n/)[0].slice(0, 200)}`;
        }
        const known = readFleetMachineError(error);
        if (known) return known.hint;
        return `${providerName} could not be reached; try again`;
    }

    /** Options for one provider + owner, cached 10 minutes (plan §5). */
    private async readOptions(
        pluginId: string,
        userId: string,
        fresh: boolean,
    ): Promise<Omit<FleetCloudOptionsView, 'limits'>> {
        const key = this.cacheKey(pluginId, userId);
        const cached = this.optionsCache.get(key);
        if (!fresh && cached && Date.now() - cached.at < FLEET_CLOUD_OPTIONS_CACHE_MS) return cached.value;
        if (!this.machines) throw fleetMachineError('not_found', 'no cloud provider is available in this deployment');
        let raw: MachineProviderOptions;
        try {
            raw = await this.machines.listOptions(pluginId, userId);
        } catch (error) {
            if (error instanceof ProviderNotFoundError || error instanceof NoProviderError) {
                throw fleetMachineError('not_found', 'connect a cloud provider first: enable it under Plugins and save its token');
            }
            throw fleetMachineError('operation_failed', await this.providerFailureHint(error, pluginId, userId));
        }
        const providerName = (await this.machines.providerName(pluginId, userId)) ?? pluginId;
        const value: Omit<FleetCloudOptionsView, 'limits'> = {
            pluginId,
            providerName,
            regions: (raw.regions ?? []).map((region) => ({
                id: String(region.id),
                label: String(region.label ?? region.id),
                available: region.available !== false,
            })),
            sizes: (raw.sizes ?? [])
                .filter((size) => Number.isFinite(size.priceMonthlyCents) && size.priceMonthlyCents > 0)
                .map((size) => ({
                    id: String(size.id),
                    label: String(size.label ?? size.id),
                    vcpus: Number(size.vcpus) || 0,
                    memoryMiB: Number(size.memoryMiB) || 0,
                    diskGiB: Number(size.diskGiB) || 0,
                    priceHourlyCents: Number(size.priceHourlyCents) || 0,
                    priceMonthlyCents: Number(size.priceMonthlyCents) || 0,
                    regions: Array.isArray(size.regions) ? size.regions.map(String) : [],
                    available: size.available !== false,
                }))
                .sort((a, b) => a.priceMonthlyCents - b.priceMonthlyCents),
            software: FLEET_CLOUD_SOFTWARE_IDS.filter((id) => id !== 'overlay-vpn' || this.overlayVpnInstallUrl() !== null).map(
                (id) => ({ id, default: id !== 'overlay-vpn' }),
            ),
            billsWhileOff: raw.billsWhileOff !== false,
            currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : 'USD',
            account: { label: String(raw.account?.label ?? '') },
            imageLabel: typeof raw.imageLabel === 'string' ? raw.imageLabel : null,
            fetchedAt: new Date().toISOString(),
        };
        this.optionsCache.set(key, { at: Date.now(), value });
        return value;
    }

    private cacheKey(pluginId: string, userId: string): string {
        return `${pluginId}::${userId}`;
    }

    private requireConfirmation(
        act: keyof typeof FLEET_CLOUD_ACTION_CLASS,
        target: string,
        summary: string,
        fields: FleetActionConfirmFields | null | undefined,
        extra: Record<string, unknown> = {},
    ): void {
        const baseClass: FleetConfirmationClass = FLEET_CLOUD_ACTION_CLASS[act];
        const missing = fleetMissingConfirmation({ class: baseClass, target, fields });
        if (!missing) return;
        throw fleetMachineError(
            'confirmation_required',
            missing === 'confirm-destructive' ? `type ${target} to confirm` : 'send confirm: true to confirm',
            {
                ...extra,
                class: missing,
                summary,
                ...(missing === 'confirm-destructive' ? { target } : {}),
            },
        );
    }

    /** Ids and prices for an audit row (FR-35) — never a token. */
    private priceExtra(node: FleetNode, meta: FleetCloudMeta): Record<string, unknown> {
        return {
            providerPluginId: node.providerPluginId ?? null,
            regionId: meta.regionId,
            sizeId: meta.sizeId,
            sizeLabel: meta.sizeLabel,
            providerName: meta.providerName,
            hourlyRateCents: meta.hourlyRateCents,
        };
    }

    /** The API origin a new machine enrols against (`FLEET_NODE_API_URL`, else `PLATFORM_API_URL`). */
    private enrollApiUrl(): string | null {
        const raw = config.fleetNode.getApiUrl() ?? process.env.PLATFORM_API_URL ?? '';
        const trimmed = raw.trim().replace(/\/+$/, '').replace(/\/api$/, '');
        return /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(trimmed) ? trimmed : null;
    }

    private runtimeSpec(): string {
        return config.fleet.getCloudRuntimeSpec() ?? `ever-works-node@${FLEET_CLOUD_DEFAULT_RUNTIME_VERSION}`;
    }

    /** P3: the operator's overlay-VPN install script (`FLEET_CLOUD_OVERLAY_VPN_INSTALL_URL`), or null. */
    private overlayVpnInstallUrl(): string | null {
        const raw = process.env.FLEET_CLOUD_OVERLAY_VPN_INSTALL_URL?.trim();
        return raw && /^https:\/\//.test(raw) ? raw : null;
    }

    private async resolve(
        nodeId: string,
        userId: string,
        family: 'view' | 'machines',
    ): Promise<{ node: FleetNode; role: FleetViewerRole }> {
        if (this.access) {
            try {
                return await this.access.resolveForFamily(nodeId, userId, family);
            } catch (error) {
                const refusal = readFleetMachineError(error);
                if (refusal) throw fleetMachineError(refusal.code, refusal.hint, refusal.details);
                if (error instanceof HttpException && error.getStatus() === 404) {
                    throw fleetMachineError('not_found', 'no such computer');
                }
                throw error;
            }
        }
        const node = nodeId ? await this.nodes.findById(nodeId) : null;
        if (!node || node.userId !== userId) throw fleetMachineError('not_found', 'no such computer');
        return { node, role: 'owner' };
    }

    /** The caller's `machines` audience on a Node (CONTRACTS §2.1; the owner always). */
    private async allows(node: FleetNode, role: FleetViewerRole, userId: string): Promise<boolean> {
        if (role === 'owner' || node.userId === userId) return true;
        if (!this.access) return false;
        return this.access.canAct(node, userId, 'machines');
    }

    private async ownCloudNodes(userId: string): Promise<FleetNode[]> {
        return (await this.nodes.findByUser(userId)).filter((node) => node.origin === 'cloud');
    }

    /** Own cloud computers plus those shared with the caller through an Organization. */
    private async visibleCloudNodes(userId: string): Promise<Array<{ node: FleetNode; role: FleetViewerRole }>> {
        const own = (await this.ownCloudNodes(userId)).map((node) => ({ node, role: 'owner' as FleetViewerRole }));
        const shared = this.access ? await this.access.listSharedWith(userId).catch(() => []) : [];
        return [
            ...own,
            ...shared
                .filter((entry) => (entry.node as FleetNode).origin === 'cloud')
                .map((entry) => ({ node: entry.node as FleetNode, role: entry.role })),
        ];
    }

    private async isStopped(): Promise<boolean> {
        if (!this.killSwitch) return false;
        try {
            return await this.killSwitch.isStopped();
        } catch {
            return true;
        }
    }

    /**
     * Re-read the row and write `mutate(freshest meta)`; `null` from `mutate`
     * writes nothing. The sweeps judge a row they read earlier, so they write
     * onto the freshest copy — a power act or a policy change a person made in
     * between is kept, not overwritten. True when something was written.
     */
    private async patchMeta(
        nodeId: string,
        mutate: (meta: FleetCloudMeta, node: FleetNode) => FleetCloudMeta | null,
    ): Promise<boolean> {
        const fresh = await this.nodes.findById(nodeId);
        const meta = fresh ? normalizeCloudMeta(fresh.providerMeta) : null;
        if (!fresh || !meta) return false;
        const next = mutate(meta, fresh);
        if (!next) return false;
        await this.nodes.update(nodeId, { providerMeta: next });
        return true;
    }

    private async record(
        action: FleetAuditAction,
        actorUserId: string | null,
        ownerUserId: string,
        nodeId: string | null,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action,
            actorUserId,
            ownerUserId,
            nodeId,
            details: { family: 'machines', target: nodeId, ...details },
        });
    }
}

/** The usage block over a set of rows (spec FR-23) — list-price estimates, Budgets untouched (FR-24). */
export function usageOf(
    nodes: readonly FleetNode[],
    nowMs: number = Date.now(),
    destroyed: readonly FleetCloudUsageRow[] = [],
    /**
     * Whose provider accounts' own month-to-date figures to carry (FR-23):
     * only that owner's machines contribute one — a machine shared through an
     * Organization never shows its owner's account-wide bill. Null = none.
     */
    accountOwnerUserId: string | null = null,
): FleetCloudUsageView {
    let hourly = 0;
    let monthToDate = 0;
    let projected = 0;
    let currency = 'USD';
    const machines: FleetCloudUsageRow[] = [];
    const providerFigures = new Map<string, FleetCloudProviderMonthToDate>();
    for (const node of nodes) {
        const view = fleetCloudViewOf(node, nowMs);
        if (!view) continue;
        const stored = normalizeCloudMeta(node.providerMeta)?.cost ?? null;
        if (
            accountOwnerUserId !== null &&
            node.userId === accountOwnerUserId &&
            node.providerPluginId &&
            stored &&
            typeof stored.providerMonthToDateCents === 'number'
        ) {
            const seen = providerFigures.get(node.providerPluginId);
            if (!seen || Date.parse(stored.computedAt) > Date.parse(seen.computedAt)) {
                providerFigures.set(node.providerPluginId, {
                    providerPluginId: node.providerPluginId,
                    providerName: view.providerName,
                    monthToDateCents: stored.providerMonthToDateCents,
                    computedAt: stored.computedAt,
                });
            }
        }
        currency = view.currency;
        hourly += view.cost.hourlyCents;
        monthToDate += view.cost.monthToDateCents;
        projected += view.cost.projectedMonthCents;
        machines.push({
            nodeId: node.id,
            name: node.name,
            providerName: view.providerName,
            regionId: view.regionId,
            sizeLabel: view.sizeLabel,
            hourlyCents: view.cost.hourlyCents,
            monthToDateCents: view.cost.monthToDateCents,
            sinceCreatedCents: view.cost.sinceCreatedCents,
            state: view.powerState,
            destroyedAt: null,
        });
    }
    // Destroyed this month (FR-22): their month so far counts, and stays in the projection.
    for (const row of destroyed) {
        monthToDate += row.monthToDateCents;
        projected += row.monthToDateCents;
        machines.push(row);
    }
    const round = (value: number) => Math.round(value * 100) / 100;
    return {
        hourlyCents: round(hourly),
        monthToDateCents: round(monthToDate),
        projectedMonthCents: round(projected),
        currency,
        estimate: true,
        machines,
        computedAt: new Date(nowMs).toISOString(),
        providerMonthToDate: [...providerFigures.values()],
    };
}
