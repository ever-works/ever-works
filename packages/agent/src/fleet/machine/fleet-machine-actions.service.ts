import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    isFleetContainerShell,
    type FleetComposeAction,
    type FleetComposeDescription,
    type FleetComposeListResult,
    type FleetContainerExecResult,
    type FleetContainerShell,
    type FleetContainerShellsResult,
    FLEET_CONTAINER_ACTION_BASE_CLASS,
    fleetRunPreview,
    validateFleetRunRequest,
    type FleetRunValidation,
    type FleetContainerAction,
    type FleetContainersListResult,
    type FleetImagePruneResult,
    type FleetImagePullResult,
    type FleetImageRemoveResult,
    type FleetImagesListResult,
    fleetEffectiveConfirmationClass,
    fleetMissingConfirmation,
    FLEET_SERVICE_ACTION_BASE_CLASS,
    asFleetBlastRadius,
    isFleetServiceManager,
    makeFleetLinkError,
    type FleetActionConfirmFields,
    type FleetAuditAction,
    type FleetBlastRadius,
    type FleetConfirmationClass,
    type FleetConfirmationRequiredDetails,
    type FleetLinkError,
    type FleetMachineActionFamily,
    type FleetMachineActionOutcome,
    type FleetOperationRef,
    type FleetProcessesListResult,
    type FleetProcessSignal,
    type FleetProcessSignalResult,
    type FleetProcessSort,
    type FleetServiceAction,
    type FleetServiceActionResult,
    type FleetServiceManager,
    type FleetServiceScope,
    type FleetServicesListResult,
} from '@ever-works/contracts';
import { config } from '../../config';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetSessionService } from '../sessions/fleet-session.service';
import { fleetMachineError, FleetMachineException, readFleetMachineError } from './fleet-machine.errors';
import {
    describeFleetMachineCaller,
    FLEET_MACHINE_NODE_PORT,
    fleetMachineCallerUserId,
    type FleetMachineCaller,
    type FleetMachineNodeFacts,
    type FleetMachineNodePort,
    type FleetMachineNodeReply,
} from './fleet-machine-node.port';

/**
 * Machine actions (FL-09) — the platform half of Services, Processes (P1),
 * Docker (P2) and Compose (P3): every list and every act on a machine goes
 * through here, for the web, the Agent tools, MCP and the CLI alike.
 *
 * An act runs in this order, and the first refusal is the answer:
 *
 *  1. **the link's gate** (`FLEET_MACHINE_NODE_PORT.authorize`): existence
 *     (a stranger reads `not_found`), the kill switch (`kill_switch`), the
 *     `manage` consent (`consent_missing` with the command to run on the
 *     machine), the action family's audience (`permission_denied` naming the
 *     family) — before anything about the act is said back;
 *  2. **the confirmation** (CONTRACTS §2.2): the act's base class against the
 *     request's `confirm` / `confirmName` — `confirmation_required` with the
 *     class and the dialog's summary otherwise;
 *  3. **the machine**: the request goes to the node with
 *     `acknowledgeBlastRadius`, and the node — which alone knows what the
 *     service carries — refuses an unacknowledged blast radius with
 *     `confirmation_required` and the sentence, applies the root rule
 *     (`root_required` with the exact command as the hint), and refuses its
 *     own process tree (`invalid`).
 *
 * Every act writes ONE `fleet_audit` row with the CONTRACTS §7 name —
 * `outcome: ok | refused | failed`, the confirmation class it ran under, the
 * blast-radius kind and whether it ran as root; never a value, a command line
 * or output (FR-18). A confirmation prompt is not an act and writes none, and
 * neither does a caller who may not even see the machine (`not_found`).
 */

/** How long a list waits for the machine (a Windows service read takes a few seconds). */
export const FLEET_MACHINE_LIST_TIMEOUT_MS = 30_000;

/** How long the link waits for an act's first answer (a reply, or the node's operation id). */
export const FLEET_MACHINE_ACTION_TIMEOUT_MS = 70_000;

/** How long an act that became an operation is waited for before it is reported as one (spec §6: ≤ 10 s P95). */
export const FLEET_MACHINE_ACTION_AWAIT_MS = 10_000;

export interface FleetServiceActionInput {
    name: string;
    action: FleetServiceAction;
    scope?: FleetServiceScope;
    manager?: FleetServiceManager;
    fields?: FleetActionConfirmFields | null;
}

