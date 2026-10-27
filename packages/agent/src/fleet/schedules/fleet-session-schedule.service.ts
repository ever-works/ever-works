import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    describeFleetScheduleCadence,
    fleetCommandUtf8Length,
    fleetScheduleCadenceToCron,
    fleetScheduleUnattendedCredentialSentence,
    isFleetScheduleName,
    parseFleetScheduleCadence,
    previewFleetScheduleFires,
    FLEET_AGENT_SESSION_PROVIDERS,
    FLEET_SCHEDULE_AGENT_COST_SENTENCE,
    FLEET_SCHEDULE_PROMPT_MAX_BYTES,
    type FleetAgentSessionScheduleConfirmation,
    type FleetAgentSessionScheduleRequest,
    type FleetAgentSessionScheduleView,
    type FleetScheduleAgentOption,
} from '@ever-works/contracts';
import { config } from '../../config';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import type { FleetNode } from '../../entities/fleet-node.entity';
import { fleetSessionScheduleLabels } from '../../tasks-domain/task-session-schedule.port';
import { FleetAccessService } from '../fleet-access.service';
import { FleetAgentNodeAffinityRepository } from '../fleet-agent-node-affinity.repository';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { fleetCommandError, readFleetCommandError } from '../commands/fleet-command.errors';

/**
 * Schedules on computers (FL-13 P2, spec S3, FR-8, FR-9, FR-26, U9, CONTRACTS
 * R-29) — Agent-session schedules: "every morning, Nina triages the new issues
 * on build-01". One is a recurring Task assigned to an Agent pinned to the
 * computer (Agent node affinity — the ONLY pin, R-29); every fire is started
 * by the existing recurrence dispatcher and runs as an Agent session on that
 * computer (`TaskSessionScheduleDispatcher`). Nothing new is stored: the Task
 * is the definition, its Runs are the history.
 *
 * Creating one checks, in order: the shape (name, Agent, 3 … 16 KiB prompt,
 * agent CLI, cadence), the computer's `schedules` audience and that it is the
 * person's own (Agent sessions run on your own computers — FL-04 decision 36),
 * the Organization (affinity is Organization-scoped: a personal scope cannot
 * pin, spec §8b default), that the Agent is THIS person's and pinned to THIS
 * computer (U9 — never pinned as a side effect), the kill switch, then the
 * confirmation carrying the unattended-credential sentence verbatim (FR-26),
 * then the Task (through `FLEET_SCHEDULE_TASKS_PORT`) and one
 * `node.schedule.create` audit row.
 */

export interface FleetSessionScheduleActor {
    userId: string;
    tenantId: string | null;
    organizationId: string | null;
}

/** How the schedule service files the recurring Task (the API binds it to `TasksService`). */
export interface FleetScheduleTasksPort {
    createRecurring(input: {
        userId: string;
        tenantId: string | null;
        organizationId: string | null;
        title: string;
        prompt: string;
        agentId: string;
        cron: string;
        timeZone: string;
        labels: string[];
    }): Promise<{ taskId: string; nextOccurrenceAt: Date | null }>;
}

export const FLEET_SCHEDULE_TASKS_PORT = 'FLEET_SCHEDULE_TASKS_PORT' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_MIN_LENGTH = 3;

@Injectable()
export class FleetSessionScheduleService {
    private readonly now: () => number = () => Date.now();

    constructor(
        private readonly access: FleetAccessService,
        private readonly affinities: FleetAgentNodeAffinityRepository,
        private readonly killSwitch: FleetKillSwitchService,
        @InjectRepository(Agent) private readonly agents: Repository<Agent>,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional()
        @Inject(FLEET_SCHEDULE_TASKS_PORT)
        private readonly tasks?: FleetScheduleTasksPort,
    ) {}

