// Mock the agent database barrel to avoid pulling in the full TypeORM
// DataSource graph (which transitively imports `@src/config` and other
// runtime modules). Same pattern as `auth.service.spec.ts`.
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { TenantBootstrapService } from '../tenant-bootstrap.service';

describe('TenantBootstrapService (EW-658 Phase 6)', () => {
    const makeUser = (overrides: Record<string, unknown> = {}) => ({
        id: 'u-1',
        username: 'alice',
        tenantId: null,
        ...overrides,
    });

    function makeService(opts: {
        userById?: ReturnType<typeof makeUser> | null;
        tenantById?: { id: string; slug: string; ownerUserId: string } | null;
        tenantByOwner?: { id: string; slug: string; ownerUserId: string } | null;
    }) {
        const userRepository = {
            findById: jest.fn().mockResolvedValue(opts.userById ?? null),
            update: jest.fn().mockResolvedValue(undefined),
        };
        const tenantRepository = {
            findById: jest.fn().mockResolvedValue(opts.tenantById ?? null),
            findByOwnerUserId: jest.fn().mockResolvedValue(opts.tenantByOwner ?? null),
            create: jest.fn(async (data: Record<string, unknown>) => ({
                id: 't-new',
                ...data,
            })),
        };
        const usernameAllocator = {
            allocateUsername: jest.fn(async (s: string) => s),
        };
        const service = new TenantBootstrapService(
            userRepository as never,
            tenantRepository as never,
            usernameAllocator as never,
        );
        return { service, userRepository, tenantRepository, usernameAllocator };
    }

    it('throws NotFoundException if user does not exist', async () => {
        const { service } = makeService({ userById: null });
        await expect(service.ensureTenant('u-missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the existing Tenant when the user already has one', async () => {
        const existing = { id: 't-existing', slug: 'alice', ownerUserId: 'u-1' };
        const { service, tenantRepository, userRepository } = makeService({
            userById: makeUser({ tenantId: 't-existing' }),
            tenantById: existing,
        });

        const result = await service.ensureTenant('u-1');

        expect(result).toEqual(existing);
        expect(tenantRepository.findById).toHaveBeenCalledWith('t-existing');
        // No create / no user update — idempotent.
        expect(tenantRepository.create).not.toHaveBeenCalled();
        expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('lazy-creates a Tenant for a user with tenantId IS NULL', async () => {
        const { service, tenantRepository, userRepository, usernameAllocator } = makeService({
            userById: makeUser({ tenantId: null }),
        });

        const result = await service.ensureTenant('u-1');

        expect(usernameAllocator.allocateUsername).toHaveBeenCalledWith('alice');
        expect(tenantRepository.create).toHaveBeenCalledWith({
            ownerUserId: 'u-1',
            slug: 'alice',
            displayName: 'alice',
        });
        expect(userRepository.update).toHaveBeenCalledWith('u-1', { tenantId: 't-new' });
        expect(result.id).toBe('t-new');
    });

    it('returns the race-creator Tenant if findByOwnerUserId finds one before create', async () => {
        const raceWinner = { id: 't-race', slug: 'alice', ownerUserId: 'u-1' };
        const { service, tenantRepository, userRepository } = makeService({
            userById: makeUser({ tenantId: null }),
            tenantByOwner: raceWinner,
        });

        const result = await service.ensureTenant('u-1');

        expect(result).toEqual(raceWinner);
        // No create — the race winner already exists.
        expect(tenantRepository.create).not.toHaveBeenCalled();
        // User is re-linked to the race-winner Tenant.
        expect(userRepository.update).toHaveBeenCalledWith('u-1', { tenantId: 't-race' });
    });

    it('does not re-link when the user already points at the race-winner', async () => {
        const raceWinner = { id: 't-race', slug: 'alice', ownerUserId: 'u-1' };
        const { service, userRepository } = makeService({
            userById: makeUser({ tenantId: 't-race' }),
            // Simulate the path where tenantId is set but findById returns null
            // (defensive — shouldn't happen), and findByOwnerUserId finds the race winner.
            tenantById: null,
            tenantByOwner: raceWinner,
        });

        await service.ensureTenant('u-1');

        // user.tenantId already matches race-winner — no redundant update.
        expect(userRepository.update).not.toHaveBeenCalled();
    });

    /**
     * `joinTenant` — accepting an Organization invitation.
     *
     * The only writer in the codebase that points a user at a Tenant they do
     * not own, so the refusal is the thing under test, not the happy path.
     */
    describe('joinTenant', () => {
        it('attaches a user who has no Tenant yet', async () => {
            const { service, userRepository } = makeService({
                userById: makeUser({ id: 'u-1', tenantId: null }),
            });

            await expect(service.joinTenant('u-1', 't-host', 'org-1')).resolves.toBe('joined');
            expect(userRepository.update).toHaveBeenCalledWith('u-1', { tenantId: 't-host' });
        });

        it(`🛑 REFUSES to move a user who already belongs to a different Tenant`, async () => {
            // The single largest data-integrity risk in the whole feature.
            // Every row they own is stamped with the OLD tenantId, so
            // repointing this column silently hides their entire history —
            // data loss without a DELETE. It must throw, never "best effort".
            const { service, userRepository } = makeService({
                userById: makeUser({ id: 'u-1', tenantId: 't-their-own' }),
            });

            await expect(service.joinTenant('u-1', 't-host', 'org-1')).rejects.toBeInstanceOf(
                ConflictException,
            );
            // And critically: nothing was written on the way to the throw.
            expect(userRepository.update).not.toHaveBeenCalled();
        });

        it('is idempotent when they are already in this Tenant', async () => {
            // A second redemption of the same invitation, or a double-clicked
            // accept, must read as success rather than as a conflict.
            const { service, userRepository } = makeService({
                userById: makeUser({ id: 'u-1', tenantId: 't-host' }),
            });

            await expect(service.joinTenant('u-1', 't-host', 'org-1')).resolves.toBe(
                'already_member',
            );
            expect(userRepository.update).not.toHaveBeenCalled();
        });

        it('404s an unknown user instead of writing anything', async () => {
            const { service, userRepository } = makeService({ userById: null });
            await expect(service.joinTenant('u-ghost', 't-host')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(userRepository.update).not.toHaveBeenCalled();
        });

        it('sets the landing scope only when the user has no preference', async () => {
            const fresh = makeService({
                userById: makeUser({ id: 'u-1', tenantId: null, lastScopeOrganizationId: null }),
            });
            await fresh.service.joinTenant('u-1', 't-host', 'org-1');
            expect(fresh.userRepository.update).toHaveBeenCalledWith('u-1', {
                lastScopeOrganizationId: 'org-1',
            });

            // Someone with an existing choice keeps it — joining an Org must
            // not yank them out of whatever scope they were last working in.
            const settled = makeService({
                userById: makeUser({
                    id: 'u-2',
                    tenantId: null,
                    lastScopeOrganizationId: 'org-previous',
                }),
            });
            await settled.service.joinTenant('u-2', 't-host', 'org-1');
            expect(settled.userRepository.update).not.toHaveBeenCalledWith(
                'u-2',
                expect.objectContaining({ lastScopeOrganizationId: 'org-1' }),
            );
        });

        it('never runs the tenantId backfill', async () => {
            // createOrganization walks TIER_A + TIER_B tables stamping the
            // new tenantId onto the user's existing rows. Doing that here
            // would drag an invitee's private history into the inviter's
            // Tenant, where it becomes visible tenant-wide. The only write
            // this method may make is to `users`.
            const { service, userRepository, tenantRepository } = makeService({
                userById: makeUser({ id: 'u-1', tenantId: null }),
            });

            await service.joinTenant('u-1', 't-host', 'org-1');

            for (const call of userRepository.update.mock.calls) {
                expect(Object.keys(call[1])).toEqual(
                    expect.arrayContaining([
                        expect.stringMatching(/^(tenantId|lastScopeOrganizationId)$/),
                    ]),
                );
            }
            expect(tenantRepository.create).not.toHaveBeenCalled();
        });
    });
});
