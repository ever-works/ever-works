import { BadRequestException } from '@nestjs/common';
import { FleetExecutionPreference } from '../../entities/fleet-execution-preference.entity';
import { FleetExecutionPreferenceService } from '../fleet-execution-preference.service';

const WORK_ID = '22222222-2222-4222-8222-222222222222';
const GOAL_ID = '33333333-3333-4333-8333-333333333333';

const row = (overrides: Partial<FleetExecutionPreference> = {}): FleetExecutionPreference =>
    ({
        id: 'pref-1',
        userId: 'user-1',
        organizationId: null,
        scopeType: 'user',
        scopeId: null,
        mode: 'local-fallback',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
    }) as FleetExecutionPreference;

describe('FleetExecutionPreferenceService', () => {
    let repository: {
        findByUser: jest.Mock;
        findOne: jest.Mock;
        upsert: jest.Mock;
        remove: jest.Mock;
    };

    beforeEach(() => {
        repository = {
            findByUser: jest.fn(async () => []),
            findOne: jest.fn(async () => null),
            upsert: jest.fn(async (data) => row(data)),
            remove: jest.fn(async () => true),
        };
    });

    const build = () => new FleetExecutionPreferenceService(repository as never);

    describe('setForUser', () => {
        it('stores an account-wide row with a null scopeId', async () => {
            const view = await build().setForUser('user-1', {
                scopeType: 'user',
                mode: 'local-wait',
            });

            expect(repository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-1', scopeType: 'user', scopeId: null }),
            );
            expect(view.mode).toBe('local-wait');
            expect(view.scopeId).toBeNull();
        });

        it('DROPS a scopeId supplied for the account scope', async () => {
            // Otherwise the row would be invisible to resolution: the
            // account lookup matches on `scopeId IS NULL`.
            await build().setForUser('user-1', {
                scopeType: 'user',
                scopeId: WORK_ID,
                mode: 'cloud',
            });

            expect(repository.upsert.mock.calls[0][0].scopeId).toBeNull();
        });

        it('stores a Work-scoped row with its id', async () => {
            await build().setForUser('user-1', {
                scopeType: 'work',
                scopeId: WORK_ID,
                mode: 'local-wait',
            });

            expect(repository.upsert.mock.calls[0][0]).toMatchObject({
                scopeType: 'work',
                scopeId: WORK_ID,
            });
        });

        it.each([
            ['missing', undefined],
            ['blank', '   '],
            ['not a uuid', 'my-work'],
        ])('rejects a Work preference whose id is %s', async (_label, scopeId) => {
            // A `work` row with no id would silently behave like an
            // account default — "saved fine, did nothing".
            await expect(
                build().setForUser('user-1', {
                    scopeType: 'work',
                    scopeId: scopeId as string | undefined,
                    mode: 'cloud',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(repository.upsert).not.toHaveBeenCalled();
        });

        it('rejects an unknown mode', async () => {
            await expect(
                build().setForUser('user-1', {
                    scopeType: 'user',
                    mode: 'teleport' as never,
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects an unknown scope type', async () => {
            await expect(
                build().setForUser('user-1', {
                    scopeType: 'galaxy' as never,
                    mode: 'cloud',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('clearForUser', () => {
        it('clears the account row', async () => {
            await build().clearForUser('user-1', 'user');
            expect(repository.remove).toHaveBeenCalledWith('user-1', 'user', null);
        });

        it('is idempotent — clearing an unset scope is not an error', async () => {
            repository.remove.mockResolvedValue(false);
            await expect(build().clearForUser('user-1', 'work', WORK_ID)).resolves.toBeUndefined();
        });
    });

    describe('resolveForUser', () => {
        it('applies narrowest-wins across the stored rows', async () => {
            repository.findByUser.mockResolvedValue([
                row({ id: 'a', scopeType: 'user', scopeId: null, mode: 'cloud' }),
                row({ id: 'b', scopeType: 'goal', scopeId: GOAL_ID, mode: 'local-fallback' }),
                row({ id: 'c', scopeType: 'work', scopeId: WORK_ID, mode: 'local-wait' }),
            ]);
            const service = build();

            await expect(
                service.resolveForUser('user-1', { workId: WORK_ID, goalId: GOAL_ID }),
            ).resolves.toBe('local-wait');
            await expect(service.resolveForUser('user-1', { goalId: GOAL_ID })).resolves.toBe(
                'local-fallback',
            );
            await expect(service.resolveForUser('user-1', {})).resolves.toBe('cloud');
        });

        it('reads rows scoped to the OWNER, never globally', async () => {
            await build().resolveForUser('user-1', { workId: WORK_ID });
            // A Work id travels (it is in URLs and payloads); resolving it
            // without the owner would make it a cross-account read.
            expect(repository.findByUser).toHaveBeenCalledWith('user-1');
        });

        it('degrades to the default when the lookup throws, instead of failing the run', async () => {
            repository.findByUser.mockRejectedValue(new Error('db down'));

            await expect(build().resolveForUser('user-1', {})).resolves.toBe('local-fallback');
        });
    });

    describe('listForUser', () => {
        it('projects rows to views without leaking the owner id', async () => {
            repository.findByUser.mockResolvedValue([row({ scopeType: 'work', scopeId: WORK_ID })]);

            const [view] = await build().listForUser('user-1');

            expect(view).toEqual({
                id: 'pref-1',
                scopeType: 'work',
                scopeId: WORK_ID,
                mode: 'local-fallback',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });
            expect(view).not.toHaveProperty('userId');
        });
    });
});