    /**
     * The person's Agents for the dialog (spec §5.2, U9): pinned to this
     * computer first; every other Agent listed DISABLED with why.
     */
    async listAgentsForNode(
        actor: FleetSessionScheduleActor,
        nodeId: string,
    ): Promise<FleetScheduleAgentOption[]> {
        this.assertEnabled();
        const node = await this.resolveNode(nodeId, actor);
        const where = actor.organizationId
            ? { userId: actor.userId, organizationId: actor.organizationId }
            : { userId: actor.userId };
        const agents = (
            await this.agents.find({ where, order: { name: 'ASC' }, take: 200 })
        ).filter((agent) => agent.status !== AgentStatus.ARCHIVED);
        const options: FleetScheduleAgentOption[] = [];
        for (const agent of agents) {
            if (!actor.organizationId) {
                options.push({
                    agentId: agent.id,
                    name: agent.name,
                    pinned: false,
                    reason: 'needsOrganization',
                });
                continue;
            }
            const affinity = await this.affinities.findForAgent(
                actor.userId,
                actor.organizationId,
                agent.id,
            );
            const pinned = affinity?.nodeId === node.id;
            options.push({
                agentId: agent.id,
                name: agent.name,
                pinned,
                reason: pinned ? null : affinity ? 'pinnedElsewhere' : 'notPinned',
            });
        }
        return options.sort(
            (a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name),
        );
    }

