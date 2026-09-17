import { ConflictException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
    LaneFailureReason,
    RosterBlueprintSlug,
    RosterLaneKey,
    RosterLaneResult,
    RosterProvisionRecord,
    RosterProvisionState,
} from '@ever-works/contracts/api';
import { AgentStatus } from '../entities/agent.entity';
import type { OwnershipScope } from '../database/ownership-scope';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentCollaboratorRepository } from '../database/repositories/agent-collaborator.repository';
import { OnboardingChecklistRepository } from '../database/repositories/onboarding-checklist.repository';
import { AgentsService } from './agents.service';
import { AgentTemplatesService } from './agent-templates.service';
import { getAgentTemplate } from './agent-templates';
import { getLaneSpec, type RosterLaneSpec } from './roster-blueprints';
import { ROSTER_SKILL_BINDER, type RosterSkillBinder } from './roster-skill-binder.port';

/** One lane as the caller asked for it: which lane, and what to call it. */
export interface RosterProvisionLaneRequest {
    readonly laneKey: RosterLaneKey;
    readonly name: string;
}

/** Everything one provisioning run needs. Carried whole through the job runtime. */
export interface RosterProvisionInput {
    readonly userId: string;
    readonly tenantId: string | null;
    readonly organizationId: string | null;
    readonly runId: string;
    readonly blueprintSlug: RosterBlueprintSlug;
    readonly lanes: readonly RosterProvisionLaneRequest[];
}

/**
 * The clocks this service runs on (FR-13, FR-14). Exported so the
 * controller's stall copy and the web panel's poll budget are derived
 * from the same numbers rather than guessed twice.
 */
export const ROSTER_PROVISION_LIMITS = Object.freeze({
    /** Attempts per lane: the first, plus two retries. */
    attemptsPerLane: 3,
    /** Gap between attempts on the same lane, in ms. */
    retryDelayMs: 5_000,
    /** One attempt is abandoned after this, in ms. */
    attemptTimeoutMs: 20_000,
    /** The whole run is abandoned after this, in ms. */
    runBudgetMs: 120_000,
    /** Highest numeric suffix tried when a name is taken (2 … 9). */
    maxNameSuffix: 9,
});

/**
 * AW-20 P1 — provision a roster: a coordinator plus lane-owning
 * specialists, wired to report to it and to be delegated to by it.
 *
 * ## Why this runs one lane at a time
 *
 * `AgentsService.create` enforces per-user name uniqueness with a
 * read-then-write, and firing four creates in parallel races that check
 * into spurious conflicts between templates that share no name at all.
 * `OnboardingRoleSeedingService` made the same call for the same reason;
 * this service is its bigger sibling and the rationale is unchanged. Four
 * rows is not the interesting number here — correctness is.
 *
 * ## Why every failure is a recorded outcome, never a thrown error
 *
 * A half-finished roster is the normal unhappy case: a plan runs out of
 * seats on the third lane, a name is taken, one skill will not attach.
 * The user needs to see WHICH lane and WHY, and then be able to finish
 * the job. `execute` therefore never throws: every lane carries its own
 * terminal outcome, and the run as a whole reports `ready`, `partial` or
 * `failed`.
 *
 * ## Why running it twice is safe
 *
 * A lane already held by one of the caller's Agents is REUSED, never
 * duplicated (`agents.lane` is uniquely constrained per user by a partial
 * index, so the database agrees). A retry after a partial run therefore
 * attempts only the lanes that are still empty, and the agents from the
 * first run are untouched.
 */
@Injectable()
export class RosterProvisioningService {
    private readonly logger = new Logger(RosterProvisioningService.name);

    constructor(
        private readonly templates: AgentTemplatesService,
        private readonly agents: AgentsService,
        private readonly agentRepository: AgentRepository,
        private readonly collaborators: AgentCollaboratorRepository,
        // `@Optional()` + appended last, per the repo's convention for
        // adding a dependency to a service with hand-rolled unit tests.
        // Production DI always binds both.
        @Optional() private readonly checklists?: OnboardingChecklistRepository,
        @Optional()
        @Inject(ROSTER_SKILL_BINDER)
        private readonly skillBinder?: RosterSkillBinder,
    ) {}

