import { ConflictException } from '@nestjs/common';
import { AgentStatus } from '../../entities/agent.entity';
import {
    RosterProvisioningService,
    type RosterProvisionInput,
} from '../roster-provisioning.service';

/**
 * AW-20 P1 — the provisioning state machine.
 *
 * Everything here is an unhappy path that a real first hour hits: a plan
 * out of seats on the third lane, a name someone already used, a skill
 * that will not attach, a second run over a roster that already exists.
 * The invariant every case shares is that `execute` NEVER throws — a
 * half-finished roster has to be describable, lane by lane, or the user
 * cannot finish the job.
 */

/** Collapses the retry gap so the retry POLICY can be tested in milliseconds. */
class TestableService extends RosterProvisioningService {
    protected override async sleep(): Promise<void> {
        // The 5-second production gap is a real requirement, and no test
        // should spend fifteen seconds proving it exists.
    }
}

function input(overrides: Partial<RosterProvisionInput> = {}): RosterProvisionInput {
    return {
        userId: 'user-1',
        tenantId: 'tenant-1',
        organizationId: null,
        runId: 'run-1',
        blueprintSlug: 'general',
        lanes: [
            { laneKey: 'coordination', name: 'Ada' },
            { laneKey: 'research', name: 'Research' },
            { laneKey: 'content', name: 'Content' },
        ],
        ...overrides,
    };
}

function seatError(): Error {
    // Recognised by its stable `name`, exactly as the API's 402 filter
    // recognises it — the agents package must not import billing.
    const error = new Error('Seat limit reached: 2 of 2 seats in use.');
    error.name = 'SeatLimitExceededError';
    return error;
}

interface Harness {
    service: RosterProvisioningService;
    templates: { createFromTemplate: jest.Mock };
    agents: { update: jest.Mock; resume: jest.Mock };
    agentRepository: { findByUserAndLanes: jest.Mock };
    collaborators: { upsert: jest.Mock };
    checklists: { patch: jest.Mock };
    skillBinder: { attach: jest.Mock };
}

function harness(
    options: {
        created?: (slug: string, name: string) => Promise<{ id: string; name: string }>;
        held?: Array<{ id: string; lane: string; status?: AgentStatus }>;
        withSkillBinder?: boolean;
    } = {},
): Harness {
    let sequence = 0;
    const templates = {
        createFromTemplate: jest.fn(
            async (_userId: string, slug: string, createInput: { name?: string | null }) => {
                if (options.created) return options.created(slug, createInput.name ?? '');
                sequence += 1;
                return { id: `agent-${sequence}`, name: createInput.name ?? slug };
            },
        ),
    };
    const agents = {
        update: jest.fn(async () => ({})),
        resume: jest.fn(async () => ({})),
    };
    const agentRepository = {
        findByUserAndLanes: jest.fn(async () =>
            (options.held ?? []).map((row) => ({
                id: row.id,
                lane: row.lane,
                status: row.status ?? AgentStatus.ACTIVE,
            })),
        ),
    };
    const collaborators = { upsert: jest.fn(async () => ({})) };
    const checklists = { patch: jest.fn(async () => ({})) };
    const skillBinder = { attach: jest.fn(async () => undefined) };

    const service = new TestableService(
        templates as never,
        agents as never,
        agentRepository as never,
        collaborators as never,
        checklists as never,
        options.withSkillBinder === false ? undefined : (skillBinder as never),
    );

    return { service, templates, agents, agentRepository, collaborators, checklists, skillBinder };
}

