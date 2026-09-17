import { randomUUID } from 'node:crypto';
import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    ForbiddenException,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Inject,
    Logger,
    Optional,
    Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    AgentRepository,
    LANE_CATALOG,
    getAgentTemplate,
    getLaneSpec,
    laneCapForTeamSize,
    listLaneCatalog,
    proposeRoster,
    selectBlueprint,
    type RosterLaneSpec,
} from '@ever-works/agent/agents';
import { OnboardingChecklistRepository } from '@ever-works/agent/database';
import {
    ROSTER_PROVISION_DISPATCHER,
    type RosterProvisionDispatcher,
} from '@ever-works/agent/tasks';
import { getGtmSkill } from '@ever-works/contracts';
import {
    ROSTER_MAX_LANES,
    ROSTER_NAME_MAX,
    type RosterLaneResult,
    type RosterProvisionRecord,
} from '@ever-works/contracts/api';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope';
import { OnboardingStateService } from './onboarding-state.service';
import {
    ProvisionRosterAcceptedDto,
    ProvisionRosterDto,
    RosterBlueprintsResponseDto,
    RosterLaneOptionDto,
    RosterStateResponseDto,
    type RosterAgentDto,
} from './dto/onboarding-roster.dto';

/** Provisioning states that mean "a run is going right now". */
const IN_FLIGHT_STATES = new Set(['queued', 'creating', 'binding']);

/**
 * AW-20 P1 — the roster endpoints behind the setup wizard's
 * **Your agents** step.
 *
 * ```
 * GET  /api/onboarding/roster/blueprints   what we propose, and why
 * GET  /api/onboarding/roster              what the last run did
 * POST /api/onboarding/roster/provision    go (202, never blocks)
 * POST /api/onboarding/roster/acknowledge  "I read the introduction"
 * ```
 *
 * The step exists because setup today ends at infrastructure: a user
 * answers four provider questions and lands on a dashboard with zero
 * agents and nothing to do. This is the one step that hands them a team.
 *
 * ## Why provisioning returns before it finishes
 *
 * A four-lane roster is roughly thirty writes — create, SOUL.md,
 * guardrails, activate, a reporting line and a collaborator row each, and
 * up to four skill bindings per lane — which run sequentially, can each
 * be refused independently, and must report per-lane progress. Holding an
 * HTTP request open for that is minutes of tail latency on a bad day and
 * makes the one-second response impossible. So the request records the
 * run as `queued`, enqueues it through the configured job runtime, and
 * returns; the panel polls `GET /roster` for per-lane outcomes.
 */
@ApiTags('onboarding')
@Controller('api/onboarding/roster')
export class OnboardingRosterController {
    private readonly logger = new Logger(OnboardingRosterController.name);

    constructor(
        private readonly checklists: OnboardingChecklistRepository,
        private readonly agents: AgentRepository,
        private readonly stateService: OnboardingStateService,
        @Optional()
        @Inject(ROSTER_PROVISION_DISPATCHER)
        private readonly dispatcher: RosterProvisionDispatcher | null = null,
        @Optional() private readonly scopeContext?: ScopeContextService,
    ) {}

    @Get('blueprints')
    @ApiOperation({
        summary:
            'The roster we propose for this person, derived from the roles and team size they already answered, plus the full lane catalogue.',
    })
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async blueprints(@CurrentUser() auth: AuthenticatedUser): Promise<RosterBlueprintsResponseDto> {
        const profile = await this.savedProfile(auth.userId);
        const blueprint = selectBlueprint(profile.roles);
        const proposal = proposeRoster(profile.roles, profile.teamSize);

        return {
            blueprintSlug: blueprint.slug,
            derivedFromRoles: profile.roles.length > 0,
            laneCap: laneCapForTeamSize(profile.teamSize),
            maxLanes: ROSTER_MAX_LANES,
            nameMax: ROSTER_NAME_MAX,
            proposal: proposal.map(toLaneOption),
            catalog: listLaneCatalog().map(toLaneOption),
            canCreateAgents: this.canCreateAgents(),
        };
    }

