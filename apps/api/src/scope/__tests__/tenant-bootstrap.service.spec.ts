// Mock the agent database barrel to avoid pulling in the full TypeORM
// DataSource graph (which transitively imports `@src/config` and other
// runtime modules). Same pattern as `auth.service.spec.ts`.
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));

import { NotFoundException } from '@nestjs/common';
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
});
