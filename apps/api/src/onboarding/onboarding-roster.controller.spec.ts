import { BadRequestException, ConflictException } from '@nestjs/common';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OnboardingRosterController } from './onboarding-roster.controller';
import { ProvisionRosterDto } from './dto/onboarding-roster.dto';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * AW-20 P1 — the roster endpoints.
 *
 * The three behaviours worth pinning here are all about NOT creating
 * agents twice: a second request while a run is going is refused, an
 * unknown lane is refused before anything is written, and a dispatcher
 * that could not enqueue is recorded as failed rather than left looking
 * queued forever.
 */

const auth = { userId: 'user-1' } as AuthenticatedUser;

function lanes(...keys: string[]) {
    return keys.map((key) => ({ laneKey: key, name: key }));
}

interface Harness {
    controller: OnboardingRosterController;
    checklists: {
        ensure: jest.Mock;
        find: jest.Mock;
        patch: jest.Mock;
        startProvisioningIfUnchanged: jest.Mock;
    };
    agents: { findByUserAndLanes: jest.Mock };
    dispatcher: { dispatchRosterProvision: jest.Mock };
}

function harness(
    options: {
        row?: Record<string, unknown>;
        dispatch?: string | null;
        roles?: string[];
        teamSize?: string;
    } = {},
): Harness {
    const row = options.row ?? { id: 'row-1', updatedAt: new Date('2026-09-16T10:00:00Z') };
    const checklists = {
        ensure: jest.fn(async () => row),
        find: jest.fn(async () => row),
        patch: jest.fn(async () => row),
        startProvisioningIfUnchanged: jest.fn(async () => true),
    };
    const agents = { findByUserAndLanes: jest.fn(async () => []) };
    const dispatcher = {
        dispatchRosterProvision: jest.fn(async () =>
            options.dispatch === undefined ? 'handle-1' : options.dispatch,
        ),
    };
    const stateService = {
        getState: jest.fn(async () => ({
            state: { profile: { roles: options.roles ?? [], teamSize: options.teamSize } },
        })),
    };
    const scopeContext = { getScope: () => ({ tenantId: 'tenant-1', organizationId: null }) };

    const controller = new OnboardingRosterController(
        checklists as never,
        agents as never,
        stateService as never,
        dispatcher as never,
        scopeContext as never,
    );

    return { controller, checklists, agents, dispatcher };
}

describe('ProvisionRosterDto validation', () => {
    async function errorsFor(body: unknown): Promise<string[]> {
        const dto = plainToInstance(ProvisionRosterDto, body);
        const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
        return errors.flatMap((error) => [
            error.property,
            ...(error.children ?? []).map((child) => child.property),
        ]);
    }

    it('accepts a well-formed roster', async () => {
        expect(await errorsFor({ lanes: lanes('coordination', 'research') })).toEqual([]);
    });

    it('rejects a lane key the platform does not ship', async () => {
        expect(await errorsFor({ lanes: lanes('coordination', 'not-a-lane') })).toContain('lanes');
    });

    it('rejects a repeated lane key', async () => {
        expect(await errorsFor({ lanes: lanes('coordination', 'research', 'research') })).toContain(
            'lanes',
        );
    });

    it('rejects a roster with nobody to hand ambiguous work to', async () => {
        expect(await errorsFor({ lanes: lanes('research', 'content') })).toContain('lanes');
    });

    it('rejects more lanes than the ceiling allows', async () => {
        expect(
            await errorsFor({
                lanes: lanes(
                    'coordination',
                    'research',
                    'content',
                    'outreach',
                    'visibility',
                    'social',
                    'market-watch',
                    'coordination',
                    'research',
                ),
            }),
        ).toContain('lanes');
    });

    it('rejects an empty name and one past the ceiling', async () => {
        expect(await errorsFor({ lanes: [{ laneKey: 'coordination', name: '' }] })).toContain(
            'lanes',
        );
        expect(
            await errorsFor({ lanes: [{ laneKey: 'coordination', name: 'x'.repeat(61) }] }),
        ).toContain('lanes');
    });

    it('rejects an unknown blueprint slug', async () => {
        expect(
            await errorsFor({ blueprintSlug: 'not-a-blueprint', lanes: lanes('coordination') }),
        ).toContain('blueprintSlug');
    });
});