export interface FleetProcessSignalInput {
    pid: number;
    signal: FleetProcessSignal;
    fields?: FleetActionConfirmFields | null;
}

/** What one act needs the shared runner to know. */
interface ActSpec {
    nodeId: string;
    caller: FleetMachineCaller;
    verb: string;
    family: FleetMachineActionFamily;
    auditAction: FleetAuditAction;
    target: string;
    baseClass: FleetConfirmationClass;
    /** The dialog title with the machine's name ("Restart nginx on build-01?"). */
    summary: (machine: string) => string;
    params: Record<string, unknown>;
    fields?: FleetActionConfirmFields | null;
    /** What `confirmName` must equal for `confirm-destructive` (defaults to {@link target}). */
    confirmTarget?: string;
    /** Extra audit facts (scope, manager, signal, env var NAMES) — never a value. */
    auditDetails?: Record<string, unknown>;
    /** Shown in `confirmation_required` (a `docker run` command line with values masked). */
    preview?: string;
    timeoutMs?: number;
    /** 0 for an act that is ALWAYS an operation (a pull, Compose up): answer its id at once. */
    awaitOperationMs?: number;
    /** True for a result the node did NOT act on (a prune with nothing to remove, U15): no audit row. */
    noOpResult?: (result: Record<string, unknown>) => boolean;
}

/** The outcome an error code is audited as: `failed` when the machine ran it and it failed. */
export function auditOutcomeOf(code: FleetLinkError['code']): FleetMachineActionOutcome {
    return code === 'operation_failed' || code === 'internal' ? 'failed' : 'refused';
}

@Injectable()
export class FleetMachineActionsService {
    private readonly logger = new Logger(FleetMachineActionsService.name);

    constructor(
        @Optional() @Inject(FLEET_MACHINE_NODE_PORT) private readonly node?: FleetMachineNodePort,
        @Optional() private readonly audit?: FleetAuditService,
        // Shell inside a container (FL-09 P3): an owner Session (FL-04). @Optional(),
        // appended LAST: unbound, "Shell inside" answers unsupported_on_node.
        @Optional() private readonly sessions?: FleetSessionService,
    ) {}

    // ─── Services (P1) ────────────────────────────────────────────────────

    async listServices(
        nodeId: string,
        caller: FleetMachineCaller,
        query: { scope?: FleetServiceScope | 'all'; find?: string } = {},
    ): Promise<FleetServicesListResult> {
        const params: Record<string, unknown> = { scope: query.scope ?? 'all' };
        if (query.find) params.find = query.find.slice(0, 200);
        return this.list<FleetServicesListResult>(nodeId, caller, 'services.list', params);
    }

    async serviceAction(
        nodeId: string,
        caller: FleetMachineCaller,
        input: FleetServiceActionInput,
    ): Promise<FleetServiceActionResult | FleetOperationRef> {
        const verbWord = `${input.action[0].toUpperCase()}${input.action.slice(1)}`;
        const params: Record<string, unknown> = {
            name: input.name,
            action: input.action,
            scope: input.scope ?? 'system',
        };
        if (input.manager && isFleetServiceManager(input.manager)) params.manager = input.manager;
        return this.act<FleetServiceActionResult>({
            nodeId,
            caller,
            verb: 'services.action',
            family: 'services',
            auditAction: `node.service.${input.action}` as FleetAuditAction,
            target: input.name,
            baseClass: FLEET_SERVICE_ACTION_BASE_CLASS[input.action],
            summary: (machine) =>
                input.action === 'enable'
                    ? `Start ${input.name} at boot on ${machine}?`
                    : input.action === 'disable'
                      ? `Stop starting ${input.name} at boot on ${machine}?`
                      : `${verbWord} ${input.name} on ${machine}?`,
            params,
            fields: input.fields,
            auditDetails: { scope: params.scope, ...(params.manager ? { manager: params.manager } : {}) },
        });
    }

    // ─── Processes (P1) ───────────────────────────────────────────────────

    async listProcesses(
        nodeId: string,
        caller: FleetMachineCaller,
        query: { sort?: FleetProcessSort; find?: string } = {},
    ): Promise<FleetProcessesListResult> {
        const params: Record<string, unknown> = { sort: query.sort === 'mem' ? 'mem' : 'cpu' };
        if (query.find) params.find = query.find.slice(0, 200);
        return this.list<FleetProcessesListResult>(nodeId, caller, 'processes.list', params);
    }

