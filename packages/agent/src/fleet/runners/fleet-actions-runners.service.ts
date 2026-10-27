import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    clampFleetActionsRunnerCount,
    diagnoseFleetActionsJob,
    FLEET_ACTIONS_JOBS_CACHE_MS,
    FLEET_ACTIONS_MAX_LISTED_JOBS,
    FLEET_ACTIONS_MAX_WATCHED_TARGETS,
    FLEET_ACTIONS_RUNNERS_CLOSED_REFRESH_MS,
    fleetActionsRunCancelSummary,
    isFleetActionsJobUnassignable,
    normalizeFleetActionsWatchedTargets,
    type FleetActionsDiagnosisRunner,
    type FleetActionsJobsView,
    type FleetActionsJobView,
    type FleetActionsRunnersPermissionView,
    type FleetActionsWatchedTarget,
    FLEET_ACTIONS_RUNNER_ACTION_CLASS,
    FLEET_ACTIONS_RUNNER_AUDIT_ACTION,
    FLEET_ACTIONS_RUNNER_CAPABILITY,
    FLEET_ACTIONS_RUNNER_LIST_VERB,
    FLEET_ACTIONS_RUNNERS_MAX_PER_NODE,
    FLEET_ACTIONS_RUNNERS_OPEN_REFRESH_MS,
    fleetActionsRunnerDefaultLabels,
    fleetActionsRunnerDefaultNames,
    fleetActionsRunnerInstallSummary,
    fleetActionsRunnerModesFor,
    fleetActionsRunnerRegistrationUrl,
    fleetActionsRunnerRemoveSummary,
    fleetActionsRunnerRestartSummary,
    fleetActionsRunnerStopSummary,
    fleetActionsRunnerVersionOf,
    fleetMissingConfirmation,
    isFleetActionsRunnerControlAction,
    isFleetActionsRunnerDownloadUrl,
    isFleetActionsRunnerMode,
    isFleetActionsRunnerName,
    isFleetActionsRunnerPhase,
    isFleetActionsRunnerScope,
    isFleetActionsRunnerState,
    isFleetActionsRunnerTarget,
    mergeFleetActionsRunnerState,
    normalizeFleetActionsRunnerLabels,
    pickFleetActionsRunnerDownload,
    type FleetActionConfirmFields,
    type FleetActionsRunnerControlAction,
    type FleetActionsRunnerInstallRequest,
    type FleetActionsRunnerInstallResponse,
    type FleetActionsRunnerListResult,
    type FleetActionsRunnerMode,
    type FleetActionsRunnerNodeFact,
    type FleetActionsRunnerOperationResponse,
    type FleetActionsRunnerOptionsView,
    type FleetActionsRunnerProgressReport,
    type FleetActionsRunnerRemoteFact,
    type FleetActionsRunnersListView,
    type FleetActionsRunnerTargetOption,
    type FleetActionsRunnerTokenKind,
    type FleetActionsRunnerTokenResponse,
    type FleetAuditAction,
    type FleetConfirmationClass,
    type FleetLinkErrorCode,
    type FleetRunnerControlPayload,
    type FleetRunnerInstallPayload,
    type FleetViewerRole,
} from '@ever-works/contracts';
import type { ActionsJob } from '@ever-works/plugin';
import { config } from '../../config';
import type { FleetActionsRunner } from '../../entities/fleet-actions-runner.entity';
import type { FleetJob } from '../../entities/fleet-job.entity';
import type { FleetNode } from '../../entities/fleet-node.entity';
import {
    ActionsRunnersFacadeError,
    ActionsRunnersFacadeService,
    type ActionsRunnersTarget,
} from '../../facades/actions-runners.facade';
import { FleetAccessService } from '../fleet-access.service';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetJobRepository } from '../fleet-job.repository';
import { FleetJobService } from '../fleet-job.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import { fleetMachineError, readFleetMachineError } from '../machine/fleet-machine.errors';
import {
    describeFleetMachineCaller,
    FLEET_MACHINE_NODE_PORT,
    fleetMachineCallerUserId,
    type FleetMachineCaller,
    type FleetMachineNodePort,
} from '../machine/fleet-machine-node.port';
import { FleetActionsRunnerRepository } from './fleet-actions-runner.repository';
import {
    capabilityValue,
    defaultWatchedTargets,
    describeAgo,
    fleetActionsRunnerViewOf,
    githubRunnerIdOf,
    isRunnerHostOnline,
    runnerHostReason,
    runnerHostReasonCode,
    runnerHostReasonHint,
} from './fleet-actions-runners.policy';

/**
 * Actions runners on computers (FL-18, plan §5, §10) — the platform half:
 * the Install dialog's options, Install, Start / Stop / Restart / Remove, the
 * runner's one-time token the node asks for when it is ready to register, the
 * node's progress, and the refresh that merges GitHub's view with the node's.
 * Every surface (the web, the Agent tools, MCP, the CLI) calls this.
 *
 * An act runs in this order, and the first refusal is the answer (CONTRACTS
 * §2.1 gate order):
 *
 *  1. **existence** — a caller outside the computer's `view` audience reads `not_found`;
 *  2. **the kill switch** — read fail-closed: `kill_switch` (runners already
 *     running are left alone: they are the owner's CI, U14);
 *  3. **the computer** — `permission_denied` outside the `machines` audience,
 *     `unreachable` while offline, `consent_missing` without `--work`,
 *     `unsupported_on_node` without `actions-runner`, `limit_exceeded` past 16;
 *  4. **the request** — target, names, labels, mode (`invalid`, the field named);
 *     the target must be covered by one of the caller's live GitHub App
 *     installations (`permission_denied`, U7);
 *  5. **the confirmation** (CONTRACTS §2.2) — `confirmation_required` with the
 *     dialog's summary until `confirm` / `confirmName` is sent.
 *
 * Install writes the runner rows FIRST (`installing`), then ONE durable
 * `runner-install` job pinned to the computer (FR-5), whose payload carries the
 * download GitHub publishes for the computer's OS and architecture with its
 * checksum — never a token (FR-7). The node asks for the registration token
 * through {@link mintRunnerToken} when it is ready; the platform mints it then,
 * hands it over once, and forgets it.
 *
 * Every act writes ONE `fleet_audit` row per runner (`family: machines`, the
 * runner as `target`, `requestedBy`, `confirmationClass`, `outcome`, the target,
 * labels, mode and version) — never a token (FR-31).
 */

/** An install is retried once if its claim lapses (the executor resumes per runner). */
const INSTALL_MAX_ATTEMPTS = 2;
const CONTROL_MAX_ATTEMPTS = 2;

/** At most one GitHub refresh per node this often while a page asks (FR-14: 30 s open). */
const REFRESH_THROTTLE_MS = FLEET_ACTIONS_RUNNERS_OPEN_REFRESH_MS;

export interface FleetActionsRunnerInstallInput extends Partial<FleetActionsRunnerInstallRequest> {
    fields?: FleetActionConfirmFields | null;
}

/** An organisation target's jobs are read from at most this many of its repositories (each is GitHub reads). */
const FLEET_ACTIONS_MAX_ORG_REPOSITORIES = 20;

/** One watched target's jobs, as last read (30 s fresh; kept through a rate limit). */
interface JobsCacheEntry {
    jobs: ActionsJob[];
    checkedAt: number;
    rateLimitedUntil: number | null;
}