    /**
     * Run the state machine to a terminal state and return the record.
     *
     * Progress is persisted after every lane, not only at the end, so the
     * progress panel can name what happened to each lane WHILE the run is
     * still going — which is the difference between "this is working" and
     * "this has hung".
     */
    async execute(input: RosterProvisionInput): Promise<RosterProvisionRecord> {
        const startedAt = new Date();
        const deadline = startedAt.getTime() + ROSTER_PROVISION_LIMITS.runBudgetMs;
        const scope: OwnershipScope = {
            tenantId: input.tenantId,
            organizationId: input.organizationId,
        };

        const specs = new Map<string, RosterLaneSpec>();
        const lanes: RosterLaneResult[] = [];
        for (const requested of input.lanes) {
            const spec = getLaneSpec(requested.laneKey);
            if (!spec) {
                // The controller rejects unknown lanes before anything is
                // written; reaching here means a record outlived a lane we
                // stopped shipping. Report it, never guess a substitute.
                lanes.push({
                    laneKey: requested.laneKey,
                    templateSlug: '',
                    requestedName: requested.name,
                    outcome: 'failed',
                    failureReason: 'unknown',
                });
                continue;
            }
            specs.set(requested.laneKey, spec);
            lanes.push({
                laneKey: requested.laneKey,
                templateSlug: spec.templateSlug,
                requestedName: requested.name,
                outcome: 'pending',
            });
        }

        let record = this.buildRecord(input, 'creating', startedAt, lanes, null);
        await this.persist(input, record);

        // Which lanes does this user already hold? Asked once, before any
        // write: this is what makes a second run fill gaps rather than
        // create a second "Research".
        const held = new Map<string, { id: string; status: AgentStatus }>();
        try {
            const existing = await this.agentRepository.findByUserAndLanes(
                input.userId,
                [...specs.keys()],
                scope,
            );
            for (const agent of existing) {
                if (agent.lane) held.set(agent.lane, { id: agent.id, status: agent.status });
            }
        } catch (error) {
            // A failed lookup must not turn into a duplicate roster. Treat
            // it as "nothing held" only after saying so loudly — the
            // per-user partial unique index is the real backstop, and a
            // create that collides with it is caught below as `reused`.
            this.logger.warn(`Could not read existing lanes: ${describe(error)}`);
        }

        let seatsExhausted = false;
        for (let index = 0; index < lanes.length; index += 1) {
            const lane = lanes[index];
            if (lane.outcome !== 'pending') continue;
            const spec = specs.get(lane.laneKey);
            if (!spec) continue;

            if (seatsExhausted) {
                lanes[index] = { ...lane, outcome: 'skippedNoSeat', failureReason: 'noSeat' };
                continue;
            }

            if (Date.now() >= deadline) {
                // Out of budget. Remaining lanes stay `pending`, which is
                // exactly what the next run needs to pick them up.
                break;
            }

            const held0 = held.get(lane.laneKey);
            if (held0) {
                lanes[index] = { ...lane, outcome: 'reused', agentId: held0.id };
                record = this.buildRecord(input, 'creating', startedAt, lanes, null);
                await this.persist(input, record);
                continue;
            }

            const outcome = await this.createLane(input, scope, lane, spec, deadline);
            lanes[index] = outcome;
            if (outcome.outcome === 'skippedNoSeat') seatsExhausted = true;
            record = this.buildRecord(input, 'creating', startedAt, lanes, null);
            await this.persist(input, record);
        }

        record = this.buildRecord(input, 'binding', startedAt, lanes, null);
        await this.persist(input, record);
        await this.bind(input, scope, lanes, specs);

        const finishedAt = new Date();
        record = this.buildRecord(input, terminalState(lanes), startedAt, lanes, finishedAt);
        await this.persist(input, record);
        return record;
    }

