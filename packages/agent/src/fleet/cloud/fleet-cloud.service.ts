import { randomBytes } from 'crypto';
import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import {
    FLEET_CLOUD_ACTION_CLASS,
    FLEET_CLOUD_DEFAULT_IDLE_POLICY,
    FLEET_CLOUD_MAX_PER_OWNER,
    FLEET_CLOUD_OPTIONS_CACHE_MS,
    FLEET_CLOUD_SOFTWARE_IDS,
    FLEET_CLOUD_TAG,
    FLEET_CLOUD_UNENROLLED_AFTER_MIN,
    fleetCloudCost,
    fleetCloudCreateSummary,
    fleetCloudDestroySummary,
    fleetCloudNodeTag,
    fleetCloudPowerOffSummary,
    fleetCloudPriceSentence,
    fleetMissingConfirmation,
    formatFleetCloudMoney,
    isFleetCloudName,
    isFleetCloudPowerAction,
    normalizeFleetCloudSoftware,
    type FleetActionConfirmFields,
    type FleetAuditAction,
    type FleetCloudCreateRequest,
    type FleetCloudCreateResponse,
    type FleetCloudListView,
    type FleetCloudMeta,
    type FleetCloudOperationResponse,
    type FleetCloudOptionsView,
    type FleetCloudPowerAction,
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
import { buildCloudBootstrap, FLEET_CLOUD_DEFAULT_RUNTIME_VERSION } from './bootstrap-script';
import { appendPowerEvent, cloudHasMachine, fleetCloudViewOf, normalizeCloudMeta } from './fleet-cloud.view';
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
        return { machines, usage: usageOf(visible.map((entry) => entry.node)), providers };
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
            return usageOf([node]);
        }
        return usageOf(await this.ownCloudNodes(userId));
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
    ): Promise<{ node: FleetNode; meta: FleetCloudMeta }> {
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
        return { node, meta };
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

    private async record(
        action: FleetAuditAction,
        actorUserId: string,
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
export function usageOf(nodes: readonly FleetNode[], nowMs: number = Date.now()): FleetCloudUsageView {
    let hourly = 0;
    let monthToDate = 0;
    let projected = 0;
    let currency = 'USD';
    const machines = [];
    for (const node of nodes) {
        const view = fleetCloudViewOf(node, nowMs);
        if (!view) continue;
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
    const round = (value: number) => Math.round(value * 100) / 100;
    return {
        hourlyCents: round(hourly),
        monthToDateCents: round(monthToDate),
        projectedMonthCents: round(projected),
        currency,
        estimate: true,
        machines,
        computedAt: new Date(nowMs).toISOString(),
    };
}