/** What the per-target GitHub cache remembers between refreshes (conditional reads, back-off). */
interface TargetCacheEntry {
    etag: string | null;
    runners: FleetActionsRunnerRemoteFact[];
    rateLimitedUntil: number | null;
    checkedAt: number;
}

@Injectable()
export class FleetActionsRunnersService {
    private readonly logger = new Logger(FleetActionsRunnersService.name);
    /** `ownerUserId|scope|target` → the last GitHub listing (one API replica's memory; a cache only). */
    private readonly targetCache = new Map<string, TargetCacheEntry>();
    /** nodeId → when it was last refreshed on a page's read. */
    private readonly nodeRefreshedAt = new Map<string, number>();
    /** `ownerUserId|scope|target` → that watched target's jobs (P2; one API replica's memory, a cache only). */
    private readonly jobsCache = new Map<string, JobsCacheEntry>();
    /** ownerUserId → the jobs the last panel / poll read found (what `job-unassignable` reads). */
    private readonly jobsByOwner = new Map<string, { at: number; jobs: FleetActionsJobView[] }>();

    constructor(
        private readonly runners: FleetActionsRunnerRepository,
        private readonly nodes: FleetNodeRepository,
        private readonly jobs: FleetJobService,
        private readonly jobRows: FleetJobRepository,
        @Optional() private readonly facade?: ActionsRunnersFacadeService,
        @Optional() private readonly access?: FleetAccessService,
        @Optional() private readonly killSwitch?: FleetKillSwitchService,
        @Optional() private readonly audit?: FleetAuditService,
        // The node link (FL-02) for `runner.list` — bound by the API
        // (FleetMachineApiModule); absent, the refresh reads GitHub only.
        @Optional() @Inject(FLEET_MACHINE_NODE_PORT) private readonly link?: FleetMachineNodePort,
    ) {}

    // ─── Reads ────────────────────────────────────────────────────────────