    /**
     * Create one lane's Agent, retrying a transient failure and walking a
     * numeric suffix past a taken name.
     */
    private async createLane(
        input: RosterProvisionInput,
        scope: OwnershipScope,
        lane: RosterLaneResult,
        spec: RosterLaneSpec,
        deadline: number,
    ): Promise<RosterLaneResult> {
        let lastReason: LaneFailureReason = 'unknown';

        for (let attempt = 1; attempt <= ROSTER_PROVISION_LIMITS.attemptsPerLane; attempt += 1) {
            if (Date.now() >= deadline) {
                return { ...lane, outcome: 'failed', failureReason: 'timedOut' };
            }
            try {
                const created = await this.withTimeout(
                    this.createWithFreeName(input, scope, lane.requestedName, spec),
                );
                return {
                    ...lane,
                    outcome: 'created',
                    agentId: created.id,
                    finalName: created.name === lane.requestedName ? null : created.name,
                };
            } catch (error) {
                if (isSeatLimitError(error)) {
                    // The plan is out of seats. This lane and every lane
                    // after it are skipped — retrying would only reproduce
                    // the same refusal, more slowly.
                    return { ...lane, outcome: 'skippedNoSeat', failureReason: 'noSeat' };
                }
                if (error instanceof NameUnavailableError) {
                    return { ...lane, outcome: 'failed', failureReason: 'nameUnavailable' };
                }
                lastReason = error instanceof AttemptTimeoutError ? 'timedOut' : 'unknown';
                this.logger.warn(
                    `Roster lane "${lane.laneKey}" attempt ${attempt} failed: ${describe(error)}`,
                );
                if (attempt < ROSTER_PROVISION_LIMITS.attemptsPerLane) {
                    await this.sleep(ROSTER_PROVISION_LIMITS.retryDelayMs);
                }
            }
        }

        return { ...lane, outcome: 'failed', failureReason: lastReason };
    }

    /**
     * Create the Agent, walking `Name 2` … `Name 9` past a taken name.
     *
     * A name conflict is the expected outcome of "you already had a
     * Research", not an error: the suffix keeps the lane fillable instead
     * of asking the user to rename something before anything exists.
     */
    private async createWithFreeName(
        input: RosterProvisionInput,
        scope: OwnershipScope,
        requestedName: string,
        spec: RosterLaneSpec,
    ): Promise<{ id: string; name: string }> {
        for (let suffix = 1; suffix <= ROSTER_PROVISION_LIMITS.maxNameSuffix; suffix += 1) {
            const name = suffix === 1 ? requestedName : `${requestedName} ${suffix}`;
            try {
                const created = await this.templates.createFromTemplate(
                    input.userId,
                    spec.templateSlug,
                    { name, lane: spec.laneKey },
                    scope,
                );
                return { id: created.id, name: created.name };
            } catch (error) {
                if (error instanceof ConflictException) continue;
                // The partial unique index on (userId, lane) rejecting the
                // insert means somebody filled this lane between our read
                // and our write. That is "already filled", not a failure —
                // rethrow as a conflict so the caller reuses rather than
                // retries into the same wall.
                if (isLaneTakenError(error)) throw new ConflictException('Lane already filled.');
                throw error;
            }
        }
        throw new NameUnavailableError(requestedName);
    }

    /**
     * The binding stage: skills, reporting lines, the delegation
     * allow-list, and activation.
     *
     * Nothing here can fail a lane. An agent missing one skill is still an
     * agent; a reporting line that did not write is a cosmetic gap the
     * user can fix in one click. Failing a created agent at this point
     * would be the worst of both worlds — the row exists either way.
     */
    private async bind(
        input: RosterProvisionInput,
        scope: OwnershipScope,
        lanes: RosterLaneResult[],
        specs: Map<string, RosterLaneSpec>,
    ): Promise<void> {
        const coordinatorLane = lanes.find((lane) => specs.get(lane.laneKey)?.isCoordinator);
        const coordinatorId = coordinatorLane?.agentId ?? null;

        for (let index = 0; index < lanes.length; index += 1) {
            const lane = lanes[index];
            if (lane.outcome !== 'created' && lane.outcome !== 'reused') continue;
            if (!lane.agentId) continue;
            const spec = specs.get(lane.laneKey);
            if (!spec) continue;

            // FR-24 — an Agent this run did not create is only ever added
            // to the coordinator's allow-list. It is not renamed, not
            // re-pointed, not re-activated: it may already be doing work
            // under settings its owner chose.
            if (lane.outcome === 'created') {
                const warnings = await this.attachSkills(input, spec, lane.agentId);
                if (warnings.length > 0) lanes[index] = { ...lane, skillWarnings: warnings };

                if (coordinatorId && !spec.isCoordinator) {
                    await this.safely('reporting line', () =>
                        this.agents.update(
                            input.userId,
                            lane.agentId as string,
                            { reportsToAgentId: coordinatorId },
                            scope,
                        ),
                    );
                }
                await this.safely('activation', () =>
                    this.agents.resume(input.userId, lane.agentId as string, scope),
                );
            }

            if (coordinatorId && lane.agentId !== coordinatorId) {
                await this.safely('delegation allow-list', () =>
                    this.collaborators.upsert({
                        userId: input.userId,
                        agentId: coordinatorId,
                        collaboratorAgentId: lane.agentId as string,
                        enabled: true,
                        tenantId: input.tenantId,
                        organizationId: input.organizationId,
                    }),
                );
            }
        }
    }