    async signalProcess(
        nodeId: string,
        caller: FleetMachineCaller,
        input: FleetProcessSignalInput,
    ): Promise<FleetProcessSignalResult | FleetOperationRef> {
        const name = input.signal === 'KILL' ? 'SIGKILL' : 'SIGTERM';
        return this.act<FleetProcessSignalResult>({
            nodeId,
            caller,
            verb: 'processes.signal',
            family: 'processes',
            auditAction: 'node.process.signal',
            target: String(input.pid),
            baseClass: 'confirm',
            summary: (machine) =>
                input.signal === 'KILL'
                    ? `Send SIGKILL to process ${input.pid} on ${machine}? It cannot save its work.`
                    : `Send SIGTERM to process ${input.pid} on ${machine}?`,
            params: { pid: input.pid, signal: input.signal },
            fields: input.fields,
            auditDetails: { signal: name },
        });
    }

    // ─── Docker (P2) ───────────────────────────────────────────────────────

    async listContainers(nodeId: string, caller: FleetMachineCaller): Promise<FleetContainersListResult> {
        return this.list<FleetContainersListResult>(nodeId, caller, 'docker.containers', {});
    }

    async listImages(nodeId: string, caller: FleetMachineCaller): Promise<FleetImagesListResult> {
        return this.list<FleetImagesListResult>(nodeId, caller, 'docker.images', {});
    }

    /**
     * Start / stop / restart / remove one container. Remove is
     * `confirm-destructive`: `confirmName` must be the container's NAME, which
     * the machine is asked for first (a caller may name it by id).
     */
    async containerAction(
        nodeId: string,
        caller: FleetMachineCaller,
        input: { container: string; action: FleetContainerAction; fields?: FleetActionConfirmFields | null },
    ): Promise<Record<string, unknown> | FleetOperationRef> {
        let name = input.container;
        if (input.action === 'remove') {
            const listed = await this.listContainers(nodeId, caller);
            const found = listed.containers.find(
                (row) => row.id === input.container.slice(0, 12) || row.name === input.container,
            );
            if (!found) throw fleetMachineError('not_found', `${input.container} is not a container on this computer`);
            name = found.name;
        }
        const verbWord = `${input.action[0].toUpperCase()}${input.action.slice(1)}`;
        return this.act<Record<string, unknown>>({
            nodeId,
            caller,
            verb: 'docker.container.action',
            family: 'docker',
            auditAction: `node.docker.container.${input.action}` as FleetAuditAction,
            target: input.container,
            confirmTarget: name,
            baseClass: FLEET_CONTAINER_ACTION_BASE_CLASS[input.action],
            summary: (machine) => `${verbWord} ${name} on ${machine}?`,
            params: { id: input.container, action: input.action },
            fields: input.fields,
            auditDetails: { container: name },
        });
    }

    /**
     * Run a container (FR-28): validated here AND on the machine; the audit
     * row and the confirmation carry the image, the name, the ports and the
     * environment variable NAMES — never a value (FR-29). An operation.
     */
    async runContainer(
        nodeId: string,
        caller: FleetMachineCaller,
        input: { request: unknown; fields?: FleetActionConfirmFields | null },
    ): Promise<Record<string, unknown> | FleetOperationRef> {
        const validated = validateFleetRunRequest(input.request);
        if (!validated.ok) {
            // `strictNullChecks: false` here: `!validated.ok` does not narrow the union.
            const refused = validated as Extract<FleetRunValidation, { ok: false }>;
            throw fleetMachineError('invalid', refused.hint, { field: refused.field });
        }
        const request = validated.request;
        return this.act<Record<string, unknown>>({
            nodeId,
            caller,
            verb: 'docker.run',
            family: 'docker',
            auditAction: 'node.docker.container.run',
            target: request.name ?? request.image,
            baseClass: 'confirm',
            summary: (machine) => `Run ${request.image}${request.name ? ` as ${request.name}` : ''} on ${machine}?`,
            preview: fleetRunPreview(request),
            params: { request },
            fields: input.fields,
            awaitOperationMs: 0,
            auditDetails: {
                image: request.image,
                ...(request.name ? { name: request.name } : {}),
                ports: request.ports.map((port) => `${port.host}:${port.container}/${port.proto ?? 'tcp'}`),
                envVarNames: request.env.map((variable) => variable.name),
                volumeTargets: request.volumes.map((volume) => volume.target),
                restart: request.restart,
            },
        });
    }