    /** Create an Agent-session schedule (spec S3) — see the class comment for the order of checks. */
    async create(
        actor: FleetSessionScheduleActor,
        nodeId: string,
        request: FleetAgentSessionScheduleRequest,
    ): Promise<FleetAgentSessionScheduleView> {
        this.assertEnabled();
        const raw = (request ?? {}) as Partial<FleetAgentSessionScheduleRequest>;
        if (!isFleetScheduleName(raw.name)) {
            throw fleetCommandError('invalid', 'name the schedule (1–120 characters, one line)', {
                field: 'name',
            });
        }
        if (typeof raw.agentId !== 'string' || !UUID.test(raw.agentId)) {
            throw fleetCommandError('invalid', 'choose the Agent', { field: 'agentId' });
        }
        const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
        if (prompt.trim().length < PROMPT_MIN_LENGTH || prompt.includes('\0')) {
            throw fleetCommandError(
                'invalid',
                'tell the Agent what to do (at least 3 characters)',
                { field: 'prompt' },
            );
        }
        if (fleetCommandUtf8Length(prompt) > FLEET_SCHEDULE_PROMPT_MAX_BYTES) {
            throw fleetCommandError('limit_exceeded', 'a prompt is at most 16 KiB', {
                field: 'prompt',
                limit: FLEET_SCHEDULE_PROMPT_MAX_BYTES,
            });
        }
        const provider = raw.provider;
        if (!provider || !(FLEET_AGENT_SESSION_PROVIDERS as readonly string[]).includes(provider)) {
            throw fleetCommandError('invalid', 'an Agent session drives Claude Code or Codex', {
                field: 'provider',
            });
        }
        if (
            raw.checkoutId !== undefined &&
            raw.checkoutId !== null &&
            (typeof raw.checkoutId !== 'string' || !UUID.test(raw.checkoutId))
        ) {
            throw fleetCommandError('invalid', 'choose a checkout on this computer', {
                field: 'checkoutId',
            });
        }
        const parsed = parseFleetScheduleCadence(raw.cadence);
        const cron = parsed.cadence ? fleetScheduleCadenceToCron(parsed.cadence) : null;
        if (!parsed.cadence || !cron) {
            throw fleetCommandError('invalid', parsed.error ?? 'choose when it runs', {
                field: 'cadence',
            });
        }

        const node = await this.resolveNode(nodeId, actor);
        if (node.userId !== actor.userId) {
            throw fleetCommandError(
                'unsupported_on_node',
                `Agent sessions run on your own computers for now; ${node.name} belongs to someone else`,
            );
        }
        if (!actor.organizationId) {
            throw fleetCommandError(
                'invalid',
                'pinning an Agent to a computer needs an Organization; switch to one',
                {
                    field: 'agentId',
                },
            );
        }
        const agent = await this.agents.findOne({
            where: { id: raw.agentId, userId: actor.userId },
        });
        if (
            !agent ||
            agent.organizationId !== actor.organizationId ||
            agent.status === AgentStatus.ARCHIVED
        ) {
            throw fleetCommandError('not_found', 'no such Agent', { field: 'agentId' });
        }
        const affinity = await this.affinities.findForAgent(
            actor.userId,
            actor.organizationId,
            agent.id,
        );
        if (affinity?.nodeId !== node.id) {
            throw fleetCommandError(
                'invalid',
                `${agent.name} is not pinned to ${node.name} — pin them on their Capabilities tab, or choose a pinned Agent`,
                { field: 'agentId', reason: affinity ? 'pinnedElsewhere' : 'notPinned' },
            );
        }
        await this.assertNotStopped();
        const zone = node.timeZone ?? null;
        const cadenceHuman = describeFleetScheduleCadence(parsed.cadence);
        if (raw.confirm !== true) {
            const details: FleetAgentSessionScheduleConfirmation = {
                class: 'confirm',
                action: 'create',
                kind: 'agent-session',
                name: raw.name.trim(),
                agentName: agent.name,
                nodeId: node.id,
                nodeName: node.name,
                provider: provider as 'claude-code' | 'codex',
                cadenceHuman,
                nodeTimeZone: zone,
                next: previewFleetScheduleFires(parsed.cadence, zone, this.now(), 3).map((ms) =>
                    new Date(ms).toISOString(),
                ),
                credentialSentence: fleetScheduleUnattendedCredentialSentence(node.name),
                costSentence: FLEET_SCHEDULE_AGENT_COST_SENTENCE,
            };
            throw fleetCommandError(
                'confirmation_required',
                `Schedule ${agent.name} on ${node.name}?`,
                details as unknown as Record<string, unknown>,
            );
        }
        if (!this.tasks)
            throw fleetCommandError(
                'unreachable',
                'this deployment does not file recurring Tasks here',
            );

        let created: { taskId: string; nextOccurrenceAt: Date | null };
        try {
            created = await this.tasks.createRecurring({
                userId: actor.userId,
                tenantId: actor.tenantId,
                organizationId: actor.organizationId,
                title: raw.name.trim(),
                prompt,
                agentId: agent.id,
                cron,
                timeZone: zone ?? 'UTC',
                labels: fleetSessionScheduleLabels({
                    provider: provider as 'claude-code' | 'codex',
                    checkoutId: raw.checkoutId ?? null,
                }),
            });
        } catch (error) {
            const typed = readFleetCommandError(error);
            if (typed) throw fleetCommandError(typed.code, typed.hint, typed.details);
            // TasksService refuses a prompt that looks like it holds a secret (and any other bad input) with a 400.
            const message = error instanceof Error ? error.message : 'the Task could not be filed';
            throw fleetCommandError('invalid', message.slice(0, 300), { field: 'prompt' });
        }
        await this.audit?.tryRecord({
            action: 'node.schedule.create',
            actorUserId: actor.userId,
            ownerUserId: node.userId,
            nodeId: node.id,
            details: {
                family: 'schedules',
                target: created.taskId,
                scheduleId: `recurring_task:${created.taskId}`,
                kind: 'agent-session',
                agentId: agent.id,
                nodeId: node.id,
                requestedBy: `user:${actor.userId}`,
                confirmationClass: 'confirm',
                outcome: 'created',
                cadence: cadenceHuman,
            },
        });
        return {
            kind: 'agent-session',
            taskId: created.taskId,
            scheduleId: `recurring_task:${created.taskId}`,
            name: raw.name.trim(),
            nodeId: node.id,
            nodeName: node.name,
            agentId: agent.id,
            agentName: agent.name,
            cadence: parsed.cadence,
            cadenceHuman,
            nextRunAt: created.nextOccurrenceAt ? created.nextOccurrenceAt.toISOString() : null,
        };
    }

    private async resolveNode(
        nodeId: string,
        actor: FleetSessionScheduleActor,
    ): Promise<FleetNode> {
        try {
            const { node } = await this.access.resolveForFamily(nodeId, actor.userId, 'schedules');
            if (node.kind !== 'node') {
                throw fleetCommandError(
                    'unsupported_on_node',
                    `schedules are not available on ${node.name}`,
                );
            }
            return node;
        } catch (error) {
            const typed = readFleetCommandError(error);
            if (typed?.code === 'permission_denied' || typed?.code === 'unsupported_on_node') {
                throw fleetCommandError(typed.code, typed.hint, typed.details);
            }
            throw fleetCommandError('not_found', 'no such computer', { nodeId });
        }
    }

    private assertEnabled(): void {
        if (!config.fleet.isCommandsEnabled())
            throw fleetCommandError('not_found', 'no such schedule');
    }

    private async assertNotStopped(): Promise<void> {
        let stopped = true;
        try {
            stopped = await this.killSwitch.isStopped();
        } catch {
            stopped = true;
        }
        if (stopped)
            throw fleetCommandError(
                'kill_switch',
                'new schedules cannot be created while the kill switch is on',
            );
    }
}