    /** Attach the template's suggested skills; a failure is a warning (FR-23). */
    private async attachSkills(
        input: RosterProvisionInput,
        spec: RosterLaneSpec,
        agentId: string,
    ): Promise<string[]> {
        if (!this.skillBinder) return [];
        const template = getAgentTemplate(spec.templateSlug);
        if (!template) return [];

        const warnings: string[] = [];
        for (const skillSlug of template.suggestedSkills) {
            try {
                await this.skillBinder.attach({
                    userId: input.userId,
                    agentId,
                    skillSlug,
                    organizationId: input.organizationId,
                });
            } catch (error) {
                this.logger.warn(`Could not attach skill "${skillSlug}": ${describe(error)}`);
                warnings.push(skillSlug);
            }
        }
        return warnings;
    }

    private buildRecord(
        input: RosterProvisionInput,
        state: RosterProvisionState,
        startedAt: Date,
        lanes: readonly RosterLaneResult[],
        finishedAt: Date | null,
    ): RosterProvisionRecord {
        return {
            runId: input.runId,
            blueprintSlug: input.blueprintSlug,
            state,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt ? finishedAt.toISOString() : null,
            lanes: lanes.map((lane) => ({ ...lane })),
        };
    }

    /**
     * Write progress. Best-effort on purpose: losing a progress write
     * must not abandon a run that is creating real rows. The next write
     * carries the same lanes, so a dropped one self-heals.
     */
    private async persist(
        input: RosterProvisionInput,
        record: RosterProvisionRecord,
    ): Promise<void> {
        if (!this.checklists) return;
        try {
            await this.checklists.patch(input.userId, input.organizationId, {
                provisioning: record,
            });
        } catch (error) {
            this.logger.warn(`Could not persist provisioning progress: ${describe(error)}`);
        }
    }

    /** Run a binding step, logging rather than failing the lane. */
    private async safely(what: string, run: () => Promise<unknown>): Promise<void> {
        try {
            await run();
        } catch (error) {
            this.logger.warn(`Roster ${what} could not be written: ${describe(error)}`);
        }
    }

    /** One attempt's ceiling (FR-13). */
    private async withTimeout<T>(work: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                work,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new AttemptTimeoutError()),
                        ROSTER_PROVISION_LIMITS.attemptTimeoutMs,
                    );
                    // Never hold the process open for a race we may win.
                    timer.unref?.();
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * The gap between attempts on one lane. `protected` so a unit spec can
     * collapse it — the retry POLICY is what the spec is about, and no
     * test should spend fifteen real seconds proving it.
     */
    protected async sleep(ms: number): Promise<void> {
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            timer.unref?.();
        });
    }
}

/** Every suffix from 2 to 9 was taken as well (FR-18). */
class NameUnavailableError extends Error {
    constructor(name: string) {
        super(`No free name near "${name}".`);
        this.name = 'RosterNameUnavailableError';
    }
}

/** One create attempt ran past its ceiling. */
class AttemptTimeoutError extends Error {
    constructor() {
        super('Agent creation attempt timed out.');
        this.name = 'RosterAttemptTimeoutError';
    }
}

/**
 * `ready` when every lane landed, `partial` when some did, `failed` when
 * none did (FR-10). A lane still `pending` — the run ran out of budget
 * before reaching it — counts as "did not land", because from the user's
 * side that is exactly what happened.
 */
function terminalState(lanes: readonly RosterLaneResult[]): RosterProvisionState {
    const landed = lanes.filter(
        (lane) => lane.outcome === 'created' || lane.outcome === 'reused',
    ).length;
    if (landed === lanes.length && lanes.length > 0) return 'ready';
    return landed > 0 ? 'partial' : 'failed';
}

/**
 * Seat refusal, recognised by the error's stable `name`.
 *
 * `SeatLimitExceededError` lives in `@ever-works/agent/subscriptions`,
 * which this module must not import — billing depends on agents, not the
 * other way round. The class's own doc comment pins the `name` for
 * exactly this purpose (the API's 402 filter reads it the same way).
 */
function isSeatLimitError(error: unknown): boolean {
    return error instanceof Error && error.name === 'SeatLimitExceededError';
}

/** The partial unique index on `(userId, lane)` rejected the insert. */
function isLaneTakenError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('uq_agents_user_lane');
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