    async pullImage(
        nodeId: string,
        caller: FleetMachineCaller,
        input: { ref: string; fields?: FleetActionConfirmFields | null },
    ): Promise<FleetImagePullResult | FleetOperationRef> {
        return this.act<FleetImagePullResult>({
            nodeId,
            caller,
            verb: 'docker.image.pull',
            family: 'docker',
            auditAction: 'node.docker.image.pull',
            target: input.ref,
            baseClass: 'confirm',
            summary: (machine) => `Pull ${input.ref} on ${machine}?`,
            params: { ref: input.ref },
            fields: input.fields,
            awaitOperationMs: 0,
        });
    }

    async removeImage(
        nodeId: string,
        caller: FleetMachineCaller,
        input: { id: string; fields?: FleetActionConfirmFields | null },
    ): Promise<FleetImageRemoveResult | FleetOperationRef> {
        return this.act<FleetImageRemoveResult>({
            nodeId,
            caller,
            verb: 'docker.image.remove',
            family: 'docker',
            auditAction: 'node.docker.image.remove',
            target: input.id,
            baseClass: 'confirm',
            summary: (machine) => `Remove image ${input.id} from ${machine}?`,
            params: { id: input.id },
            fields: input.fields,
        });
    }

    /** "Remove unused" (`docker image prune -a`); a prune with nothing to remove runs nothing and writes no row (U15). */
    async pruneImages(
        nodeId: string,
        caller: FleetMachineCaller,
        input: { fields?: FleetActionConfirmFields | null } = {},
    ): Promise<FleetImagePruneResult | FleetOperationRef> {
        return this.act<FleetImagePruneResult>({
            nodeId,
            caller,
            verb: 'docker.image.prune',
            family: 'docker',
            auditAction: 'node.docker.image.prune',
            target: 'unused-images',
            baseClass: 'confirm',
            summary: (machine) => `Remove every unused image from ${machine}?`,
            params: {},
            fields: input.fields,
            awaitOperationMs: 0,
            noOpResult: (result) => result.nothingToDo === true,
        });
    }

    // ─── Compose and Shell inside (P3) ─────────────────────────────────────

    async listComposeProjects(nodeId: string, caller: FleetMachineCaller): Promise<FleetComposeListResult> {
        return this.list<FleetComposeListResult>(nodeId, caller, 'compose.list', {});
    }

    async describeComposeProject(
        nodeId: string,
        caller: FleetMachineCaller,
        project: string,
    ): Promise<FleetComposeDescription> {
        return this.list<FleetComposeDescription>(nodeId, caller, 'compose.describe', { project });
    }

    /** Up / down / restart / pull one project (or one of its services), as an operation (FR-32). Down keeps named volumes (FR-34). */
    async composeAction(
        nodeId: string,
        caller: FleetMachineCaller,
        input: { project: string; action: FleetComposeAction; service?: string; fields?: FleetActionConfirmFields | null },
    ): Promise<Record<string, unknown> | FleetOperationRef> {
        const what = input.service ? `${input.service} of ${input.project}` : input.project;
        return this.act<Record<string, unknown>>({
            nodeId,
            caller,
            verb: 'compose.action',
            family: 'docker',
            auditAction: `node.compose.${input.action}` as FleetAuditAction,
            target: input.project,
            baseClass: 'confirm',
            summary: (machine) =>
                input.action === 'up'
                    ? `Bring ${what} up on ${machine}?`
                    : input.action === 'down'
                      ? `Bring ${input.project} down on ${machine}? Its containers and networks are removed; named volumes are kept.`
                      : input.action === 'restart'
                        ? `Restart ${what} on ${machine}?`
                        : `Pull the images of ${what} on ${machine}?`,
            params: { project: input.project, action: input.action, ...(input.service ? { service: input.service } : {}) },
            fields: input.fields,
            awaitOperationMs: 0,
            auditDetails: { project: input.project, ...(input.service ? { service: input.service } : {}) },
        });
    }

    async containerShells(
        nodeId: string,
        caller: FleetMachineCaller,
        container: string,
    ): Promise<FleetContainerShellsResult> {
        return this.list<FleetContainerShellsResult>(nodeId, caller, 'docker.container.shells', { id: container });
    }