describe('OnboardingRosterController', () => {
    describe('GET /blueprints', () => {
        it('derives the proposal from the roles and team size already answered', async () => {
            const h = harness({ roles: ['marketing'], teamSize: 'solo' });

            const result = await h.controller.blueprints(auth);

            expect(result.blueprintSlug).toBe('growth');
            expect(result.derivedFromRoles).toBe(true);
            expect(result.laneCap).toBe(3);
            expect(result.proposal).toHaveLength(3);
            expect(result.proposal[0].isCoordinator).toBe(true);
            expect(result.catalog.length).toBeGreaterThan(result.proposal.length);
        });

        it('proposes the general blueprint when the roles step was skipped', async () => {
            const h = harness({ roles: [] });

            const result = await h.controller.blueprints(auth);

            expect(result.blueprintSlug).toBe('general');
            expect(result.derivedFromRoles).toBe(false);
        });

        it('returns i18n leaves, never display copy', async () => {
            const h = harness({ roles: ['marketing'] });

            const result = await h.controller.blueprints(auth);

            for (const option of result.catalog) {
                expect(option.labelKey).not.toContain('.');
                expect(option.labelKey).toMatch(/^[a-z][a-zA-Z0-9]*$/);
            }
        });
    });

    describe('POST /provision', () => {
        it('records the run and returns queued without waiting for any agent', async () => {
            const h = harness();

            const result = await h.controller.provision(auth, {
                lanes: lanes('coordination', 'research'),
            } as never);

            expect(result.state).toBe('queued');
            expect(result.runId).toHaveLength(36);
            expect(h.checklists.startProvisioningIfUnchanged).toHaveBeenCalledTimes(1);
            const queued = h.checklists.startProvisioningIfUnchanged.mock.calls[0][3];
            expect(queued.state).toBe('queued');
            expect(queued.lanes.map((lane: { outcome: string }) => lane.outcome)).toEqual([
                'pending',
                'pending',
            ]);
            expect(h.dispatcher.dispatchRosterProvision).toHaveBeenCalledTimes(1);
        });

        it('carries the workspace scope into the job, so agents are not created unstamped', async () => {
            const h = harness();

            await h.controller.provision(auth, { lanes: lanes('coordination') } as never);

            expect(h.dispatcher.dispatchRosterProvision).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    tenantId: 'tenant-1',
                    organizationId: null,
                }),
            );
        });

        it('refuses a second request while a run is already going', async () => {
            const h = harness({
                row: {
                    id: 'row-1',
                    updatedAt: new Date(),
                    provisioning: { runId: 'run-in-flight', state: 'creating' },
                },
            });

            await expect(
                h.controller.provision(auth, { lanes: lanes('coordination') } as never),
            ).rejects.toBeInstanceOf(ConflictException);
            expect(h.dispatcher.dispatchRosterProvision).not.toHaveBeenCalled();
        });

        it('refuses the tab that loses the compare-and-set, rather than queueing twice', async () => {
            const h = harness();
            h.checklists.startProvisioningIfUnchanged.mockResolvedValue(false);

            await expect(
                h.controller.provision(auth, { lanes: lanes('coordination') } as never),
            ).rejects.toBeInstanceOf(ConflictException);
            expect(h.dispatcher.dispatchRosterProvision).not.toHaveBeenCalled();
        });

        it('starts a fresh run once the previous one has ended', async () => {
            const h = harness({
                row: {
                    id: 'row-1',
                    updatedAt: new Date(),
                    provisioning: { runId: 'run-old', state: 'partial' },
                },
            });

            const result = await h.controller.provision(auth, {
                lanes: lanes('coordination'),
            } as never);

            expect(result.state).toBe('queued');
            expect(result.runId).not.toBe('run-old');
        });

        it('rejects a lane it does not ship, before anything is written', async () => {
            const h = harness();

            await expect(
                h.controller.provision(auth, {
                    lanes: [{ laneKey: 'not-a-lane', name: 'Mystery' }],
                } as never),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(h.checklists.startProvisioningIfUnchanged).not.toHaveBeenCalled();
            expect(h.dispatcher.dispatchRosterProvision).not.toHaveBeenCalled();
        });

        it('records a failed run when nothing could pick the work up', async () => {
            const h = harness({ dispatch: null });

            const result = await h.controller.provision(auth, {
                lanes: lanes('coordination', 'research'),
            } as never);

            // A record left saying `queued` would be polled until the panel
            // stalls; `failed` is what puts a Try again in front of the user.
            expect(result.state).toBe('failed');
            const patched = h.checklists.patch.mock.calls.at(-1)?.[2].provisioning;
            expect(patched.state).toBe('failed');
            expect(
                patched.lanes.every(
                    (lane: { outcome: string; failureReason: string }) =>
                        lane.outcome === 'failed' && lane.failureReason === 'unknown',
                ),
            ).toBe(true);
        });

        it('records a failed run when the dispatcher itself throws', async () => {
            const h = harness();
            h.dispatcher.dispatchRosterProvision.mockRejectedValue(new Error('queue unreachable'));

            const result = await h.controller.provision(auth, {
                lanes: lanes('coordination'),
            } as never);

            expect(result.state).toBe('failed');
        });
    });

    describe('POST /acknowledge', () => {
        it('records the acknowledgement the first time', async () => {
            const h = harness();

            await h.controller.acknowledge(auth);

            expect(h.checklists.patch).toHaveBeenCalledWith(
                'user-1',
                null,
                expect.objectContaining({ rosterAcknowledgedAt: expect.any(Date) }),
            );
        });

        it('keeps the first timestamp when acknowledged again', async () => {
            const h = harness({
                row: {
                    id: 'row-1',
                    updatedAt: new Date(),
                    rosterAcknowledgedAt: new Date('2026-09-16T09:00:00Z'),
                },
            });

            const result = await h.controller.acknowledge(auth);

            expect(h.checklists.patch).not.toHaveBeenCalled();
            expect(result.acknowledgedAt).toBe('2026-09-16T09:00:00.000Z');
        });
    });

    describe('GET /', () => {
        it('reports idle with no agents for someone who never provisioned', async () => {
            const h = harness({ row: { id: 'row-1', updatedAt: new Date() } });

            const result = await h.controller.state(auth);

            expect(result.state).toBe('idle');
            expect(result.provisioning).toBeNull();
            expect(result.agents).toEqual([]);
        });

        it('names each roster agent, its lane and who it reports to', async () => {
            const h = harness({
                row: {
                    id: 'row-1',
                    updatedAt: new Date(),
                    provisioning: { runId: 'run-1', state: 'ready', lanes: [] },
                },
            });
            h.agents.findByUserAndLanes.mockResolvedValue([
                {
                    id: 'a1',
                    name: 'Ada',
                    lane: 'coordination',
                    title: 'Routing',
                    reportsToAgentId: null,
                },
                {
                    id: 'a2',
                    name: 'Research',
                    lane: 'research',
                    title: 'Lead research',
                    reportsToAgentId: 'a1',
                },
            ]);

            const result = await h.controller.state(auth);

            expect(result.state).toBe('ready');
            expect(result.agents.map((agent) => agent.lane)).toEqual(['coordination', 'research']);
            expect(result.agents[1].reportsToName).toBe('Ada');
            expect(result.agents[1].skills.length).toBeGreaterThan(0);
        });
    });

    describe('throttling', () => {
        it('caps provisioning at five an hour and acknowledgement at twenty a minute', () => {
            const provision = OnboardingRosterController.prototype.provision;
            expect(Reflect.getMetadata(THROTTLER_LIMIT + 'long', provision)).toBe(5);
            expect(Reflect.getMetadata(THROTTLER_TTL + 'long', provision)).toBe(3_600_000);

            const acknowledge = OnboardingRosterController.prototype.acknowledge;
            expect(Reflect.getMetadata(THROTTLER_LIMIT + 'long', acknowledge)).toBe(20);
            expect(Reflect.getMetadata(THROTTLER_TTL + 'long', acknowledge)).toBe(60_000);
        });
    });
});
