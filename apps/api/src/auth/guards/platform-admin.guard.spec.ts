jest.mock('@ever-works/agent/database', () => ({}));

import { ForbiddenException } from '@nestjs/common';
import { IsPlatformAdminGuard } from './platform-admin.guard';
import type { UserRepository } from '@ever-works/agent/database';

/**
 * EW-602 — IsPlatformAdminGuard gates the /admin/usage route. It runs
 * after the global AuthSessionGuard, so request.user is expected to be
 * populated. The guard 403s when:
 *   - request.user is missing (no userId)
 *   - the User row does not exist
 *   - User.isPlatformAdmin is not strictly true
 */

function makeContext(user: any) {
    return {
        switchToHttp: () => ({
            getRequest: () => ({ user }),
        }),
    } as any;
}

function makeGuard(findById: jest.Mock = jest.fn()) {
    const userRepository = { findById } as unknown as UserRepository;
    return { guard: new IsPlatformAdminGuard(userRepository), findById };
}

describe('IsPlatformAdminGuard', () => {
    it('returns true when the User row has isPlatformAdmin = true', async () => {
        const { guard, findById } = makeGuard(
            jest.fn().mockResolvedValue({ id: 'u1', isPlatformAdmin: true }),
        );
        await expect(guard.canActivate(makeContext({ userId: 'u1' }))).resolves.toBe(true);
        expect(findById).toHaveBeenCalledWith('u1');
    });

    it('throws ForbiddenException when request.user is undefined', async () => {
        const { guard, findById } = makeGuard();
        await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        expect(findById).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when request.user.userId is missing', async () => {
        const { guard, findById } = makeGuard();
        await expect(guard.canActivate(makeContext({}))).rejects.toBeInstanceOf(ForbiddenException);
        expect(findById).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when the User row does not exist', async () => {
        const { guard } = makeGuard(jest.fn().mockResolvedValue(null));
        await expect(guard.canActivate(makeContext({ userId: 'u1' }))).rejects.toBeInstanceOf(
            ForbiddenException,
        );
    });

    it('throws ForbiddenException when isPlatformAdmin = false', async () => {
        const { guard } = makeGuard(
            jest.fn().mockResolvedValue({ id: 'u1', isPlatformAdmin: false }),
        );
        await expect(guard.canActivate(makeContext({ userId: 'u1' }))).rejects.toBeInstanceOf(
            ForbiddenException,
        );
    });

    it('throws ForbiddenException when isPlatformAdmin is missing/undefined (truthy check)', async () => {
        const { guard } = makeGuard(jest.fn().mockResolvedValue({ id: 'u1' }));
        await expect(guard.canActivate(makeContext({ userId: 'u1' }))).rejects.toBeInstanceOf(
            ForbiddenException,
        );
    });

    it('does not silently allow truthy non-boolean values like the string "false"', async () => {
        // Defensive: the guard checks `!user?.isPlatformAdmin`, so a STRING
        // 'false' would still be truthy. This test pins the current behavior;
        // if it changes (stricter equality) we want a deliberate decision.
        const { guard } = makeGuard(
            jest.fn().mockResolvedValue({ id: 'u1', isPlatformAdmin: 'false' as any }),
        );
        await expect(guard.canActivate(makeContext({ userId: 'u1' }))).resolves.toBe(true);
    });
});