    /**
     * Shell inside a container (FR-35): an ordinary OWNER Session (FL-04)
     * whose process is `docker exec -it <container> <shell>`, titled
     * "Shell · inside <container>". The `docker` family's gate runs first;
     * then one `node.docker.container.exec` row (class `plain`) — and the
     * Session's own `node.session.start` row, written by the session service.
     * A person only: an Agent's shells are Agent sessions (FL-04 FR-51).
     */
    async execInContainer(
        nodeId: string,
        caller: Extract<FleetMachineCaller, { kind: 'user' }>,
        input: { container: string; shell: FleetContainerShell },
    ): Promise<FleetContainerExecResult> {
        const port = this.port();
        const requestedBy = describeFleetMachineCaller(caller);
        const spec: ActSpec = {
            nodeId,
            caller,
            verb: 'docker.container.action',
            family: 'docker',
            auditAction: 'node.docker.container.exec',
            target: input.container,
            baseClass: 'plain',
            summary: () => '',
            params: {},
            auditDetails: { shell: input.shell },
        };
        let facts: FleetMachineNodeFacts | null = null;
        try {
            if (!isFleetContainerShell(input.shell)) {
                throw fleetMachineError('invalid', 'shell must be bash or sh', { field: 'shell' });
            }
            if (!this.sessions || !config.fleet.isSessionsEnabled()) {
                throw fleetMachineError('unsupported_on_node', 'sessions on computers are switched off on this deployment');
            }
            facts = await port.authorize({
                nodeId,
                verb: 'docker.container.action',
                caller,
                actionFamily: 'docker',
                stateChanging: true,
                target: input.container,
            });
            const listed = await this.listContainers(nodeId, caller);
            const found = listed.containers.find(
                (row) => row.id === input.container.slice(0, 12) || row.name === input.container,
            );
            if (!found) throw fleetMachineError('not_found', `${input.container} is not a container on ${facts.name}`);
            if (found.state !== 'running') throw fleetMachineError('busy', `${found.name} is not running; start it first`);
            const session = await this.sessions.start(
                nodeId,
                { userId: caller.userId },
                {
                    kind: 'owner',
                    provider: 'shell',
                    cwd: '~',
                    title: `Shell · inside ${found.name}`,
                    container: { container: found.id, shell: input.shell },
                },
            );
            await this.record(spec, facts, {
                requestedBy,
                confirmationClass: 'plain',
                outcome: 'ok',
                container: found.name,
                sessionId: session.id,
            });
            return { sessionId: session.id };
        } catch (error) {
            const refusal = readFleetMachineError(error);
            if (refusal && refusal.code !== 'not_found') {
                const owner = facts ?? (port.describe ? await port.describe(nodeId).catch(() => null) : null);
                await this.record(spec, owner, {
                    requestedBy,
                    confirmationClass: 'plain',
                    outcome: auditOutcomeOf(refusal.code),
                    code: refusal.code,
                });
            }
            throw error;
        }
    }

    // ─── Shared ───────────────────────────────────────────────────────────

    /** A read: the `view` family, never audited (CONTRACTS §2.3), never refused under the kill switch by the node. */
    async list<T>(
        nodeId: string,
        caller: FleetMachineCaller,
        verb: string,
        params: Record<string, unknown>,
    ): Promise<T> {
        const reply = await this.port().request({
            nodeId,
            verb,
            caller,
            actionFamily: 'view',
            stateChanging: false,
            params,
            timeoutMs: FLEET_MACHINE_LIST_TIMEOUT_MS,
            awaitOperationMs: FLEET_MACHINE_LIST_TIMEOUT_MS,
        });
        if ('operationId' in reply && reply.operationId) {
            // A list never outlives the inline window on a healthy node; one that
            // did is reported as busy rather than handing a read an operation id.
            throw fleetMachineError('busy', 'the computer is still reading this; try again in a moment', {
                operationId: reply.operationId,
            });
        }
        return reply.result as T;
    }