    /** One computer's runners, for anyone in its `view` audience (FR-13). Starts a refresh when stale. */
    async list(caller: FleetMachineCaller, nodeId: string): Promise<FleetActionsRunnersListView> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const { node } = await this.resolve(nodeId, userId, 'view');
        const rows = await this.runners.listForNode(node.id);
        if (rows.length > 0) this.refreshInBackground(node);
        return this.listViewOf(node, rows);
    }

    /** Every runner the caller may see, per computer (`fleet_runners_list` without a computer). */
    async listAll(caller: FleetMachineCaller): Promise<FleetActionsRunnersListView[]> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const visible = await this.visibleNodes(userId);
        const rows = await this.runners.listForNodes(visible.map((entry) => entry.node.id));
        const byNode = new Map<string, FleetActionsRunner[]>();
        for (const row of rows) {
            const list = byNode.get(row.nodeId) ?? [];
            list.push(row);
            byNode.set(row.nodeId, list);
        }
        const out: FleetActionsRunnersListView[] = [];
        for (const { node } of visible) {
            const own = byNode.get(node.id);
            if (!own || own.length === 0) continue;
            this.refreshInBackground(node);
            out.push(await this.listViewOf(node, own));
        }
        return out;
    }

    /** The Install dialog (spec §5.1, FR-1 – FR-3). */
    async options(caller: FleetMachineCaller, nodeId: string): Promise<FleetActionsRunnerOptionsView> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const { node, role } = await this.resolve(nodeId, userId, 'view');
        const rows = await this.runners.listForNode(node.id);
        const allowed = await this.allows(node, role, userId);
        const stopped = await this.isStopped();
        const reason = runnerHostReason({
            node,
            allowed,
            stopped,
            offlineCutoffMs: this.offlineCutoff(),
            existing: rows.length,
        });
        const os = capabilityValue(node.capabilities, 'os');
        const arch = capabilityValue(node.capabilities, 'arch');
        let targets: FleetActionsRunnerTargetOption[] = [];
        let appInstalled = false;
        if (this.facade && allowed) {
            const listed = await this.facade.listTargets(userId).catch(() => []);
            appInstalled = listed.length > 0;
            targets = listed.map((entry) => ({
                scope: entry.scope,
                target: entry.target,
                accountLogin: entry.accountLogin,
                // Organisation permission is checked when picked (P2, FR-26); a repository's at install.
                permission: 'unknown' as const,
                grantUrl: null,
            }));
        }
        const remaining = Math.max(0, FLEET_ACTIONS_RUNNERS_MAX_PER_NODE - rows.length);
        return {
            nodeId: node.id,
            nodeName: node.name,
            canHost: reason === null,
            reason,
            hint: reason ? runnerHostReasonHint(reason, node, { lastSeen: describeAgo(node.lastHeartbeatAt) }) : null,
            os,
            arch,
            targets,
            modes: fleetActionsRunnerModesFor({
                os,
                hasServiceManager: (node.capabilities ?? []).includes(FLEET_ACTIONS_RUNNER_CAPABILITY),
                hasDocker: (node.capabilities ?? []).includes('docker'),
            }),
            defaultLabels: fleetActionsRunnerDefaultLabels(os, arch),
            maxPerNode: FLEET_ACTIONS_RUNNERS_MAX_PER_NODE,
            existing: rows.length,
            suggestedNames: fleetActionsRunnerDefaultNames(
                node.name,
                Math.max(remaining, 1),
                rows.map((row) => row.name),
            ).slice(0, remaining),
            appInstalled,
        };
    }

    // ─── Install (FR-4 – FR-12) ───────────────────────────────────────────

    async install(
        caller: FleetMachineCaller,
        nodeId: string,
        input: FleetActionsRunnerInstallInput,
    ): Promise<FleetActionsRunnerInstallResponse> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const requestedBy = describeFleetMachineCaller(caller);
        const { node, role } = await this.resolve(nodeId, userId, 'view');
        const existing = await this.runners.listForNode(node.id);

        // 2–3: the kill switch and the computer (the limit with the count asked for).
        const rawCount = typeof input.count === 'number' ? input.count : Number(input.count ?? 1);
        if (!Number.isInteger(rawCount) || rawCount < 1) {
            throw fleetMachineError('invalid', 'the count must be a whole number from 1 to 16', { field: 'count' });
        }
        const reason = runnerHostReason({
            node,
            allowed: await this.allows(node, role, userId),
            stopped: await this.isStopped(),
            offlineCutoffMs: this.offlineCutoff(),
            existing: existing.length,
            adding: rawCount,
        });
        if (reason) {
            const code = runnerHostReasonCode(reason);
            await this.record(FLEET_ACTIONS_RUNNER_AUDIT_ACTION.install, caller, node, null, {
                requestedBy,
                confirmationClass: FLEET_ACTIONS_RUNNER_ACTION_CLASS.install,
                outcome: 'refused',
                code,
                reason,
            });
            throw fleetMachineError(code, runnerHostReasonHint(reason, node, { lastSeen: describeAgo(node.lastHeartbeatAt) }), {
                reason,
                ...(reason === 'limit' ? { limit: FLEET_ACTIONS_RUNNERS_MAX_PER_NODE, existing: existing.length } : {}),
            });
        }
        const count = clampFleetActionsRunnerCount(rawCount);

        // 4: the request.
        const scope = input.target?.scope;
        const target = typeof input.target?.target === 'string' ? input.target.target.trim() : '';
        if (!isFleetActionsRunnerScope(scope) || !isFleetActionsRunnerTarget(scope, target)) {
            throw fleetMachineError('invalid', 'choose a repository (owner/repo) or an organisation', { field: 'target' });
        }
        const mode: FleetActionsRunnerMode = input.mode === undefined || input.mode === null ? 'service' : (input.mode as FleetActionsRunnerMode);
        if (!isFleetActionsRunnerMode(mode)) {
            throw fleetMachineError('invalid', 'the mode must be service or docker', { field: 'mode' });
        }
        if (mode === 'docker') {
            // Docker-isolated runners are phase 3 (FR-27); Windows never offers them.
            throw fleetMachineError('unsupported_on_node', 'Docker-isolated runners are not available yet; install them as services', {
                field: 'mode',
            });
        }
        const names = this.namesFor(node, count, input.names, existing);
        const os = capabilityValue(node.capabilities, 'os');
        const arch = capabilityValue(node.capabilities, 'arch');
        const normalized = normalizeFleetActionsRunnerLabels(input.labels ?? [], fleetActionsRunnerDefaultLabels(os, arch));
        if (normalized.invalid !== null) {
            throw fleetMachineError(
                'invalid',
                `"${normalized.invalid.slice(0, 40)}" is not a label: letters, digits and . _ : / + - only, no spaces or commas`,
                { field: 'labels' },
            );
        }
        const labels = normalized.labels.slice(0, 20);

        // The target must be the caller's (U7), and GitHub must publish a build for this computer (FR-6).
        const resolved = await this.resolveTarget(userId, scope, target);
        const downloads = await this.facadeCall(() => this.requireFacade().listDownloads(userId, resolved));
        const download = pickFleetActionsRunnerDownload(downloads, os, arch);
        if (!download || !isFleetActionsRunnerDownloadUrl(download.downloadUrl)) {
            throw fleetMachineError('unsupported_on_node', `GitHub publishes no runner for ${os ?? 'this system'} on ${arch ?? 'this processor'}`);
        }

        // 5: the confirmation.
        const summary = fleetActionsRunnerInstallSummary({ count, target, mode, computer: node.name });
        this.requireConfirmation('install', node.name, summary, input.fields ?? { confirm: input.confirm });

        // The rows first (FR-5), then the durable job.
        const created: FleetActionsRunner[] = [];
        try {
            for (const name of names) {
                created.push(
                    await this.runners.create({
                        nodeId: node.id,
                        ownerUserId: node.userId,
                        organizationId: node.organizationId ?? null,
                        installationEntityId: resolved.installationEntityId,
                        scope,
                        target: resolved.target,
                        name,
                        labels,
                        mode,
                        state: 'installing',
                        phase: 'queued',
                        stoppedByOwner: false,
                        installDir: name,
                        runnerVersion: fleetActionsRunnerVersionOf(download.filename),
                    }),
                );
            }
        } catch {
            await Promise.all(created.map((row) => this.runners.delete(row.id).catch(() => undefined)));
            // A unique-name race with another install is the only expected failure here.
            throw fleetMachineError('invalid', `one of these names is already used on ${node.name}`, { field: 'names' });
        }
        const payload: FleetRunnerInstallPayload = {
            nodeId: node.id,
            runners: created.map((row) => ({ runnerId: row.id, name: row.name })),
            scope,
            target: resolved.target,
            url: fleetActionsRunnerRegistrationUrl(scope, resolved.target),
            labels,
            mode,
            download,
        };
        let job;
        try {
            job = await this.jobs.enqueue({
                userId: node.userId,
                organizationId: node.organizationId ?? null,
                kind: 'runner-install',
                payload: payload as unknown as Record<string, unknown>,
                requiredCapabilities: [FLEET_ACTIONS_RUNNER_CAPABILITY],
                maxAttempts: INSTALL_MAX_ATTEMPTS,
                idempotencyKey: `runner-install:${created[0].id}`,
            });
        } catch (error) {
            // No job, no runner: take the rows back so nothing half-made stays.
            await Promise.all(created.map((row) => this.runners.delete(row.id).catch(() => undefined)));
            throw error;
        }
        for (const row of created) {
            await this.runners.update(row.id, { lastJobId: job.id });
            await this.record(FLEET_ACTIONS_RUNNER_AUDIT_ACTION.install, caller, node, row.id, {
                targetName: row.name,
                requestedBy,
                confirmationClass: FLEET_ACTIONS_RUNNER_ACTION_CLASS.install,
                outcome: 'ok',
                scope,
                repositoryOrOrganization: resolved.target,
                labels,
                mode,
                runnerVersion: row.runnerVersion ?? null,
                jobId: job.id,
            });
        }
        return { runnerIds: created.map((row) => row.id), operationId: job.id, jobId: job.id };
    }

    // ─── Start / Stop / Restart / Remove (FR-15, FR-16) ──────────────────

    async control(
        caller: FleetMachineCaller,
        nodeId: string,
        runnerId: string,
        action: unknown,
        fields?: FleetActionConfirmFields | null,
    ): Promise<FleetActionsRunnerOperationResponse> {
        this.requireEnabled();
        if (!isFleetActionsRunnerControlAction(action)) {
            throw fleetMachineError('invalid', 'action must be start, stop, restart or remove', { field: 'action' });
        }
        if (action === 'reinstall') {
            throw fleetMachineError('unsupported_on_node', 'reinstalling a runner is not available yet; remove it and install it again');
        }
        const userId = fleetMachineCallerUserId(caller);
        const requestedBy = describeFleetMachineCaller(caller);
        const { node, role } = await this.resolve(nodeId, userId, 'view');
        const runner = await this.runners.findById(runnerId);
        if (!runner || runner.nodeId !== node.id || runner.removedAt || runner.state === 'removed') {
            throw fleetMachineError('not_found', `no such runner on ${node.name}`);
        }
        const auditAction = FLEET_ACTIONS_RUNNER_AUDIT_ACTION[action] as FleetAuditAction;
        const refuse = async (code: FleetLinkErrorCode, hint: string, details?: Record<string, unknown>) => {
            await this.record(auditAction, caller, node, runner.id, {
                targetName: runner.name,
                requestedBy,
                outcome: 'refused',
                code,
            });
            return fleetMachineError(code, hint, details);
        };
        const reason = runnerHostReason({
            node,
            allowed: await this.allows(node, role, userId),
            stopped: await this.isStopped(),
            offlineCutoffMs: this.offlineCutoff(),
            existing: null,
        });
        if (reason) {
            throw await refuse(runnerHostReasonCode(reason), runnerHostReasonHint(reason, node, { lastSeen: describeAgo(node.lastHeartbeatAt) }), {
                reason,
            });
        }
        // Busy checks before the confirmation: a person never types the name only to be told to wait.
        if (runner.state === 'installing' && action !== 'remove') {
            throw await refuse('busy', `${runner.name} is still being installed`, { state: runner.state });
        }
        if (runner.phase === 'removing') throw await refuse('busy', `${runner.name} is already being removed`);
        if (action === 'start' && (runner.state === 'idle' || runner.state === 'working')) {
            throw await refuse('busy', `${runner.name} is already running`, { state: runner.state });
        }
        if (action === 'stop' && runner.state === 'stopped') {
            throw await refuse('busy', `${runner.name} is already stopped`, { state: runner.state });
        }
        if (action === 'remove' && runner.state === 'working') {
            const job = runner.currentJob?.name ? ` job ${runner.currentJob.name}` : ' a job';
            throw await refuse('busy', `${runner.name} is running${job}; stop after the job or cancel the run`, {
                state: runner.state,
            });
        }
        const summary =
            action === 'stop'
                ? fleetActionsRunnerStopSummary(runner.name)
                : action === 'restart'
                  ? fleetActionsRunnerRestartSummary(runner.name)
                  : action === 'remove'
                    ? fleetActionsRunnerRemoveSummary(runner.name, runner.target, node.name)
                    : `Start ${runner.name}?`;
        this.requireConfirmation(action, runner.name, summary, fields);

        const payload: FleetRunnerControlPayload = {
            nodeId: node.id,
            runnerId: runner.id,
            name: runner.name,
            action,
            scope: runner.scope,
            target: runner.target,
            mode: runner.mode,
            githubRunnerId: githubRunnerIdOf(runner.githubRunnerId),
        };
        const job = await this.jobs.enqueue({
            userId: node.userId,
            organizationId: node.organizationId ?? null,
            kind: 'runner-control',
            payload: payload as unknown as Record<string, unknown>,
            requiredCapabilities: [FLEET_ACTIONS_RUNNER_CAPABILITY],
            maxAttempts: CONTROL_MAX_ATTEMPTS,
        });
        const patch: Partial<FleetActionsRunner> = { lastJobId: job.id };
        if (action === 'stop') patch.stoppedByOwner = true;
        if (action === 'start' || action === 'restart') patch.stoppedByOwner = false;
        if (action === 'remove') patch.phase = 'removing';
        await this.runners.update(runner.id, patch);
        await this.record(auditAction, caller, node, runner.id, {
            targetName: runner.name,
            requestedBy,
            confirmationClass: FLEET_ACTIONS_RUNNER_ACTION_CLASS[action],
            outcome: 'ok',
            scope: runner.scope,
            repositoryOrOrganization: runner.target,
            labels: runner.labels,
            mode: runner.mode,
            runnerVersion: runner.runnerVersion ?? null,
            jobId: job.id,
        });
        return { runnerId: runner.id, operationId: job.id, jobId: job.id };
    }

    // ─── Actions jobs (P2, FR-20 – FR-26) ─────────────────────────────────

    /**
     * The Actions jobs panel (FR-20 – FR-25): the queued and running jobs that
     * target self-hosted runners in the watched repositories and organisations
     * (the saved list, else every target the caller has runners for), each
     * queued one diagnosed against the caller's own runners (FR-22), the busy
     * count, and whether the caller may cancel. GitHub is read through a
     * per-target 30 s cache with rate-limit back-off; a watched target that can
     * no longer be read is listed as unreadable with the reason, never hidden.
     */
    async jobs(caller: FleetMachineCaller, requested?: readonly unknown[] | null): Promise<FleetActionsJobsView> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const rows = (await this.runners.listForOwner(userId)).filter((row) => !row.removedAt && row.state !== 'removed');
        const saved = this.facade ? await this.facade.getWatchedTargets(userId).catch(() => null) : null;
        let watched: FleetActionsWatchedTarget[];
        if (requested && requested.length > 0) {
            const normalized = normalizeFleetActionsWatchedTargets(requested);
            if (!normalized) {
                throw fleetMachineError('invalid', 'targets must be repositories (owner/repo) or organisations', { field: 'targets' });
            }
            watched = normalized;
        } else {
            watched = saved && saved.length > 0 ? saved : defaultWatchedTargets(rows);
        }
        const available = this.facade
            ? (await this.facade.listTargets(userId).catch(() => [])).map((entry) => ({ scope: entry.scope, target: entry.target }))
            : [];
        const diagnosisRunners = await this.diagnosisRunnersOf(rows);
        const now = new Date();
        const jobs: FleetActionsJobView[] = [];
        const unreadable: FleetActionsJobsView['unreadable'] = [];
        let rateLimitedUntil: number | null = null;
        let checkedAt: number | null = null;
        for (const target of watched) {
            const read = await this.readJobs(userId, target);
            if ('reason' in read) {
                unreadable.push({ ...target, reason: read.reason, grantUrl: read.grantUrl });
                continue;
            }
            if (read.rateLimitedUntil) rateLimitedUntil = Math.max(rateLimitedUntil ?? 0, read.rateLimitedUntil);
            checkedAt = Math.max(checkedAt ?? 0, read.checkedAt);
            for (const job of read.jobs) {
                const result = diagnoseFleetActionsJob(job, diagnosisRunners);
                jobs.push({
                    repository: job.repository,
                    runId: job.runId,
                    runNumber: job.runNumber,
                    jobId: job.jobId,
                    name: job.name,
                    workflowName: job.workflowName,
                    labels: [...job.labels],
                    status: job.status,
                    runnerName: job.runnerName,
                    startedAt: job.startedAt,
                    queuedAt: job.queuedAt,
                    url: job.url,
                    diagnosis: result.diagnosis,
                    diagnosisDetail: result.detail,
                    unassignable: isFleetActionsJobUnassignable({
                        status: job.status,
                        diagnosis: result.diagnosis,
                        queuedAt: job.queuedAt,
                        now,
                    }),
                });
            }
        }
        // Queued first (oldest first), then the running ones.
        jobs.sort(
            (a, b) =>
                Number(a.status !== 'queued') - Number(b.status !== 'queued') ||
                (a.queuedAt ?? '').localeCompare(b.queuedAt ?? ''),
        );
        const listed = jobs.slice(0, FLEET_ACTIONS_MAX_LISTED_JOBS);
        const stopped = await this.isStopped();
        this.jobsByOwner.set(userId, { at: Date.now(), jobs: listed });
        return {
            jobs: listed,
            busyRunners: rows.filter((row) => row.state === 'working').length,
            totalRunners: rows.length,
            watched,
            watchedSaved: Boolean(saved && saved.length > 0),
            available,
            unreadable,
            checkedAt: checkedAt !== null ? new Date(checkedAt).toISOString() : null,
            rateLimitedUntil: rateLimitedUntil !== null ? new Date(rateLimitedUntil).toISOString() : null,
            killSwitch: stopped,
            // Every listed job is of a target the caller's own installations cover (checked again on
            // cancel); while the kill switch holds, cancelling is paused (U14).
            canCancel: !stopped,
        };
    }

    /** The jobs the last read for this person found, while fresh (the `job-unassignable` producer reads it). */
    cachedJobs(userId: string): FleetActionsJobView[] | null {
        const entry = this.jobsByOwner.get(userId);
        if (!entry || Date.now() - entry.at > FLEET_ACTIONS_RUNNERS_CLOSED_REFRESH_MS * 2) return null;
        return entry.jobs;
    }

    /** Save the watched list (FR-21): each target must be one the caller's GitHub App covers; empty = the default. */
    async setWatched(caller: FleetMachineCaller, raw: unknown): Promise<{ watched: FleetActionsWatchedTarget[] }> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const normalized = normalizeFleetActionsWatchedTargets(raw);
        if (!normalized) {
            throw fleetMachineError(
                'invalid',
                `targets must be up to ${FLEET_ACTIONS_MAX_WATCHED_TARGETS} repositories (owner/repo) or organisations`,
                { field: 'targets' },
            );
        }
        const facade = this.requireFacade();
        for (const target of normalized) await this.resolveTarget(userId, target.scope, target.target);
        await this.facadeCall(() => facade.setWatchedTargets(userId, normalized.length > 0 ? normalized : null));
        this.jobsByOwner.delete(userId);
        if (normalized.length > 0) return { watched: normalized };
        const rows = (await this.runners.listForOwner(userId)).filter((row) => !row.removedAt && row.state !== 'removed');
        return { watched: defaultWatchedTargets(rows) };
    }

    /**
     * Cancel a whole workflow run (FR-23, R-37): a repository one of the caller's
     * own installations covers, `confirm` (the sentence names the run and the
     * repository), refused `kill_switch` while the switch holds; one
     * `node.runner.job.cancel` audit row (the run as `target`).
     */
    async cancelRun(
        caller: FleetMachineCaller,
        input: { repository: unknown; runId: unknown; runNumber?: unknown; fields?: FleetActionConfirmFields | null },
    ): Promise<{ repository: string; runId: number; cancelled: true }> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const repository = typeof input.repository === 'string' ? input.repository.trim() : '';
        if (!isFleetActionsRunnerTarget('repo', repository)) {
            throw fleetMachineError('invalid', 'repository must be owner/repo', { field: 'repository' });
        }
        const runId = typeof input.runId === 'number' ? input.runId : Number(input.runId);
        if (!Number.isSafeInteger(runId) || runId <= 0) {
            throw fleetMachineError('invalid', 'runId must be a workflow run id', { field: 'runId' });
        }
        const runNumber =
            typeof input.runNumber === 'number' && Number.isSafeInteger(input.runNumber) && input.runNumber > 0
                ? input.runNumber
                : null;
        const requestedBy = describeFleetMachineCaller(caller);
        const audit = async (outcome: 'ok' | 'refused', extra: Record<string, unknown> = {}) => {
            if (!this.audit) return;
            await this.audit.tryRecord({
                action: FLEET_ACTIONS_RUNNER_AUDIT_ACTION['cancel-run'] as FleetAuditAction,
                actorUserId: userId,
                ownerUserId: userId,
                nodeId: null,
                details: {
                    family: 'machines',
                    target: `${repository}#${runId}`,
                    requestedBy,
                    confirmationClass: FLEET_ACTIONS_RUNNER_ACTION_CLASS['cancel-run'],
                    outcome,
                    repository,
                    runId,
                    runNumber,
                    ...extra,
                },
            });
        };
        if (await this.isStopped()) {
            await audit('refused', { code: 'kill_switch' });
            throw fleetMachineError(
                'kill_switch',
                'All computers are stopped — runners keep running; cancelling is paused. Clear it under Settings → Fleet',
            );
        }
        const resolved = await this.resolveTarget(userId, 'repo', repository);
        this.requireConfirmation('cancel-run', repository, fleetActionsRunCancelSummary(runNumber, repository), input.fields);
        const facade = this.requireFacade();
        await this.facadeCall(() => facade.cancelRun(userId, resolved, runId));
        await audit('ok');
        this.jobsByOwner.delete(userId);
        return { repository: resolved.target, runId, cancelled: true };
    }

    /** Whether the caller's installation may manage runners for a target (FR-26, spec §5.6). */
    async permission(caller: FleetMachineCaller, scope: unknown, target: unknown): Promise<FleetActionsRunnersPermissionView> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const name = typeof target === 'string' ? target.trim() : '';
        if (!isFleetActionsRunnerScope(scope) || !isFleetActionsRunnerTarget(scope, name)) {
            throw fleetMachineError('invalid', 'choose a repository (owner/repo) or an organisation', { field: 'target' });
        }
        const resolved = await this.resolveTarget(userId, scope, name);
        const facade = this.requireFacade();
        const check = await this.facadeCall(() => facade.checkPermission(userId, resolved));
        return {
            scope,
            target: resolved.target,
            ok: check.ok,
            missing: check.ok ? null : (check.missing ?? null),
            grantUrl: check.ok ? null : (check.grantUrl ?? null),
        };
    }

    /** One watched target's jobs through the cache: fresh for 30 s, backing off while GitHub rate-limits. */
    private async readJobs(
        userId: string,
        target: FleetActionsWatchedTarget,
    ): Promise<{ jobs: ActionsJob[]; checkedAt: number; rateLimitedUntil: number | null } | { reason: string; grantUrl: string | null }> {
        const key = `${userId}|${target.scope}|${target.target.toLowerCase()}`;
        const cached = this.jobsCache.get(key);
        const now = Date.now();
        if (cached && (now - cached.checkedAt < FLEET_ACTIONS_JOBS_CACHE_MS || (cached.rateLimitedUntil ?? 0) > now)) {
            return { jobs: cached.jobs, checkedAt: cached.checkedAt, rateLimitedUntil: cached.rateLimitedUntil };
        }
        if (!this.facade) return { reason: 'Actions runners are not available on this deployment', grantUrl: null };
        try {
            const resolved = await this.facade.resolveTarget(userId, target.scope, target.target);
            const repositories =
                resolved.scope === 'org'
                    ? (await this.facade.repositoriesOf(resolved.installationEntityId)).slice(0, FLEET_ACTIONS_MAX_ORG_REPOSITORIES)
                    : [];
            // No conditional read for jobs: a 304 on one status list would drop its jobs (the cache is the saver).
            const page = await this.facade.listJobs(userId, resolved, { etag: null, repositories });
            const until = page.rateLimitedUntil ? Date.parse(page.rateLimitedUntil) : null;
            const jobs = page.jobs.length > 0 || !cached ? page.jobs : until ? cached.jobs : page.jobs;
            this.jobsCache.set(key, { jobs, checkedAt: now, rateLimitedUntil: until });
            return { jobs, checkedAt: now, rateLimitedUntil: until };
        } catch (error) {
            if (error instanceof ActionsRunnersFacadeError) {
                if (error.reason === 'rate-limited') {
                    const until = error.extra.rateLimitedUntil ? Date.parse(error.extra.rateLimitedUntil) : now + 60_000;
                    this.jobsCache.set(key, { jobs: cached?.jobs ?? [], checkedAt: cached?.checkedAt ?? now, rateLimitedUntil: until });
                    return { jobs: cached?.jobs ?? [], checkedAt: cached?.checkedAt ?? now, rateLimitedUntil: until };
                }
                return { reason: error.message.split(/\r?\n/)[0].slice(0, 200), grantUrl: error.extra.grantUrl ?? null };
            }
            this.logger.debug(`actions jobs: ${target.target} not read (${error instanceof Error ? error.message : String(error)})`);
            return { reason: 'GitHub could not be read', grantUrl: null };
        }
    }

    /** The caller's runners as the diagnosis reads them: every label, GitHub's own included. */
    private async diagnosisRunnersOf(rows: readonly FleetActionsRunner[]): Promise<FleetActionsDiagnosisRunner[]> {
        const nodes = new Map<string, FleetNode | null>();
        const out: FleetActionsDiagnosisRunner[] = [];
        for (const row of rows) {
            if (!nodes.has(row.nodeId)) nodes.set(row.nodeId, await this.nodes.findById(row.nodeId).catch(() => null));
            const node = nodes.get(row.nodeId) ?? null;
            const defaults = fleetActionsRunnerDefaultLabels(
                capabilityValue(node?.capabilities, 'os'),
                capabilityValue(node?.capabilities, 'arch'),
            );
            out.push({ name: row.name, scope: row.scope, target: row.target, labels: [...defaults, ...(row.labels ?? [])], state: row.state });
        }
        return out;
    }

    // ─── Node-facing (node credential) ────────────────────────────────────

    /**
     * The runner's one-time token, asked by the node holding the job when it
     * is ready to register (`awaiting-token`, FR-7) or to deregister (remove).
     * The push-credential posture: an unknown node, a bad secret, a job this
     * node does not hold, a terminal job, a runner that is not this job's —
     * null (one undifferentiated 401 at the edge); a stale lease generation
     * throws the 409 the node knows. Refused `kill_switch` while the switch
     * holds (no token is handed over while the links are paused, U14).
     *
     * The token is minted NOW through the GitHub App and returned exactly once:
     * never stored, logged or audited.
     */
    async mintRunnerToken(
        runnerId: string,
        request: { nodeId: unknown; secret: unknown; jobId: unknown; leaseGeneration?: unknown; kind?: unknown },
    ): Promise<FleetActionsRunnerTokenResponse | null> {
        if (!config.fleet.isActionsRunnersEnabled()) return null;
        const held = await this.authorizeNodeJob(runnerId, request);
        if (!held) return null;
        const { runner, job } = held;
        const kind: FleetActionsRunnerTokenKind = request.kind === 'remove' ? 'remove' : 'register';
        const control = job.kind === 'runner-control' ? (job.payload?.action as FleetActionsRunnerControlAction | undefined) : undefined;
        if (kind === 'register' && job.kind !== 'runner-install' && control !== 'reinstall') return null;
        if (kind === 'remove' && control !== 'remove' && control !== 'reinstall') return null;
        if (await this.isStopped()) throw fleetMachineError('kill_switch', 'clear it under Settings → Fleet');
        const resolved = await this.resolveTarget(runner.ownerUserId, runner.scope, runner.target);
        const facade = this.requireFacade();
        if (kind === 'remove') {
            const minted = await this.facadeCall(() => facade.mintRemoveToken(runner.ownerUserId, resolved));
            return { token: minted.token, expiresAt: minted.expiresAt, replace: false };
        }
        // FR-8 / U10: "replace" only when GitHub already lists this name as THIS runner.
        let replace = false;
        const page = await this.facadeCall(() => facade.listRunners(runner.ownerUserId, resolved, null)).catch(() => null);
        const same = page?.runners.find((remote) => remote.name.toLowerCase() === runner.name.toLowerCase()) ?? null;
        if (same) {
            const ours = githubRunnerIdOf(runner.githubRunnerId);
            if (ours !== null && same.id === ours) {
                replace = true;
            } else {
                await this.runners.update(runner.id, {
                    state: 'failed',
                    phase: null,
                    lastError: `GitHub already has a runner named ${runner.name} on ${runner.target}; choose another name`,
                });
                throw fleetMachineError('invalid', `GitHub already has a runner named ${runner.name} on ${runner.target}`, {
                    field: 'names',
                });
            }
        }
        const minted = await this.facadeCall(() => facade.mintRegistrationToken(runner.ownerUserId, resolved));
        await this.runners.update(runner.id, { phase: 'registering', installationEntityId: resolved.installationEntityId });
        return { token: minted.token, expiresAt: minted.expiresAt, replace };
    }

    /**
     * A progress report from the node while it installs or controls a runner
     * (FR-11): the phase, the state it can know (its service), the first line of
     * a failure, its version, its service unit, its GitHub id. Same
     * authorisation as {@link mintRunnerToken}. A remove that reports `removed`
     * soft-removes the row (kept 30 days, never listed).
     */
    async reportProgress(runnerId: string, report: Partial<FleetActionsRunnerProgressReport>): Promise<boolean> {
        if (!config.fleet.isActionsRunnersEnabled()) return false;
        const held = await this.authorizeNodeJob(runnerId, report);
        if (!held) return false;
        const { runner } = held;
        const now = new Date();
        const patch: Partial<FleetActionsRunner> = { lastCheckAt: now };
        if (isFleetActionsRunnerPhase(report.phase)) patch.phase = report.phase === 'done' ? null : report.phase;
        if (typeof report.runnerVersion === 'string' && /^\d+\.\d+\.\d+$/.test(report.runnerVersion)) {
            patch.runnerVersion = report.runnerVersion;
        }
        if (typeof report.serviceUnit === 'string' && report.serviceUnit.trim()) {
            patch.serviceUnit = report.serviceUnit.trim().slice(0, 200);
        }
        if (typeof report.githubRunnerId === 'number' && Number.isSafeInteger(report.githubRunnerId) && report.githubRunnerId > 0) {
            patch.githubRunnerId = report.githubRunnerId;
        }
        if (typeof report.error === 'string' && report.error.trim()) {
            patch.lastError = report.error.trim().split(/\r?\n/)[0].slice(0, 300);
        } else if (report.error === null) {
            patch.lastError = null;
        }
        const state = isFleetActionsRunnerState(report.state) ? report.state : null;
        if (state === 'removed') {
            patch.state = 'removed';
            patch.removedAt = now;
            patch.phase = null;
            // FR-16: the runner could not deregister itself (its folder was gone, `config
            // remove` failed) — the platform deletes it at GitHub by its id. Best-effort:
            // the row is removed either way, and the refresh names a runner GitHub still
            // lists that no row holds.
            if (report.deregistered !== true && held.job.kind === 'runner-control') {
                await this.deregisterAtGitHub(runner);
            }
        } else if (state === 'failed') {
            patch.state = 'failed';
        } else if (state === 'idle' || state === 'offline' || state === 'stopped') {
            patch.state = state === 'offline' && runner.stoppedByOwner ? 'stopped' : state;
            patch.stateSource = 'node';
            if (state === 'idle') patch.lastSeenAt = now;
            if (runner.state === 'installing' || report.phase === 'done') {
                patch.installedAt = runner.installedAt ?? now;
                patch.phase = null;
            }
        }
        await this.runners.update(runner.id, patch);
        return true;
    }

    // ─── Refresh (FR-13, FR-14, FR-17) ────────────────────────────────────

    /**
     * One off-page pass (plan §10, every 5 minutes): for every owner with
     * runners, read GitHub per target (conditional, backing off while
     * rate-limited) and every online computer's `runner.list`, and merge
     * (GitHub wins when read). Writes only on a change; best-effort per owner.
     */
    async reconcile(): Promise<{ owners: number; runners: number; changed: number }> {
        if (!config.fleet.isActionsRunnersEnabled()) return { owners: 0, runners: 0, changed: 0 };
        const owners = await this.runners.listOwnersWithRunners();
        let runners = 0;
        let changed = 0;
        for (const ownerUserId of owners) {
            try {
                const rows = await this.runners.listForOwner(ownerUserId);
                runners += rows.length;
                changed += await this.refreshRows(ownerUserId, rows);
                // P2 (FR-25): the jobs off-page, so `job-unassignable` is raised with no page open.
                await this.jobs({ kind: 'user', userId: ownerUserId }).catch(() => undefined);
            } catch (error) {
                this.logger.debug(
                    `actions runners refresh for ${ownerUserId} failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        // Removed rows past their 30 days (the audit rows keep the history).
        await this.runners.purgeRemovedBefore(new Date(Date.now() - 30 * 24 * 60 * 60_000)).catch(() => 0);
        return { owners: owners.length, runners, changed };
    }

    /** Delete a runner at GitHub by its id (the remove fallback, FR-16). Never throws. */
    private async deregisterAtGitHub(runner: FleetActionsRunner): Promise<void> {
        const githubRunnerId = githubRunnerIdOf(runner.githubRunnerId);
        if (githubRunnerId === null || !this.facade) return;
        try {
            const resolved = await this.facade.resolveTarget(runner.ownerUserId, runner.scope, runner.target);
            await this.facade.deleteRunner(runner.ownerUserId, resolved, githubRunnerId);
        } catch (error) {
            this.logger.warn(
                `actions runner ${runner.id}: GitHub runner ${githubRunnerId} not deleted (${error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error)})`,
            );
        }
    }

    /** A page's read: refresh this computer's runners at most every 30 s, without making the page wait. */
    private refreshInBackground(node: FleetNode): void {
        const last = this.nodeRefreshedAt.get(node.id) ?? 0;
        if (Date.now() - last < REFRESH_THROTTLE_MS) return;
        this.nodeRefreshedAt.set(node.id, Date.now());
        void this.runners
            .listForNode(node.id)
            .then((rows) => this.refreshRows(node.userId, rows))
            .catch((error: unknown) =>
                this.logger.debug(`actions runners refresh of ${node.id} failed: ${error instanceof Error ? error.message : String(error)}`),
            );
    }

    /** Merge GitHub's and the nodes' view of these rows (one owner's). Answers how many changed. */
    private async refreshRows(ownerUserId: string, rows: readonly FleetActionsRunner[]): Promise<number> {
        const live = rows.filter((row) => !row.removedAt && row.state !== 'removed');
        if (live.length === 0) return 0;
        // GitHub, per target.
        const github = new Map<string, { runners: FleetActionsRunnerRemoteFact[] } | null>();
        for (const row of live) {
            const key = `${ownerUserId}|${row.scope}|${row.target.toLowerCase()}`;
            if (github.has(key)) continue;
            github.set(key, await this.readTarget(ownerUserId, row, key));
        }
        // The nodes, per online computer.
        const facts = new Map<string, Map<string, FleetActionsRunnerNodeFact> | null>();
        const nodeById = new Map<string, FleetNode | null>();
        for (const row of live) {
            if (nodeById.has(row.nodeId)) continue;
            const node = await this.nodes.findById(row.nodeId);
            nodeById.set(row.nodeId, node);
            facts.set(row.nodeId, node ? await this.readNode(node) : null);
        }
        let changed = 0;
        const now = new Date();
        for (const row of live) {
            const node = nodeById.get(row.nodeId) ?? null;
            const listing = github.get(`${ownerUserId}|${row.scope}|${row.target.toLowerCase()}`) ?? null;
            const nodeFacts = facts.get(row.nodeId) ?? null;
            const remote = listing
                ? (listing.runners.find((entry) => {
                      const ours = githubRunnerIdOf(row.githubRunnerId);
                      return ours !== null ? entry.id === ours : entry.name.toLowerCase() === row.name.toLowerCase();
                  }) ?? null)
                : undefined;
            const fact = nodeFacts ? (nodeFacts.get(row.id) ?? null) : undefined;
            const merged = mergeFleetActionsRunnerState({
                state: row.state,
                stoppedByOwner: row.stoppedByOwner,
                github: remote ?? undefined,
                githubMissing: listing !== null && remote === null,
                node: fact ?? undefined,
                nodeMissing: nodeFacts !== null && fact === null,
                nodeName: node?.name ?? 'the computer',
            });
            const patch: Partial<FleetActionsRunner> = {};
            if (merged.state !== row.state) patch.state = merged.state;
            if (merged.source && merged.source !== row.stateSource) patch.stateSource = merged.source;
            if (merged.seen) patch.lastSeenAt = now;
            if (merged.state === 'unknown') {
                if (merged.discrepancy && merged.discrepancy !== row.lastError) patch.lastError = merged.discrepancy;
            } else if (row.state === 'unknown' && row.lastError) {
                patch.lastError = null;
            }
            if (remote && githubRunnerIdOf(row.githubRunnerId) === null) patch.githubRunnerId = remote.id;
            if (fact?.runnerVersion && fact.runnerVersion !== row.runnerVersion) patch.runnerVersion = fact.runnerVersion;
            if (merged.state !== 'working' && row.currentJob) patch.currentJob = null;
            if (listing !== null || nodeFacts !== null) patch.lastCheckAt = now;
            if (Object.keys(patch).length === 0) continue;
            await this.runners.update(row.id, patch);
            if (patch.state !== undefined || patch.lastError !== undefined) changed += 1;
        }
        return changed;
    }

    /** GitHub's runners of one target, through the cache (ETag, rate-limit back-off). Null when not read. */
    private async readTarget(
        ownerUserId: string,
        row: FleetActionsRunner,
        key: string,
    ): Promise<{ runners: FleetActionsRunnerRemoteFact[] } | null> {
        if (!this.facade) return null;
        const cached = this.targetCache.get(key);
        if (cached?.rateLimitedUntil && cached.rateLimitedUntil > Date.now()) {
            return { runners: cached.runners };
        }
        try {
            const resolved = await this.facade.resolveTarget(ownerUserId, row.scope, row.target);
            const page = await this.facade.listRunners(ownerUserId, resolved, cached?.etag ?? null);
            const runners = page.notModified && cached ? cached.runners : page.runners.map((entry) => ({
                id: entry.id,
                name: entry.name,
                status: entry.status,
                busy: entry.busy,
            }));
            this.targetCache.set(key, {
                etag: page.etag ?? cached?.etag ?? null,
                runners,
                rateLimitedUntil: page.rateLimitedUntil ? Date.parse(page.rateLimitedUntil) : null,
                checkedAt: Date.now(),
            });
            return { runners };
        } catch (error) {
            if (error instanceof ActionsRunnersFacadeError && error.reason === 'rate-limited') {
                const until = error.extra.rateLimitedUntil ? Date.parse(error.extra.rateLimitedUntil) : Date.now() + 60_000;
                this.targetCache.set(key, {
                    etag: cached?.etag ?? null,
                    runners: cached?.runners ?? [],
                    rateLimitedUntil: until,
                    checkedAt: cached?.checkedAt ?? 0,
                });
                return cached ? { runners: cached.runners } : null;
            }
            this.logger.debug(`actions runners: ${row.target} not read (${error instanceof Error ? error.message : String(error)})`);
            return null;
        }
    }

    /** One computer's `runner.list` over its link, or null when it cannot be read now. */
    private async readNode(node: FleetNode): Promise<Map<string, FleetActionsRunnerNodeFact> | null> {
        if (!this.link || !isRunnerHostOnline(node, this.offlineCutoff())) return null;
        try {
            const reply = await this.link.request({
                nodeId: node.id,
                verb: FLEET_ACTIONS_RUNNER_LIST_VERB,
                caller: { kind: 'user', userId: node.userId },
                actionFamily: 'view',
                stateChanging: false,
                params: {},
                timeoutMs: 15_000,
                awaitOperationMs: 15_000,
            });
            if (reply.operationId !== undefined) return null;
            const listed = reply.result as FleetActionsRunnerListResult | null;
            if (!listed || !Array.isArray(listed.runners)) return null;
            return new Map(listed.runners.map((fact) => [fact.runnerId, fact]));
        } catch (error) {
            this.logger.debug(`actions runners: ${node.id} could not be read (${error instanceof Error ? error.message : String(error)})`);
            return null;
        }
    }

    // ─── Shared ───────────────────────────────────────────────────────────

    private async listViewOf(node: FleetNode, rows: readonly FleetActionsRunner[]): Promise<FleetActionsRunnersListView> {
        let checkedAt: number | null = null;
        let rateLimitedUntil: number | null = null;
        for (const row of rows) {
            const at = row.lastCheckAt ? new Date(row.lastCheckAt).getTime() : NaN;
            if (Number.isFinite(at) && (checkedAt === null || at > checkedAt)) checkedAt = at;
            const cached = this.targetCache.get(`${row.ownerUserId}|${row.scope}|${row.target.toLowerCase()}`);
            if (cached?.rateLimitedUntil && cached.rateLimitedUntil > Date.now()) {
                rateLimitedUntil = Math.max(rateLimitedUntil ?? 0, cached.rateLimitedUntil);
            }
        }
        return {
            node: { id: node.id, name: node.name },
            runners: rows.map((row) => fleetActionsRunnerViewOf(row, node)),
            checkedAt: checkedAt !== null ? new Date(checkedAt).toISOString() : null,
            rateLimitedUntil: rateLimitedUntil !== null ? new Date(rateLimitedUntil).toISOString() : null,
            killSwitch: await this.isStopped(),
        };
    }

    /** The names for `count` runners: the caller's (validated) or `<computer>-<n>` (FR-3). */
    private namesFor(
        node: FleetNode,
        count: number,
        requested: readonly unknown[] | null | undefined,
        existing: readonly FleetActionsRunner[],
    ): string[] {
        const taken = new Set(existing.map((row) => row.name.toLowerCase()));
        if (!requested || requested.length === 0) {
            return fleetActionsRunnerDefaultNames(node.name, count, [...taken]);
        }
        if (requested.length !== count) {
            throw fleetMachineError('invalid', `give ${count} names, one per runner`, { field: 'names' });
        }
        const out: string[] = [];
        for (const raw of requested) {
            const name = typeof raw === 'string' ? raw.trim() : '';
            if (!isFleetActionsRunnerName(name)) {
                throw fleetMachineError('invalid', 'a runner name is up to 64 letters, digits, dots, dashes and underscores', {
                    field: 'names',
                });
            }
            const key = name.toLowerCase();
            if (taken.has(key)) {
                throw fleetMachineError('invalid', `${name} is already a runner on ${node.name}`, { field: 'names', name });
            }
            taken.add(key);
            out.push(name);
        }
        return out;
    }

    /** The caller's installation covering the target, or `permission_denied` (U7, FR-2). */
    private async resolveTarget(userId: string, scope: 'org' | 'repo', target: string): Promise<ActionsRunnersTarget> {
        return this.facadeCall(() => this.requireFacade().resolveTarget(userId, scope, target));
    }

    private requireFacade(): ActionsRunnersFacadeService {
        if (!this.facade) {
            throw fleetMachineError('unsupported_on_node', 'Actions runners are not available on this deployment');
        }
        return this.facade;
    }

    /** A facade call whose refusal becomes the CONTRACTS §8 envelope (U7, U8, U17). */
    private async facadeCall<T>(run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } catch (error) {
            if (error instanceof ActionsRunnersFacadeError) {
                switch (error.reason) {
                    case 'not-covered':
                        throw fleetMachineError('permission_denied', error.message, { reason: 'app-not-installed' });
                    case 'permission-missing':
                        throw fleetMachineError(
                            'permission_denied',
                            error.message,
                            { reason: 'permission-missing', missing: error.extra.missing ?? null, grantUrl: error.extra.grantUrl ?? null },
                        );
                    case 'rate-limited':
                        throw fleetMachineError('operation_failed', 'GitHub is rate-limiting; try again shortly', {
                            reason: 'rate-limited',
                            rateLimitedUntil: error.extra.rateLimitedUntil ?? null,
                        });
                    case 'no-provider':
                    case 'not-configured':
                        throw fleetMachineError('unsupported_on_node', 'Actions runners are not available on this deployment', {
                            reason: error.reason,
                        });
                    default:
                        throw fleetMachineError('operation_failed', error.message.split(/\r?\n/)[0].slice(0, 300));
                }
            }
            throw error;
        }
    }

    private requireEnabled(): void {
        if (!config.fleet.isActionsRunnersEnabled()) {
            throw fleetMachineError('not_found', 'Actions runners are not switched on in this deployment');
        }
    }

    private requireConfirmation(
        act: keyof typeof FLEET_ACTIONS_RUNNER_ACTION_CLASS,
        target: string,
        summary: string,
        fields: FleetActionConfirmFields | null | undefined,
    ): void {
        const baseClass: FleetConfirmationClass = FLEET_ACTIONS_RUNNER_ACTION_CLASS[act];
        const missing = fleetMissingConfirmation({ class: baseClass, target, fields });
        if (!missing) return;
        throw fleetMachineError(
            'confirmation_required',
            missing === 'confirm-destructive' ? `type ${target} to confirm` : 'send confirm: true to confirm',
            { class: missing, summary, ...(missing === 'confirm-destructive' ? { target } : {}) },
        );
    }

    /** The node's job, held by the calling node, naming this runner — or null (the edge's 401). */
    private async authorizeNodeJob(
        runnerId: string,
        request: { nodeId?: unknown; secret?: unknown; jobId?: unknown; leaseGeneration?: unknown },
    ): Promise<{ runner: FleetActionsRunner; job: FleetJob } | null> {
        if (typeof request.jobId !== 'string' || !request.jobId) return null;
        const held = await this.jobs.authorizeRunSecretRequest({
            nodeId: request.nodeId,
            secret: request.secret,
            jobId: request.jobId,
            leaseGeneration: request.leaseGeneration,
        });
        if (!held) return null;
        const job = await this.jobRows.findById(held.jobId);
        if (!job || (job.kind !== 'runner-install' && job.kind !== 'runner-control')) return null;
        const payload = (job.payload ?? {}) as Partial<FleetRunnerInstallPayload & FleetRunnerControlPayload>;
        if (payload.nodeId !== held.nodeId) return null;
        const named =
            job.kind === 'runner-install'
                ? Array.isArray(payload.runners) && payload.runners.some((entry) => entry?.runnerId === runnerId)
                : payload.runnerId === runnerId;
        if (!named) return null;
        const runner = await this.runners.findById(runnerId);
        if (!runner || runner.nodeId !== held.nodeId) return null;
        return { runner, job };
    }

    private offlineCutoff(): number {
        return Date.now() - config.fleet.getNodeOfflineAfterMs();
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

    /** The caller's `machines` audience on a computer (CONTRACTS §2.1; the owner always). */
    private async allows(node: FleetNode, role: FleetViewerRole, userId: string): Promise<boolean> {
        if (role === 'owner' || node.userId === userId) return true;
        if (!this.access) return false;
        return this.access.canAct(node, userId, 'machines');
    }

    /** Every Node the caller may see, with their role (own + shared through an Organization). */
    private async visibleNodes(userId: string): Promise<Array<{ node: FleetNode; role: FleetViewerRole }>> {
        const own = (await this.nodes.findByUser(userId)).map((node) => ({ node, role: 'owner' as FleetViewerRole }));
        const shared = this.access ? await this.access.listSharedWith(userId).catch(() => []) : [];
        return [...own, ...shared.map((entry) => ({ node: entry.node as FleetNode, role: entry.role }))].filter(
            (entry) => entry.node.status !== 'enrolling',
        );
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
        caller: FleetMachineCaller,
        node: FleetNode,
        runnerId: string | null,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action,
            actorUserId: fleetMachineCallerUserId(caller),
            ownerUserId: node.userId,
            nodeId: node.id,
            details: { family: 'machines', target: runnerId ?? node.id, ...details },
        });
    }
}
