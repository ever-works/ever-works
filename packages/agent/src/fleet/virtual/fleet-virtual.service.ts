import { randomBytes } from 'crypto';
import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    FLEET_DOCKER_CAPABILITY,
    FLEET_KVM_CAPABILITY,
    FLEET_VIRTUAL_ACTION_CLASS,
    FLEET_VIRTUAL_CPU_CHOICES,
    FLEET_VIRTUAL_DEFAULT_CPUS,
    FLEET_VIRTUAL_DEFAULT_DISK_GIB,
    FLEET_VIRTUAL_DEFAULT_MEMORY_GIB,
    FLEET_VIRTUAL_DISK_GIB_CHOICES,
    FLEET_VIRTUAL_HOST_CAPABILITY,
    FLEET_VIRTUAL_MAX_PER_HOST,
    FLEET_VIRTUAL_MEMORY_GIB_CHOICES,
    FLEET_VIRTUAL_VM_SYSTEMS_SHIPPED,
    FLEET_VIRTUAL_WINDOWS_MIN_FREE_DISK_GIB,
    FLEET_VIRTUAL_PASSWORD_REVEAL_SEC,
    FLEET_VIRTUAL_WINDOWS_CAPABILITY,
    fleetMissingConfirmation,
    fleetVirtualCreateSummary,
    fleetVirtualOfferedSystems,
    fleetVirtualSystem,
    isFleetVirtualCpus,
    isFleetVirtualDiskGiB,
    isFleetVirtualMemoryGiB,
    isFleetVirtualName,
    isFleetVirtualPhase,
    isFleetVirtualPowerAction,
    isFleetVirtualState,
    type FleetActionConfirmFields,
    type FleetAuditAction,
    type FleetConfirmationClass,
    type FleetLinkErrorCode,
    type FleetNodeView,
    type FleetViewerRole,
    type FleetVirtualCreateRequest,
    type FleetVirtualCreateResponse,
    type FleetVirtualEnrollTokenResponse,
    type FleetVirtualHostOption,
    type FleetVirtualListResult,
    type FleetVirtualMeta,
    type FleetVirtualOperationResponse,
    type FleetVirtualOptionsView,
    type FleetVirtualPasswordRevealResponse,
    type FleetVirtualProgressReport,
    type FleetVirtualSystem,
    type FleetVmControlAction,
    type FleetVmControlPayload,
    type FleetVmCreatePayload,
} from '@ever-works/contracts';
import { config } from '../../config';
import type { FleetJob } from '../../entities/fleet-job.entity';
import type { FleetNode } from '../../entities/fleet-node.entity';
import { FleetAccessService } from '../fleet-access.service';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetJobRepository } from '../fleet-job.repository';
import { FleetJobService } from '../fleet-job.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { sha256Hex } from '../fleet-node-credential';
import { FleetNodeRepository } from '../fleet-node.repository';
import { FleetService } from '../fleet.service';
import { fleetMachineError, readFleetMachineError } from '../machine/fleet-machine.errors';
import {
    describeFleetMachineCaller,
    FLEET_MACHINE_NODE_PORT,
    fleetMachineCallerUserId,
    type FleetMachineCaller,
    type FleetMachineNodePort,
} from '../machine/fleet-machine-node.port';
import { FleetSessionRepository } from '../sessions/fleet-session.repository';
import {
    autoPickHost,
    capabilityValue,
    destroySummary,
    hostEligibility,
    hostReasonErrorCode,
    hostReasonHint,
    isHostOnline,
    netFreeMemoryMiB,
    reservedMemoryMiB,
    stopSummary,
    windowsDiskShortfall,
} from './fleet-virtual.policy';
import { deriveVirtualState, fleetVirtualViewOf, normalizeVirtualMeta } from './fleet-virtual.view';

/**
 * Virtual computers (FL-16) — the platform half of creating computers ON a
 * computer: the host picker, Create, Start / Stop, Destroy, the guest's
 * late-minted enrolment token and the host's progress reports. Every surface
 * (the web, the Agent tools, MCP, the CLI) calls this.
 *
 * An act runs in this order, and the first refusal is the answer
 * (CONTRACTS §2.1 gate order):
 *
 *  1. **existence** — a caller outside the host's `view` audience reads
 *     `not_found`, exactly as every Node endpoint answers a stranger;
 *  2. **the kill switch** — read fail-closed: `kill_switch`;
 *  3. **the host** — the closed set of reasons of spec FR-4 / §5.8
 *     (`unsupported_on_node`, `permission_denied` outside the `machines`
 *     audience, `unreachable` while offline, `consent_missing` without
 *     `--manage`, `limit_exceeded` at four children);
 *  4. **the request** — name, system and size (`invalid`, the field named);
 *  5. **the confirmation** (CONTRACTS §2.2) — `confirmation_required` with
 *     the dialog's summary until `confirm` / `confirmName` is sent.
 *
 * Creation writes the child's registration FIRST (`origin: virtual`,
 * `hostNodeId`, `virtualKind`, status `enrolling`, bound to the host's
 * Organization, owned by the host's owner — FR-7, FR-16) and only then a
 * durable `vm-create` job pinned to the host. The row's credential hash is
 * of a throwaway value and already expired: the guest's real token is minted
 * only when the host says the guest is ready (R-35, FR-14), through
 * {@link mintEnrollToken}, and returned once to the host.
 *
 * Every act writes ONE `fleet_audit` row (`family: machines`, the child as
 * `target`, `requestedBy`, `confirmationClass`, `outcome`) — never a token,
 * never a password (FR-37, NFR Security).
 */