    /** One act through the gate, the confirmation and the machine, with its audit row. */
    async act<T extends object>(spec: ActSpec): Promise<T | FleetOperationRef> {
        const port = this.port();
        const requestedBy = describeFleetMachineCaller(spec.caller);
        let facts: FleetMachineNodeFacts;
        try {
            facts = await port.authorize({
                nodeId: spec.nodeId,
                verb: spec.verb,
                caller: spec.caller,
                actionFamily: spec.family,
                stateChanging: true,
                target: spec.target,
            });
        } catch (error) {
            const refusal = readFleetMachineError(error);
            if (refusal && refusal.code !== 'not_found') {
                const owner = port.describe ? await port.describe(spec.nodeId).catch(() => null) : null;
                await this.record(spec, owner, {
                    requestedBy,
                    confirmationClass: spec.baseClass,
                    outcome: 'refused',
                    code: refusal.code,
                });
            }
            throw error;
        }

        const missing = fleetMissingConfirmation({
            class: spec.baseClass,
            target: spec.confirmTarget ?? spec.target,
            fields: spec.fields,
        });
        if (missing) {
            const details: FleetConfirmationRequiredDetails = {
                class: missing,
                summary: spec.summary(facts.name),
                ...(missing === 'confirm-destructive' ? { target: spec.confirmTarget ?? spec.target } : {}),
                ...(spec.preview ? { preview: spec.preview } : {}),
            };
            throw fleetMachineError(
                'confirmation_required',
                missing === 'confirm-destructive'
                    ? `type ${spec.confirmTarget ?? spec.target} to confirm`
                    : 'send confirm: true to confirm',
                { ...details },
            );
        }

        let reply: FleetMachineNodeReply;
        try {
            reply = await port.request({
                nodeId: spec.nodeId,
                verb: spec.verb,
                caller: spec.caller,
                actionFamily: spec.family,
                stateChanging: true,
                target: spec.target,
                params: {
                    ...spec.params,
                    // The node decides the blast radius; it only reads that the caller saw it.
                    acknowledgeBlastRadius: spec.fields?.acknowledgeBlastRadius === true,
                },
                timeoutMs: spec.timeoutMs ?? FLEET_MACHINE_ACTION_TIMEOUT_MS,
                // A quick act answers with its result (spec §6: ≤ 10 s); a longer one is an operation.
                awaitOperationMs: spec.awaitOperationMs ?? FLEET_MACHINE_ACTION_AWAIT_MS,
            });
        } catch (error) {
            const refusal = readFleetMachineError(error);
            if (refusal?.code === 'confirmation_required') {
                // The node's blast-radius prompt: shown with the dialog's title, never audited.
                throw fleetMachineError('confirmation_required', refusal.hint, {
                    ...(refusal.details ?? {}),
                    summary: spec.summary(facts.name),
                });
            }
            const known = refusal ?? makeFleetLinkError('internal', 'the computer could not be reached');
            await this.record(spec, facts, {
                requestedBy,
                confirmationClass: spec.baseClass,
                outcome: auditOutcomeOf(known.code),
                code: known.code,
                rootRequired: known.code === 'root_required',
            });
            if (error instanceof HttpException) throw error;
            this.logger.warn(
                `${spec.verb} on node ${spec.nodeId} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw new FleetMachineException(known);
        }

        if ('operationId' in reply && reply.operationId) {
            await this.record(spec, facts, {
                requestedBy,
                confirmationClass: spec.baseClass,
                outcome: 'ok',
                operationId: reply.operationId,
            });
            return { operationId: reply.operationId };
        }

        const result = (reply.result ?? {}) as T & { blastRadius?: unknown; viaRoot?: unknown };
        if (spec.noOpResult?.(result as Record<string, unknown>)) return result;
        const blastRadius: FleetBlastRadius | null = asFleetBlastRadius(result.blastRadius);
        await this.record(spec, facts, {
            requestedBy,
            confirmationClass: fleetEffectiveConfirmationClass(spec.baseClass, blastRadius),
            outcome: 'ok',
            ...(blastRadius ? { blastRadiusKind: blastRadius.kind } : {}),
            rootRequired: result.viaRoot === true,
        });
        return result;
    }

    private port(): FleetMachineNodePort {
        if (!this.node) throw fleetMachineError('unreachable', 'this deployment cannot reach computers');
        return this.node;
    }

    private async record(
        spec: ActSpec,
        facts: FleetMachineNodeFacts | null,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action: spec.auditAction,
            actorUserId: fleetMachineCallerUserId(spec.caller),
            ownerUserId: facts?.userId ?? null,
            nodeId: spec.nodeId,
            details: {
                family: spec.family,
                target: spec.target,
                ...(spec.auditDetails ?? {}),
                ...details,
            },
        });
    }
}