    @Get()
    @ApiOperation({
        summary:
            'The current or last roster provisioning run for this person and scope, plus the agents that hold a lane today.',
    })
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'private, no-store')
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async state(@CurrentUser() auth: AuthenticatedUser): Promise<RosterStateResponseDto> {
        return this.readState(auth.userId);
    }

    @Post('provision')
    @ApiOperation({
        summary:
            'Provision the roster in the background. Returns immediately with a run id; poll GET /api/onboarding/roster for per-lane progress.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    // Five a hour: enough for a first attempt, a retry after a partial run
    // and a change of mind, and not enough to bulk-create agents.
    @Throttle({ long: { limit: 5, ttl: 3_600_000 } })
    async provision(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: ProvisionRosterDto,
    ): Promise<ProvisionRosterAcceptedDto> {
        if (!this.canCreateAgents()) {
            throw new ForbiddenException('You do not have permission to add agents.');
        }

        // Defence in depth behind the DTO's `@IsIn`: a lane we stopped
        // shipping between a client's page load and its submit must not
        // reach provisioning, and nothing is written before we say so.
        const specs = body.lanes.map((lane) => {
            const spec = getLaneSpec(lane.laneKey);
            if (!spec) {
                throw new BadRequestException(`Unknown roster lane "${lane.laneKey}".`);
            }
            return spec;
        });

        const organizationId = this.scopeContext?.getScope().organizationId ?? null;
        const tenantId = this.scopeContext?.getScope().tenantId ?? null;

        const row = await this.checklists.ensure(auth.userId, organizationId);
        if (row.provisioning && IN_FLIGHT_STATES.has(row.provisioning.state)) {
            throw new ConflictException({
                message: 'A roster is already being set up.',
                error: 'roster_provision_in_flight',
                runId: row.provisioning.runId,
                statusCode: HttpStatus.CONFLICT,
            });
        }

        const runId = randomUUID();
        const blueprintSlug = body.blueprintSlug ?? selectBlueprint(null).slug;
        const queued: RosterProvisionRecord = {
            runId,
            blueprintSlug,
            state: 'queued',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            lanes: body.lanes.map(
                (lane, index): RosterLaneResult => ({
                    laneKey: lane.laneKey,
                    templateSlug: specs[index].templateSlug,
                    requestedName: lane.name,
                    outcome: 'pending',
                }),
            ),
        };

        // Compare-and-set on the row the check above read. Two tabs
        // pressing the button within a second of each other both see
        // `idle`; only one write lands, and the other is told a run is
        // already going instead of queueing a second identical roster.
        const claimed = await this.checklists.startProvisioningIfUnchanged(
            auth.userId,
            organizationId,
            row.updatedAt,
            queued,
        );
        if (!claimed) {
            throw new ConflictException({
                message: 'A roster is already being set up.',
                error: 'roster_provision_in_flight',
                runId: null,
                statusCode: HttpStatus.CONFLICT,
            });
        }

        const handle = await this.enqueue({
            userId: auth.userId,
            tenantId,
            organizationId,
            runId,
            blueprintSlug,
            lanes: body.lanes.map((lane) => ({ laneKey: lane.laneKey, name: lane.name })),
        });

        if (handle === null) {
            // No job runtime is configured, so nothing will ever pick this
            // up. Record it as failed rather than leaving a `queued` row
            // the panel would poll until it stalls — the UI offers
            // **Try again**, which is the honest affordance.
            const failed: RosterProvisionRecord = {
                ...queued,
                state: 'failed',
                finishedAt: new Date().toISOString(),
                lanes: queued.lanes.map((lane) => ({
                    ...lane,
                    outcome: 'failed',
                    failureReason: 'unknown',
                })),
            };
            await this.checklists.patch(auth.userId, organizationId, { provisioning: failed });
            return { runId, state: 'failed' };
        }

        return { runId, state: 'queued' };
    }

    @Post('acknowledge')
    @ApiOperation({
        summary:
            'Record that this person read the roster introduction. Idempotent — acknowledging twice is harmless.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async acknowledge(@CurrentUser() auth: AuthenticatedUser): Promise<RosterStateResponseDto> {
        const organizationId = this.scopeContext?.getScope().organizationId ?? null;
        const row = await this.checklists.ensure(auth.userId, organizationId);
        // First acknowledgement wins: re-stamping would move "when you met
        // your agents" every time the panel is reopened from Help.
        if (!row.rosterAcknowledgedAt) {
            await this.checklists.patch(auth.userId, organizationId, {
                rosterAcknowledgedAt: new Date(),
            });
        }
        return this.readState(auth.userId);
    }

    /** The roster state both `GET /` and `POST /acknowledge` answer with. */
    private async readState(userId: string): Promise<RosterStateResponseDto> {
        const organizationId = this.scopeContext?.getScope().organizationId ?? null;
        const scope = this.scopeContext?.getScope();
        const row = await this.checklists.find(userId, organizationId);

        const laneKeys = Object.keys(LANE_CATALOG);
        const rows = await this.agents.findByUserAndLanes(userId, laneKeys, scope ?? undefined);
        const byId = new Map(rows.map((agent) => [agent.id, agent]));

        const agents: RosterAgentDto[] = rows.map((agent) => {
            const spec = agent.lane ? getLaneSpec(agent.lane) : undefined;
            const template = spec ? getAgentTemplate(spec.templateSlug) : undefined;
            const manager = agent.reportsToAgentId ? byId.get(agent.reportsToAgentId) : undefined;
            return {
                id: agent.id,
                name: agent.name,
                lane: agent.lane ?? null,
                title: agent.title ?? null,
                reportsToAgentId: agent.reportsToAgentId ?? null,
                reportsToName: manager?.name ?? null,
                skills: (template?.suggestedSkills ?? [])
                    .map((slug) => getGtmSkill(slug)?.title)
                    .filter((title): title is string => Boolean(title)),
            };
        });

        return {
            state: row?.provisioning?.state ?? 'idle',
            provisioning: row?.provisioning ?? null,
            acknowledgedAt: row?.rosterAcknowledgedAt
                ? row.rosterAcknowledgedAt.toISOString()
                : null,
            agents,
            canCreateAgents: this.canCreateAgents(),
        };
    }

    /**
     * Enqueue through whichever job runtime the operator selected. Never
     * throws: an enqueue failure is reported as "no handle", which the
     * caller records as a failed run.
     */
    private async enqueue(payload: {
        userId: string;
        tenantId: string | null;
        organizationId: string | null;
        runId: string;
        blueprintSlug: string;
        lanes: readonly { laneKey: string; name: string }[];
    }): Promise<string | null> {
        if (!this.dispatcher?.dispatchRosterProvision) return null;
        try {
            return await this.dispatcher.dispatchRosterProvision(payload);
        } catch (error) {
            this.logger.error(
                `Could not enqueue roster provisioning: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /**
     * May this caller add Agents?
     *
     * Today: yes, for every authenticated caller. Ever Works has exactly
     * one organization member role (`ORGANIZATION_MEMBER_ROLES = ['member']`)
     * and no agent-creation permission, so there is no fact to read and
     * inventing one here would be a permission model smuggled in through
     * an onboarding endpoint. The flag is on the wire, and the wizard
     * already renders the read-only branch from it, so the day a role
     * model lands this is the single place that learns about it.
     */
    private canCreateAgents(): boolean {
        return true;
    }

    /** Roles and team size the caller already answered; best-effort. */
    private async savedProfile(
        userId: string,
    ): Promise<{ roles: string[]; teamSize: string | null }> {
        try {
            const state = await this.stateService.getState(userId);
            return {
                roles: [...(state.state.profile?.roles ?? [])],
                teamSize: state.state.profile?.teamSize ?? null,
            };
        } catch {
            // A state read failure degrades to "no roles answered", which
            // proposes the general blueprint — the same thing skipping the
            // roles step does. It must never fail the step.
            return { roles: [], teamSize: null };
        }
    }
}

function toLaneOption(spec: RosterLaneSpec): RosterLaneOptionDto {
    return {
        laneKey: spec.laneKey,
        labelKey: spec.labelKey,
        templateSlug: spec.templateSlug,
        defaultName: spec.defaultName,
        isCoordinator: spec.isCoordinator === true,
    };
}