/** The `--manage` tag (CONTRACTS §1.2; the node's `FLEET_MANAGED_CAPABILITY`). */
const MANAGED_CAPABILITY = 'managed';

/** Host features the jobs require (CONTRACTS §1.2) beside the kind's own. */
const BASE_JOB_CAPABILITIES = [MANAGED_CAPABILITY, FLEET_DOCKER_CAPABILITY, FLEET_VIRTUAL_HOST_CAPABILITY];

/** A create is retried once if its claim lapses (the executor is idempotent per child). */
const CREATE_MAX_ATTEMPTS = 2;
const CONTROL_MAX_ATTEMPTS = 2;

export interface FleetVirtualCreateInput extends Partial<FleetVirtualCreateRequest> {
    fields?: FleetActionConfirmFields | null;
}

/** One child of a host, as `GET /nodes/:id/virtual` answers it. */
export interface FleetVirtualChildrenView {
    host: { id: string; name: string };
    children: FleetNodeView[];
    /** Memory every child reserves on the host, and what is free net of it (spec S6). */
    reservedMemoryMiB: number;
    freeMemoryMiB: number | null;
}

@Injectable()
export class FleetVirtualService {
    private readonly logger = new Logger(FleetVirtualService.name);

    constructor(
        private readonly nodes: FleetNodeRepository,
        private readonly jobs: FleetJobService,
        private readonly jobRows: FleetJobRepository,
        private readonly fleet: FleetService,
        @Optional() private readonly access?: FleetAccessService,
        @Optional() private readonly killSwitch?: FleetKillSwitchService,
        @Optional() private readonly audit?: FleetAuditService,
        // The node link (FL-02) for the `vm.*` reads — bound by the API
        // (FleetMachineApiModule); absent, the reconcile reads nothing live.
        @Optional() @Inject(FLEET_MACHINE_NODE_PORT) private readonly link?: FleetMachineNodePort,
        // Live sessions block a destroy (U13). Absent, only live jobs do.
        @Optional() private readonly sessions?: FleetSessionRepository,
    ) {}

    // ─── Reads ────────────────────────────────────────────────────────────