describe('RosterProvisioningService.execute', () => {
    it('creates every lane in blueprint order, one at a time, and reports ready', async () => {
        const h = harness();

        const record = await h.service.execute(input());

        expect(record.state).toBe('ready');
        expect(record.lanes.map((lane) => lane.outcome)).toEqual(['created', 'created', 'created']);
        // Order, not just count: agent names are unique per person, so a
        // parallelised loop races that check into false conflicts.
        expect(h.templates.createFromTemplate.mock.calls.map((call) => call[1])).toEqual([
            'workspace-coordinator',
            'lead-researcher',
            'content-marketer',
        ]);
        expect(record.finishedAt).toBeTruthy();
    });

    it('stamps every created agent with its lane and leaves it active with no cadence', async () => {
        const h = harness();

        await h.service.execute(input());

        const lanes = h.templates.createFromTemplate.mock.calls.map((call) => call[2].lane);
        expect(lanes).toEqual(['coordination', 'research', 'content']);
        expect(h.agents.resume).toHaveBeenCalledTimes(3);
        // FR-21 — a roster agent acts when given work, never on a cadence
        // of its own. Arming one is an explicit act, later.
        for (const call of h.templates.createFromTemplate.mock.calls) {
            expect(call[2].heartbeatCadence).toBeUndefined();
        }
        for (const call of h.agents.update.mock.calls) {
            expect(call[2].heartbeatCadence).toBeUndefined();
        }
    });

    it('points every non-coordinator at the coordinator and fills its allow-list', async () => {
        const h = harness();

        const record = await h.service.execute(input());
        const coordinatorId = record.lanes[0].agentId;

        expect(h.agents.update).toHaveBeenCalledTimes(2);
        for (const call of h.agents.update.mock.calls) {
            expect(call[2]).toEqual({ reportsToAgentId: coordinatorId });
        }
        expect(h.collaborators.upsert).toHaveBeenCalledTimes(2);
        for (const call of h.collaborators.upsert.mock.calls) {
            expect(call[0].agentId).toBe(coordinatorId);
            expect(call[0].enabled).toBe(true);
        }
        // The coordinator is never added to its own allow-list.
        expect(
            h.collaborators.upsert.mock.calls.map((call) => call[0].collaboratorAgentId),
        ).not.toContain(coordinatorId);
    });

    it('reuses a lane somebody already holds instead of creating a second one', async () => {
        const h = harness({ held: [{ id: 'existing-research', lane: 'research' }] });

        const record = await h.service.execute(input());

        expect(record.state).toBe('ready');
        const research = record.lanes.find((lane) => lane.laneKey === 'research');
        expect(research?.outcome).toBe('reused');
        expect(research?.agentId).toBe('existing-research');
        expect(h.templates.createFromTemplate.mock.calls.map((call) => call[1])).toEqual([
            'workspace-coordinator',
            'content-marketer',
        ]);
    });

    it('leaves a reused agent alone apart from the coordinator allow-list', async () => {
        const h = harness({ held: [{ id: 'existing-research', lane: 'research' }] });

        const record = await h.service.execute(input());
        const coordinatorId = record.lanes[0].agentId;

        // FR-24 — an agent this run did not create may already be doing
        // work under settings its owner chose. It is not re-pointed and
        // not re-activated.
        expect(h.agents.update.mock.calls.map((call) => call[1])).not.toContain(
            'existing-research',
        );
        expect(h.agents.resume.mock.calls.map((call) => call[1])).not.toContain(
            'existing-research',
        );
        expect(h.collaborators.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                agentId: coordinatorId,
                collaboratorAgentId: 'existing-research',
                enabled: true,
            }),
        );
    });

    it('reports every lane as reused on a second run and creates nothing', async () => {
        const h = harness({
            held: [
                { id: 'a-coordination', lane: 'coordination' },
                { id: 'a-research', lane: 'research' },
                { id: 'a-content', lane: 'content' },
            ],
        });

        const record = await h.service.execute(input({ runId: 'run-2' }));

        expect(record.state).toBe('ready');
        expect(record.lanes.every((lane) => lane.outcome === 'reused')).toBe(true);
        expect(h.templates.createFromTemplate).not.toHaveBeenCalled();
    });

    it('walks a numeric suffix past a taken name and says which name it used', async () => {
        const taken = new Set(['Research', 'Research 2']);
        const h = harness({
            created: async (_slug, name) => {
                if (taken.has(name)) throw new ConflictException(`"${name}" already exists.`);
                return { id: `agent-${name}`, name };
            },
        });

        const record = await h.service.execute(input());
        const research = record.lanes.find((lane) => lane.laneKey === 'research');

        expect(research?.outcome).toBe('created');
        expect(research?.finalName).toBe('Research 3');
    });

    it('fails only that lane when every suffix from 2 to 9 is taken', async () => {
        const h = harness({
            created: async (_slug, name) => {
                if (name.startsWith('Research')) {
                    throw new ConflictException(`"${name}" already exists.`);
                }
                return { id: `agent-${name}`, name };
            },
        });

        const record = await h.service.execute(input());

        expect(record.state).toBe('partial');
        const research = record.lanes.find((lane) => lane.laneKey === 'research');
        expect(research?.outcome).toBe('failed');
        expect(research?.failureReason).toBe('nameUnavailable');
        // The rest of the roster is unaffected.
        expect(record.lanes.find((lane) => lane.laneKey === 'content')?.outcome).toBe('created');
    });

    it('skips the current and every remaining lane when the plan runs out of seats', async () => {
        const h = harness({
            created: async (_slug, name) => {
                if (name === 'Ada') return { id: 'agent-ada', name };
                throw seatError();
            },
        });

        const record = await h.service.execute(input());

        expect(record.state).toBe('partial');
        expect(record.lanes.map((lane) => lane.outcome)).toEqual([
            'created',
            'skippedNoSeat',
            'skippedNoSeat',
        ]);
        expect(record.lanes[2].failureReason).toBe('noSeat');
        // Retrying a refusal that is about the plan, not the request,
        // would only reproduce it more slowly.
        expect(h.templates.createFromTemplate).toHaveBeenCalledTimes(2);
    });

    it('reports failed when the very first lane runs out of seats and nothing lands', async () => {
        const h = harness({
            created: async () => {
                throw seatError();
            },
        });

        const record = await h.service.execute(input());

        expect(record.state).toBe('failed');
        expect(record.lanes.every((lane) => lane.outcome === 'skippedNoSeat')).toBe(true);
    });

    it('retries a transient failure and succeeds without failing the lane', async () => {
        let attempts = 0;
        const h = harness({
            created: async (_slug, name) => {
                if (name === 'Research') {
                    attempts += 1;
                    if (attempts < 3) throw new Error('connection reset');
                }
                return { id: `agent-${name}`, name };
            },
        });

        const record = await h.service.execute(input());

        expect(attempts).toBe(3);
        expect(record.lanes.find((lane) => lane.laneKey === 'research')?.outcome).toBe('created');
        expect(record.state).toBe('ready');
    });

    it('gives up on a lane after three attempts and keeps the run going', async () => {
        const h = harness({
            created: async (_slug, name) => {
                if (name === 'Research') throw new Error('connection reset');
                return { id: `agent-${name}`, name };
            },
        });

        const record = await h.service.execute(input());

        const research = record.lanes.find((lane) => lane.laneKey === 'research');
        expect(research?.outcome).toBe('failed');
        expect(research?.failureReason).toBe('unknown');
        expect(record.state).toBe('partial');
        expect(record.lanes.find((lane) => lane.laneKey === 'content')?.outcome).toBe('created');
    });

    it('turns a skill that will not attach into a warning, never a failed lane', async () => {
        const h = harness();
        h.skillBinder.attach.mockRejectedValue(new Error('catalog unavailable'));

        const record = await h.service.execute(input());

        expect(record.state).toBe('ready');
        for (const lane of record.lanes) {
            expect(lane.outcome).toBe('created');
            expect((lane.skillWarnings ?? []).length).toBeGreaterThan(0);
        }
    });

    it('records no skill warnings at all when no binder is wired', async () => {
        const h = harness({ withSkillBinder: false });

        const record = await h.service.execute(input());

        // "We did not try" and "we tried and failed" are different facts.
        for (const lane of record.lanes) {
            expect(lane.skillWarnings).toBeUndefined();
        }
    });

    it('survives a binding step that throws, because the rows already exist', async () => {
        const h = harness();
        h.agents.update.mockRejectedValue(new Error('reporting line write failed'));
        h.collaborators.upsert.mockRejectedValue(new Error('allow-list write failed'));
        h.agents.resume.mockRejectedValue(new Error('activation failed'));

        const record = await h.service.execute(input());

        expect(record.state).toBe('ready');
        expect(record.lanes.every((lane) => lane.outcome === 'created')).toBe(true);
    });

    it('rejects a lane it does not ship without touching the rest of the roster', async () => {
        const h = harness();

        const record = await h.service.execute(
            input({
                lanes: [
                    { laneKey: 'coordination', name: 'Ada' },
                    { laneKey: 'not-a-lane' as never, name: 'Mystery' },
                ],
            }),
        );

        expect(record.state).toBe('partial');
        expect(record.lanes[1].outcome).toBe('failed');
        expect(record.lanes[1].failureReason).toBe('unknown');
        expect(h.templates.createFromTemplate).toHaveBeenCalledTimes(1);
    });

    it('writes progress after every lane, not only when the run ends', async () => {
        const h = harness();

        await h.service.execute(input());

        // queued→creating, one per lane, binding, terminal — the panel
        // has to be able to name what happened WHILE the run is going.
        expect(h.checklists.patch.mock.calls.length).toBeGreaterThanOrEqual(6);
        const states = h.checklists.patch.mock.calls.map(
            (call) => call[2].provisioning.state as string,
        );
        expect(states[0]).toBe('creating');
        expect(states).toContain('binding');
        expect(states[states.length - 1]).toBe('ready');
    });

    it('still returns a record when nothing can be persisted', async () => {
        const h = harness();
        h.checklists.patch.mockRejectedValue(new Error('database down'));

        const record = await h.service.execute(input());

        expect(record.state).toBe('ready');
        expect(record.runId).toBe('run-1');
    });

    it('does not duplicate a roster when the existing-lane lookup fails', async () => {
        const h = harness();
        h.agentRepository.findByUserAndLanes.mockRejectedValue(new Error('read failed'));

        const record = await h.service.execute(input());

        // The partial unique index on (userId, lane) is the real backstop;
        // the lookup failing must not take the whole run down.
        expect(record.state).toBe('ready');
        expect(h.templates.createFromTemplate).toHaveBeenCalledTimes(3);
    });
});