    /**
     * The host picker (FR-4): every Node the caller may see, with free memory
     * net of reservations, free disk, KVM, its child count and — for `systemId`
     * — whether it may host it and, if not, why. `autoPickNodeId` is "Choose for
     * me" (the eligible host with the most free memory).
     */
    async options(caller: FleetMachineCaller, systemId?: unknown): Promise<FleetVirtualOptionsView> {
        const system = this.resolveSystemForOptions(systemId);
        const userId = fleetMachineCallerUserId(caller);
        const visible = await this.visibleNodes(userId);
        const hosts = visible.filter((entry) => entry.node.kind !== 'k8s');
        const children = await this.nodes.findByHostNodeIds(hosts.map((entry) => entry.node.id));
        const byHost = groupByHost(children);
        const cutoff = Date.now() - config.fleet.getNodeOfflineAfterMs();
        const options: FleetVirtualHostOption[] = [];
        for (const { node, role } of hosts) {
            const own = byHost.get(node.id) ?? [];
            const allowed = await this.allows(node, role, userId);
            const reason = hostEligibility({
                host: node,
                system,
                childCount: own.length,
                offlineCutoffMs: cutoff,
                allowed,
            });
            options.push({
                nodeId: node.id,
                name: node.name,
                status: node.status,
                os: capabilityValue(node.capabilities, 'os'),
                arch: capabilityValue(node.capabilities, 'arch'),
                lastHeartbeatAt: node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).toISOString() : null,
                freeMemoryMiB: netFreeMemoryMiB(node.health ?? null, own.map(metaOf)),
                reservedMemoryMiB: reservedMemoryMiB(own.map(metaOf)),
                freeDiskMiB: typeof node.health?.diskFreeMiB === 'number' ? node.health.diskFreeMiB : null,
                kvm: (node.capabilities ?? []).includes(FLEET_KVM_CAPABILITY),
                childCount: own.length,
                eligible: reason === null,
                reason,
            });
        }
        options.sort((a, b) => a.name.localeCompare(b.name));
        return {
            systemId: system.id,
            hosts: options,
            systems: fleetVirtualOfferedSystems(),
            limits: {
                maxPerHost: FLEET_VIRTUAL_MAX_PER_HOST,
                cpus: FLEET_VIRTUAL_CPU_CHOICES,
                memoryGiB: FLEET_VIRTUAL_MEMORY_GIB_CHOICES,
                diskGiB: FLEET_VIRTUAL_DISK_GIB_CHOICES,
                defaults: {
                    cpus: FLEET_VIRTUAL_DEFAULT_CPUS,
                    memoryGiB: FLEET_VIRTUAL_DEFAULT_MEMORY_GIB,
                    diskGiB: FLEET_VIRTUAL_DEFAULT_DISK_GIB,
                },
                windowsMinFreeDiskGiB: FLEET_VIRTUAL_WINDOWS_MIN_FREE_DISK_GIB,
            },
            autoPickNodeId: autoPickHost(options),
        };
    }

    /** The children of one host, for anyone in its `view` audience (FR-31, FR-32). */
    async listChildren(caller: FleetMachineCaller, hostNodeId: string): Promise<FleetVirtualChildrenView> {
        const userId = fleetMachineCallerUserId(caller);
        const { node: host } = await this.resolve(hostNodeId, userId, 'view');
        const children = await this.nodes.findByHostNodeIds([host.id]);
        const views: FleetNodeView[] = [];
        for (const child of children) {
            const role: FleetViewerRole = child.userId === userId ? 'owner' : await this.roleOf(child, userId);
            if (role === 'stranger') continue;
            const view = this.fleet.viewForRole(child, role);
            views.push({ ...view, virtual: fleetVirtualViewOf(child, host.name) });
        }
        const metas = children.map(metaOf);
        return {
            host: { id: host.id, name: host.name },
            children: views,
            reservedMemoryMiB: reservedMemoryMiB(metas),
            freeMemoryMiB: netFreeMemoryMiB(host.health ?? null, metas),
        };
    }

    /** Every child the caller may see, across hosts (`fleet_virtual_list` without a host). */
    async listAllChildren(caller: FleetMachineCaller): Promise<FleetVirtualChildrenView[]> {
        const userId = fleetMachineCallerUserId(caller);
        const visible = await this.visibleNodes(userId);
        const out: FleetVirtualChildrenView[] = [];
        const children = await this.nodes.findByHostNodeIds(visible.map((entry) => entry.node.id));
        const hostsWithChildren = new Set(children.map((child) => child.hostNodeId));
        for (const { node } of visible) {
            if (!hostsWithChildren.has(node.id)) continue;
            out.push(await this.listChildren(caller, node.id));
        }
        return out;
    }

    // ─── Create (FR-7) ────────────────────────────────────────────────────

    async create(
        caller: FleetMachineCaller,
        hostNodeIdOrAuto: string | null | undefined,
        input: FleetVirtualCreateInput,
    ): Promise<FleetVirtualCreateResponse> {
        this.requireEnabled();
        const userId = fleetMachineCallerUserId(caller);
        const requestedBy = describeFleetMachineCaller(caller);
        const system = this.resolveSystemForCreate(input.systemId);

        // 1–3: existence, the kill switch, the host.
        const host = await this.resolveHostForCreate(caller, hostNodeIdOrAuto ?? input.hostNodeId ?? null, system);

        // Windows (P2, FR-18, U7): refused before any download when the host says it lacks the disk.
        if (system.kind === 'vm') {
            const shortfall = windowsDiskShortfall(host.health ?? null, host.name);
            if (shortfall) throw fleetMachineError('unsupported_on_node', shortfall, { reason: 'disk', hostNodeId: host.id });
        }

        // 4: the request.
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!isFleetVirtualName(name)) {
            throw fleetMachineError(
                'invalid',
                'the name must be 2–39 lower-case letters, digits and hyphens, starting with a letter or digit',
                { field: 'name' },
            );
        }
        const cpus = input.cpus ?? FLEET_VIRTUAL_DEFAULT_CPUS;
        if (!isFleetVirtualCpus(cpus)) {
            throw fleetMachineError('invalid', 'CPUs must be 2, 4 or 8', { field: 'cpus' });
        }
        const memoryGiB = input.memoryGiB ?? FLEET_VIRTUAL_DEFAULT_MEMORY_GIB;
        if (!isFleetVirtualMemoryGiB(memoryGiB)) {
            throw fleetMachineError('invalid', 'memory must be 4, 8 or 16 GB', { field: 'memoryGiB' });
        }
        let diskGiB: number | null = null;
        if (system.kind === 'vm') {
            const disk = input.diskGiB ?? FLEET_VIRTUAL_DEFAULT_DISK_GIB;
            if (!isFleetVirtualDiskGiB(disk)) {
                throw fleetMachineError('invalid', 'disk must be 64, 128 or 256 GB', { field: 'diskGiB' });
            }
            diskGiB = disk;
        } else if (input.diskGiB !== undefined && input.diskGiB !== null) {
            // A Container has no disk field (FR-2): saying one is a mistake, not a hint.
            throw fleetMachineError('invalid', 'a Container takes no disk size', { field: 'diskGiB' });
        }
        const ownerNodes = await this.nodes.findByUser(host.userId);
        if (ownerNodes.some((node) => node.name.toLowerCase() === name)) {
            throw fleetMachineError('invalid', `the name ${name} is already used by another computer`, {
                field: 'name',
            });
        }

        // 5: the confirmation.
        const summary = fleetVirtualCreateSummary({ system, hostName: host.name, cpus, memoryGiB, diskGiB });
        this.requireConfirmation('create', name, summary, input.fields ?? { confirm: input.confirm }, {
            // "Choose for me" is resolved by now: a held Agent act runs on THIS host.
            hostNodeId: host.id,
        });

        // The registration first (FR-7), then the durable job.
        const now = new Date();
        const meta: FleetVirtualMeta = {
            systemId: system.id,
            cpus,
            memoryGiB,
            diskGiB,
            image: null,
            phase: 'queued',
            phaseAt: now.toISOString(),
            state: 'creating',
            stateAt: now.toISOString(),
            error: null,
            activated: system.kind === 'vm' ? false : null,
            createJobId: null,
            lastControlJobId: null,
            enrollRequestedAt: null,
        };
        const child = await this.nodes.create({
            userId: host.userId,
            organizationId: host.organizationId ?? null,
            name,
            kind: 'node',
            status: 'enrolling',
            // A throwaway, already-expired credential: nothing can enrol with it.
            // The guest's real token is minted when it is ready (R-35).
            enrollmentTokenHash: sha256Hex(randomBytes(32).toString('base64url')),
            credentialIssuedAt: new Date(0),
            capabilities: [],
            origin: 'virtual',
            hostNodeId: host.id,
            virtualKind: system.kind,
            virtualMeta: meta,
        });

        const payload: FleetVmCreatePayload = {
            childNodeId: child.id,
            hostNodeId: host.id,
            name,
            systemId: system.id,
            kind: system.kind,
            cpus,
            memoryGiB,
            diskGiB,
        };
        let job;
        try {
            job = await this.jobs.enqueue({
                userId: host.userId,
                organizationId: host.organizationId ?? null,
                kind: 'vm-create',
                payload: payload as unknown as Record<string, unknown>,
                requiredCapabilities: jobCapabilities(system),
                maxAttempts: CREATE_MAX_ATTEMPTS,
                idempotencyKey: `vm-create:${child.id}`,
            });
        } catch (error) {
            // No job, no machine: take the registration back so nothing half-made stays.
            await this.nodes.delete(child.id).catch(() => undefined);
            throw error;
        }
        await this.nodes.update(child.id, { virtualMeta: { ...meta, createJobId: job.id } });

        await this.record('node.vm.create', caller, host, child.id, {
            targetName: name,
            requestedBy,
            confirmationClass: FLEET_VIRTUAL_ACTION_CLASS.create,
            outcome: 'ok',
            hostNodeId: host.id,
            systemId: system.id,
            kind: system.kind,
            cpus,
            memoryGiB,
            diskGiB,
            jobId: job.id,
        });
        return { childNodeId: child.id, operationId: job.id, jobId: job.id, hostNodeId: host.id };
    }

    // ─── Power and destroy (FR-26 – FR-28) ───────────────────────────────

    async power(
        caller: FleetMachineCaller,
        hostNodeId: string,
        childNodeId: string,
        action: unknown,
        fields?: FleetActionConfirmFields | null,
    ): Promise<FleetVirtualOperationResponse> {
        this.requireEnabled();
        if (!isFleetVirtualPowerAction(action)) {
            throw fleetMachineError('invalid', 'action must be start or stop', { field: 'action' });
        }
        const { host, child } = await this.resolveChildForAct(caller, hostNodeId, childNodeId, `node.vm.${action}`);
        const kind = child.virtualKind === 'vm' ? 'vm' : 'container';
        const state = deriveVirtualState(child);
        if (action === 'start' && (state === 'running' || state === 'starting')) {
            throw fleetMachineError('busy', `${child.name} is already running`, { state });
        }
        if (action === 'stop' && (state === 'stopped' || state === 'stopping')) {
            throw fleetMachineError('busy', `${child.name} is already stopped`, { state });
        }
        if (state === 'creating' || state === 'installing' || state === 'enrolling' || state === 'destroying') {
            throw fleetMachineError('busy', `${child.name} is still being ${state === 'destroying' ? 'destroyed' : 'created'}`, {
                state,
            });
        }
        const baseClass = FLEET_VIRTUAL_ACTION_CLASS[action];
        this.requireConfirmation(action, child.name, action === 'stop' ? stopSummary(kind, child.name) : `Start ${child.name}?`, fields);
        const job = await this.enqueueControl(host, child, action);
        await this.patchMeta(child, { state: action === 'start' ? 'starting' : 'stopping', lastControlJobId: job.id });
        await this.record(`node.vm.${action}` as FleetAuditAction, caller, host, child.id, {
            targetName: child.name,
            requestedBy: describeFleetMachineCaller(caller),
            confirmationClass: baseClass,
            outcome: 'ok',
            hostNodeId: host.id,
            jobId: job.id,
        });
        return { operationId: job.id, jobId: job.id };
    }

    async destroy(
        caller: FleetMachineCaller,
        hostNodeId: string,
        childNodeId: string,
        fields?: FleetActionConfirmFields | null,
    ): Promise<FleetVirtualOperationResponse> {
        this.requireEnabled();
        const { host, child } = await this.resolveChildForAct(caller, hostNodeId, childNodeId, 'node.vm.destroy');
        const kind = child.virtualKind === 'vm' ? 'vm' : 'container';
        const state = deriveVirtualState(child);
        if (state === 'destroying') {
            throw fleetMachineError('busy', `${child.name} is already being destroyed`, { state });
        }
        // Busy first (U13): a person never types the name only to be told to wait.
        await this.assertNotWorking(child, caller, host);
        this.requireConfirmation('destroy', child.name, destroySummary(kind, child.name, host.name), fields);
        // A create still queued or running for it is cancelled first: the destroy wins.
        const meta = normalizeVirtualMeta(child.virtualMeta);
        if (meta?.createJobId) await this.jobs.cancel(meta.createJobId).catch(() => undefined);
        const job = await this.enqueueControl(host, child, 'destroy');
        await this.patchMeta(child, { state: 'destroying', lastControlJobId: job.id });
        await this.record('node.vm.destroy', caller, host, child.id, {
            targetName: child.name,
            requestedBy: describeFleetMachineCaller(caller),
            confirmationClass: FLEET_VIRTUAL_ACTION_CLASS.destroy,
            outcome: 'ok',
            hostNodeId: host.id,
            jobId: job.id,
        });
        return { operationId: job.id, jobId: job.id };
    }

    /**
     * Retry enrolment (U10, FR-24): the guest is built but never heartbeated
     * (its token expired, the link dropped at the wrong moment). The host
     * re-requests a token for it and hands it over again — nothing is rebuilt.
     */
    async retryEnrollment(
        caller: FleetMachineCaller,
        hostNodeId: string,
        childNodeId: string,
    ): Promise<FleetVirtualOperationResponse> {
        this.requireEnabled();
        const { host, child } = await this.resolveChildForAct(caller, hostNodeId, childNodeId, 'node.vm.start');
        if (child.status !== 'enrolling') {
            throw fleetMachineError('busy', `${child.name} is already enrolled`, { status: child.status });
        }
        const job = await this.enqueueControl(host, child, 'retry-enrollment');
        await this.patchMeta(child, { state: 'creating', phase: 'enrolling', lastControlJobId: job.id, enrollRequestedAt: null });
        await this.record('node.vm.start', caller, host, child.id, {
            targetName: child.name,
            requestedBy: describeFleetMachineCaller(caller),
            confirmationClass: 'plain',
            outcome: 'ok',
            hostNodeId: host.id,
            jobId: job.id,
            retryEnrollment: true,
        });
        return { operationId: job.id, jobId: job.id };
    }

    /**
     * Copy password (P2, spec S7, FR-20, FR-21, U16) — the ONE way a Windows
     * VM's generated password leaves its host: owner only (an Organization
     * admin in the host's `machines` audience is still refused, the spec §8b
     * default), never an Agent, `confirm`-class, refused under the kill switch,
     * read from the host's keychain over the node link and handed back once.
     * The audit row records `revealed: true` and who — never the value — and
     * nothing here logs, stores or caches it.
     */
    async revealPassword(
        caller: FleetMachineCaller,
        hostNodeId: string,
        childNodeId: string,
        fields?: FleetActionConfirmFields | null,
    ): Promise<FleetVirtualPasswordRevealResponse> {
        this.requireEnabled();
        if (caller.kind !== 'user') {
            throw fleetMachineError('permission_denied', 'an Agent never sees a computer password');
        }
        const { node: host } = await this.resolve(hostNodeId, caller.userId, 'view');
        const child = childNodeId ? await this.nodes.findById(childNodeId) : null;
        if (!child || child.hostNodeId !== host.id) {
            throw fleetMachineError('not_found', 'no such virtual computer on this computer');
        }
        if (child.userId !== caller.userId || host.userId !== caller.userId) {
            await this.record('node.vm.password.reveal', caller, host, child.id, {
                targetName: child.name,
                requestedBy: describeFleetMachineCaller(caller),
                outcome: 'refused',
                code: 'permission_denied',
                hostNodeId: host.id,
            });
            throw fleetMachineError('permission_denied', `only ${host.name}'s owner can reveal it`, { ownerOnly: true });
        }
        if (child.virtualKind !== 'vm') {
            throw fleetMachineError('unsupported_on_node', 'a Container has no generated password');
        }
        if (await this.isStopped()) throw fleetMachineError('kill_switch', 'clear it under Settings → Fleet');
        this.requireConfirmation(
            'reveal',
            child.name,
            `Reveal the password of ${child.name}? It was generated on ${host.name} and is kept only there; revealing it is recorded in the audit log.`,
            fields,
        );
        if (!this.link) throw fleetMachineError('unreachable', 'this deployment cannot reach computers');
        let password: string | null = null;
        try {
            const reply = await this.link.request({
                nodeId: host.id,
                verb: 'vm.password.reveal',
                caller,
                actionFamily: 'machines',
                stateChanging: true,
                target: child.id,
                params: { childId: child.id },
                timeoutMs: 15_000,
                // Never an operation: the value must not be parked in an operation record.
                awaitOperationMs: 0,
            });
            const result = reply.result as { password?: unknown } | undefined;
            if (reply.operationId === undefined && result && typeof result.password === 'string' && result.password) {
                password = result.password;
            }
        } catch (error) {
            const refusal = readFleetMachineError(error);
            await this.record('node.vm.password.reveal', caller, host, child.id, {
                targetName: child.name,
                requestedBy: describeFleetMachineCaller(caller),
                confirmationClass: FLEET_VIRTUAL_ACTION_CLASS.reveal,
                outcome: refusal?.code === 'operation_failed' ? 'failed' : 'refused',
                code: refusal?.code ?? 'internal',
                hostNodeId: host.id,
            });
            throw error;
        }
        if (!password) {
            throw fleetMachineError('operation_failed', `${host.name} did not hand the password over`);
        }
        await this.record('node.vm.password.reveal', caller, host, child.id, {
            targetName: child.name,
            requestedBy: describeFleetMachineCaller(caller),
            confirmationClass: FLEET_VIRTUAL_ACTION_CLASS.reveal,
            outcome: 'ok',
            revealed: true,
            hostNodeId: host.id,
        });
        return { password, expiresInSec: FLEET_VIRTUAL_PASSWORD_REVEAL_SEC };
    }

    // ─── Node-facing (host credential) ───────────────────────────────────

    /**
     * Mint the guest's one-time enrolment token (R-35, FR-14, FR-24) — asked
     * by the HOST, with its own credential, for a `vm-*` job it holds. The
     * same posture as `push-credential`: an unknown node, a bad secret, a job
     * this node does not hold, a terminal job, or a child that is not this
     * job's, enrolling, on this host — all answer null (one undifferentiated
     * 401 at the edge); a stale lease generation throws the 409 the node knows.
     *
     * The token replaces the row's credential hash (the throwaway one, or an
     * earlier expired token) and is returned exactly once. Never logged.
     */
    async mintEnrollToken(
        childNodeId: string,
        request: { nodeId: unknown; secret: unknown; jobId: unknown; leaseGeneration?: unknown },
    ): Promise<FleetVirtualEnrollTokenResponse | null> {
        if (!config.fleet.isVirtualEnabled()) return null;
        const held = await this.authorizeHostJob(childNodeId, request);
        if (!held) return null;
        const { child } = held;
        if (child.status !== 'enrolling') return null;
        const token = randomBytes(32).toString('base64url');
        const now = new Date();
        const meta = normalizeVirtualMeta(child.virtualMeta);
        await this.nodes.update(child.id, {
            enrollmentTokenHash: sha256Hex(token),
            credentialIssuedAt: now,
            ...(meta
                ? {
                      virtualMeta: {
                          ...meta,
                          phase: 'enrolling',
                          phaseAt: now.toISOString(),
                          enrollRequestedAt: now.toISOString(),
                      },
                  }
                : {}),
        });
        return { token, expiresInSec: Math.floor(config.fleet.getEnrollmentTokenTtlMs() / 1000) };
    }

    /**
     * A progress report from the host while it builds or controls a child
     * (FR-13, U8, lane decision 5): the phase, the machine state, the first
     * line of a failure, the image it used. Stored on the child's
     * `virtualMeta`. A destroy that reports `gone` removes the registration —
     * the machine and its disk are already gone — and keeps the job history
     * (FR-28). Same authorisation as {@link mintEnrollToken}.
     */
    async reportProgress(childNodeId: string, report: Partial<FleetVirtualProgressReport>): Promise<boolean> {
        if (!config.fleet.isVirtualEnabled()) return false;
        const held = await this.authorizeHostJob(childNodeId, report);
        if (!held) return false;
        const { child, job } = held;
        const meta = normalizeVirtualMeta(child.virtualMeta);
        if (!meta) return false;
        const now = new Date().toISOString();
        const next: FleetVirtualMeta = { ...meta };
        if (isFleetVirtualPhase(report.phase)) {
            next.phase = report.phase;
            next.phaseAt = now;
        }
        if (isFleetVirtualState(report.state)) {
            next.state = report.state;
            next.stateAt = now;
        }
        if (typeof report.error === 'string' && report.error.trim()) {
            next.error = report.error.trim().split(/\r?\n/)[0].slice(0, 300);
        } else if (report.error === null) {
            next.error = null;
        }
        if (report.image && typeof report.image === 'object' && typeof report.image.ref === 'string') {
            next.image = {
                ref: report.image.ref.slice(0, 300),
                digest: typeof report.image.digest === 'string' ? report.image.digest.slice(0, 100) : null,
            };
        }
        if (typeof report.activated === 'boolean') next.activated = report.activated;
        if (report.viewerPort === null) next.viewerPort = null;
        else if (typeof report.viewerPort === 'number' && Number.isInteger(report.viewerPort)) {
            if (report.viewerPort > 0 && report.viewerPort < 65536) next.viewerPort = report.viewerPort;
        }
        const controlAction = job.kind === 'vm-control' ? (job.payload?.action as FleetVmControlAction | undefined) : undefined;
        if (controlAction === 'destroy' && next.state === 'gone') {
            await this.nodes.delete(child.id);
            return true;
        }
        await this.nodes.update(child.id, { virtualMeta: next });
        return true;
    }

    // ─── Reconcile (FR-30, U10) ──────────────────────────────────────────

    /**
     * One sweep (plan §10, every 5 minutes): for each host with children that
     * is online, `vm.list` over its link and mark a child whose machine is gone
     * (`gone` — it may then be removed) or record running / stopped; and mark an
     * enrolling child whose guest asked for its token more than 20 minutes ago
     * `not-enrolled`. Writes only when something changed. Best-effort per host.
     */
    async reconcile(): Promise<{ hosts: number; changed: number }> {
        if (!config.fleet.isVirtualEnabled()) return { hosts: 0, changed: 0 };
        const children = await this.nodes.findVirtualChildren();
        const byHost = groupByHost(children);
        const cutoff = Date.now() - config.fleet.getNodeOfflineAfterMs();
        let changed = 0;
        let hosts = 0;
        for (const [hostId, own] of byHost) {
            const host = await this.nodes.findById(hostId);
            for (const child of own) {
                if (deriveVirtualState(child) === 'not-enrolled' && normalizeVirtualMeta(child.virtualMeta)?.state !== 'not-enrolled') {
                    if (await this.patchMeta(child, { state: 'not-enrolled' })) changed += 1;
                }
            }
            if (!host || !this.link || !isHostOnline(host, cutoff)) continue;
            hosts += 1;
            let listed: FleetVirtualListResult;
            try {
                const reply = await this.link.request({
                    nodeId: host.id,
                    verb: 'vm.list',
                    caller: { kind: 'user', userId: host.userId },
                    actionFamily: 'view',
                    stateChanging: false,
                    params: {},
                    timeoutMs: 20_000,
                    awaitOperationMs: 20_000,
                });
                if (reply.operationId !== undefined) continue;
                listed = reply.result as FleetVirtualListResult;
            } catch (error) {
                this.logger.debug(
                    `virtual reconcile: ${host.id} could not be read: ${error instanceof Error ? error.message : String(error)}`,
                );
                continue;
            }
            if (!listed || listed.docker !== true || !Array.isArray(listed.machines)) continue;
            const facts = new Map(listed.machines.map((machine) => [machine.childNodeId, machine]));
            for (const child of own) {
                const meta = normalizeVirtualMeta(child.virtualMeta);
                if (!meta || meta.state === 'destroying') continue;
                const fact = facts.get(child.id);
                const building = child.status === 'enrolling' && meta.state === 'creating';
                const next = !fact
                    ? building
                        ? null
                        : 'gone'
                    : fact.state === 'running'
                      ? 'running'
                      : fact.state === 'stopped'
                        ? 'stopped'
                        : fact.state === 'gone'
                          ? 'gone'
                          : null;
                if (next && next !== meta.state && !(next === 'running' && meta.state === 'stopping')) {
                    if (await this.patchMeta(child, { state: next })) changed += 1;
                }
            }
        }
        return { hosts, changed };
    }

    // ─── Shared ───────────────────────────────────────────────────────────

    private requireEnabled(): void {
        if (!config.fleet.isVirtualEnabled()) {
            throw fleetMachineError('not_found', 'virtual computers are not switched on in this deployment');
        }
    }

    private resolveSystemForOptions(systemId: unknown): FleetVirtualSystem {
        const offered = fleetVirtualOfferedSystems();
        return offered.find((system) => system.id === systemId) ?? offered[0];
    }

    private resolveSystemForCreate(systemId: unknown): FleetVirtualSystem {
        const system = fleetVirtualSystem(systemId);
        if (!system) {
            throw fleetMachineError('invalid', 'choose one of the listed systems', { field: 'systemId' });
        }
        if (system.kind === 'vm' && !FLEET_VIRTUAL_VM_SYSTEMS_SHIPPED) {
            throw fleetMachineError(
                'unsupported_on_node',
                'Windows VMs are not available yet; Containers are',
                { field: 'systemId' },
            );
        }
        return system;
    }

    /** Existence, the kill switch and the host's eligibility, for a create. `auto` / null picks one. */
    private async resolveHostForCreate(
        caller: FleetMachineCaller,
        requested: string | null,
        system: FleetVirtualSystem,
    ): Promise<FleetNode> {
        const userId = fleetMachineCallerUserId(caller);
        if (!requested || requested === 'auto') {
            await this.requireNotStopped();
            const options = await this.options(caller, system.id);
            const picked = options.autoPickNodeId;
            if (!picked) {
                const reasons = options.hosts.map((host) => host.reason);
                throw fleetMachineError(
                    reasons.includes('permission-denied') && reasons.every((r) => r === 'permission-denied')
                        ? 'permission_denied'
                        : 'unsupported_on_node',
                    'No computer in your fleet can host this yet — a Linux or macOS computer with Docker, started with --manage',
                    { hosts: options.hosts.map((host) => ({ name: host.name, reason: host.reason })) },
                );
            }
            requested = picked;
        }
        const { node: host, role } = await this.resolve(requested, userId, 'view');
        await this.requireNotStopped();
        const own = await this.nodes.findByHostNodeIds([host.id]);
        const reason = hostEligibility({
            host,
            system,
            childCount: own.length,
            offlineCutoffMs: Date.now() - config.fleet.getNodeOfflineAfterMs(),
            allowed: await this.allows(host, role, userId),
        });
        if (reason) {
            const hostOfHost = host.hostNodeId ? (await this.nodes.findById(host.hostNodeId))?.name ?? null : null;
            const code = hostReasonErrorCode(reason);
            const hint = hostReasonHint(reason, host, { hostOfHost, lastSeen: describeAgo(host.lastHeartbeatAt) });
            await this.record('node.vm.create', caller, host, null, {
                requestedBy: describeFleetMachineCaller(caller),
                confirmationClass: FLEET_VIRTUAL_ACTION_CLASS.create,
                outcome: 'refused',
                code,
                reason,
                hostNodeId: host.id,
                systemId: system.id,
            });
            throw fleetMachineError(code, hint, { reason, hostNodeId: host.id });
        }
        return host;
    }

    /** The child and its host for an act: existence, the host's `machines` audience, kill switch, consent, reachability. */
    private async resolveChildForAct(
        caller: FleetMachineCaller,
        hostNodeId: string,
        childNodeId: string,
        auditAction: string,
    ): Promise<{ host: FleetNode; child: FleetNode }> {
        const userId = fleetMachineCallerUserId(caller);
        const { node: host, role } = await this.resolve(hostNodeId, userId, 'view');
        const child = childNodeId ? await this.nodes.findById(childNodeId) : null;
        if (!child || child.hostNodeId !== host.id) {
            throw fleetMachineError('not_found', 'no such virtual computer on this computer');
        }
        const refuse = async (code: FleetLinkErrorCode, hint: string, details?: Record<string, unknown>) => {
            await this.record(auditAction as FleetAuditAction, caller, host, child.id, {
                targetName: child.name,
                requestedBy: describeFleetMachineCaller(caller),
                outcome: 'refused',
                code,
                hostNodeId: host.id,
            });
            return fleetMachineError(code, hint, details);
        };
        if (await this.isStopped()) throw await refuse('kill_switch', 'clear it under Settings → Fleet');
        if (!(await this.allows(host, role, userId))) {
            throw await refuse('permission_denied', `Only the owner of ${host.name} can change computers on it`, {
                family: 'machines',
            });
        }
        const reason = hostEligibility({
            host,
            system: { kind: child.virtualKind === 'vm' ? 'vm' : 'container', arch: ['x64', 'arm64'] },
            // The limit does not apply to acting on an existing child.
            childCount: 0,
            offlineCutoffMs: Date.now() - config.fleet.getNodeOfflineAfterMs(),
            allowed: true,
        });
        if (reason) {
            throw await refuse(
                hostReasonErrorCode(reason),
                hostReasonHint(reason, host, { lastSeen: describeAgo(host.lastHeartbeatAt) }),
                { reason },
            );
        }
        return { host, child };
    }

    /** Destroy is refused `busy` while a Run or an owner Session is live on the child (U13, FR-28). */
    private async assertNotWorking(child: FleetNode, caller: FleetMachineCaller, host: FleetNode): Promise<void> {
        const load = (await this.jobs.loadByNodeForUser(child.userId).catch(() => ({})))[child.id];
        const live = this.sessions ? await this.sessions.findLiveForNode(child.id).catch(() => []) : [];
        if ((load && load.activeJobCount > 0) || live.length > 0) {
            const hint = `Something is working on ${child.name} right now; end the session or wait`;
            await this.record('node.vm.destroy', caller, host, child.id, {
                targetName: child.name,
                requestedBy: describeFleetMachineCaller(caller),
                outcome: 'refused',
                code: 'busy',
                hostNodeId: host.id,
            });
            throw fleetMachineError('busy', hint, {
                activeJobs: load?.activeJobCount ?? 0,
                liveSessions: live.length,
            });
        }
    }

    private requireConfirmation(
        act: keyof typeof FLEET_VIRTUAL_ACTION_CLASS,
        target: string,
        summary: string,
        fields: FleetActionConfirmFields | null | undefined,
        extra: Record<string, unknown> = {},
    ): void {
        const baseClass: FleetConfirmationClass = FLEET_VIRTUAL_ACTION_CLASS[act];
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

    private async enqueueControl(host: FleetNode, child: FleetNode, action: FleetVmControlAction) {
        const meta = normalizeVirtualMeta(child.virtualMeta);
        const system = fleetVirtualSystem(meta?.systemId) ?? fleetVirtualOfferedSystems()[0];
        const payload: FleetVmControlPayload = {
            childNodeId: child.id,
            hostNodeId: host.id,
            name: child.name,
            kind: child.virtualKind === 'vm' ? 'vm' : 'container',
            systemId: system.id,
            action,
        };
        return this.jobs.enqueue({
            userId: host.userId,
            organizationId: host.organizationId ?? null,
            kind: 'vm-control',
            payload: payload as unknown as Record<string, unknown>,
            requiredCapabilities: jobCapabilities(system),
            maxAttempts: CONTROL_MAX_ATTEMPTS,
        });
    }

    /** Merge into the child's meta; false when the row has none (nothing to write). */
    private async patchMeta(child: FleetNode, patch: Partial<FleetVirtualMeta>): Promise<boolean> {
        const meta = normalizeVirtualMeta(child.virtualMeta);
        if (!meta) return false;
        const now = new Date().toISOString();
        const next: FleetVirtualMeta = { ...meta, ...patch };
        if (patch.state !== undefined) next.stateAt = now;
        if (patch.phase !== undefined) next.phaseAt = now;
        await this.nodes.update(child.id, { virtualMeta: next });
        child.virtualMeta = next;
        return true;
    }

    /** The host's job, held by the calling host, for this child — or null (the edge's 401). */
    private async authorizeHostJob(
        childNodeId: string,
        request: { nodeId?: unknown; secret?: unknown; jobId?: unknown; leaseGeneration?: unknown },
    ): Promise<{ child: FleetNode; job: FleetJob } | null> {
        if (typeof request.jobId !== 'string' || !request.jobId) return null;
        const held = await this.jobs.authorizeRunSecretRequest({
            nodeId: request.nodeId,
            secret: request.secret,
            jobId: request.jobId,
            leaseGeneration: request.leaseGeneration,
        });
        if (!held) return null;
        const job = await this.jobRows.findById(held.jobId);
        if (!job || (job.kind !== 'vm-create' && job.kind !== 'vm-control')) return null;
        const payload = (job.payload ?? {}) as Partial<FleetVmCreatePayload>;
        if (payload.childNodeId !== childNodeId || payload.hostNodeId !== held.nodeId) return null;
        const child = await this.nodes.findById(childNodeId);
        if (!child || child.hostNodeId !== held.nodeId || child.origin !== 'virtual') return null;
        return { child, job };
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

    private async roleOf(node: FleetNode, userId: string): Promise<FleetViewerRole> {
        if (node.userId === userId) return 'owner';
        if (!this.access) return 'stranger';
        return this.access.roleFor(node, userId);
    }

    /** The caller's `machines` audience on a host (CONTRACTS §2.1; the owner always). */
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

    private async requireNotStopped(): Promise<void> {
        if (await this.isStopped()) throw fleetMachineError('kill_switch', 'clear it under Settings → Fleet');
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
        host: FleetNode,
        childNodeId: string | null,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action,
            actorUserId: fleetMachineCallerUserId(caller),
            ownerUserId: host.userId,
            nodeId: childNodeId ?? host.id,
            details: { family: 'machines', target: childNodeId ?? host.id, ...details },
        });
    }
}

function groupByHost(children: readonly FleetNode[]): Map<string, FleetNode[]> {
    const out = new Map<string, FleetNode[]>();
    for (const child of children) {
        if (!child.hostNodeId) continue;
        const list = out.get(child.hostNodeId) ?? [];
        list.push(child);
        out.set(child.hostNodeId, list);
    }
    return out;
}

function metaOf(child: FleetNode): { virtualMeta: FleetVirtualMeta | null } {
    return { virtualMeta: normalizeVirtualMeta(child.virtualMeta) };
}

function jobCapabilities(system: FleetVirtualSystem): string[] {
    // A Windows VM also needs KVM and an installer image the host's operator configured (P2).
    return system.kind === 'vm'
        ? [...BASE_JOB_CAPABILITIES, FLEET_KVM_CAPABILITY, FLEET_VIRTUAL_WINDOWS_CAPABILITY]
        : [...BASE_JOB_CAPABILITIES];
}

/** "2 h", "12 min" since an instant, or null. */
function describeAgo(at: Date | string | null | undefined): string | null {
    const ms = at ? Date.now() - new Date(at).getTime() : NaN;
    if (!Number.isFinite(ms) || ms < 0) return null;
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${Math.max(1, minutes)} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.round(hours / 24)} days`;
}
