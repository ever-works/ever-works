import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RailRefusalService } from '@ever-works/agent/safety';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { HUMAN_ONLY_KEY } from '../decorators/human-only.decorator';
import { HumanActorGuard } from './human-actor.guard';

function createContext(user: Partial<AuthenticatedUser> | undefined, type = 'http') {
    return {
        getType: () => type,
        getHandler: () => () => undefined,
        getClass: () => class {},
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as never;
}

function createGuard(humanOnly: boolean) {
    const reflector = {
        getAllAndOverride: jest.fn().mockReturnValue(humanOnly),
    } as never as Reflector;
    const refusals = {
        record: jest.fn().mockResolvedValue(undefined),
    } as never as RailRefusalService;
    return { guard: new HumanActorGuard(reflector, refusals), reflector, refusals };
}

describe('HumanActorGuard', () => {
    it('allows a route that is not marked human-only', async () => {
        const { guard } = createGuard(false);
        await expect(
            guard.canActivate(createContext({ userId: 'u1', authMethod: 'api-key' })),
        ).resolves.toBe(true);
    });

    it('allows a person in an interactive session', async () => {
        const { guard } = createGuard(true);
        await expect(
            guard.canActivate(createContext({ userId: 'u1', authMethod: 'session' })),
        ).resolves.toBe(true);
    });

    it('refuses an API key, even one belonging to the owner', async () => {
        // FR-31 — a control an agent, a schedule or a key can operate is not
        // a control. The owner's own key is refused for the same reason.
        const { guard } = createGuard(true);
        await expect(
            guard.canActivate(createContext({ userId: 'u1', authMethod: 'api-key' })),
        ).rejects.toThrow(ForbiddenException);
    });

    it('refuses a MISSING stamp — the unknown path fails closed', async () => {
        // A request with no stamp took a path this guard does not know about,
        // and "I cannot tell whether this is a person" is not a person.
        const { guard } = createGuard(true);
        await expect(guard.canActivate(createContext({ userId: 'u1' }))).rejects.toThrow(
            ForbiddenException,
        );
    });

    it('refuses when there is no user at all', async () => {
        const { guard } = createGuard(true);
        await expect(guard.canActivate(createContext(undefined))).rejects.toThrow(
            ForbiddenException,
        );
    });

    it('records the attempt as a refusal with the non-human-actor reason', async () => {
        const { guard, refusals } = createGuard(true);
        await expect(
            guard.canActivate(createContext({ userId: 'u1', authMethod: 'api-key' })),
        ).rejects.toThrow(ForbiddenException);

        expect(refusals.record).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'u1',
                reasonCode: 'non-human-actor',
                verdict: 'refused',
                requested: { authMethod: 'api-key' },
            }),
        );
    });

    it('still refuses when the refusal cannot be recorded', async () => {
        // `RailRefusalService.record()` never throws by contract; this pins
        // that the guard does not depend on that for its own correctness.
        const { guard, refusals } = createGuard(true);
        (refusals.record as jest.Mock).mockRejectedValue(new Error('database down'));
        await expect(
            guard.canActivate(createContext({ userId: 'u1', authMethod: 'api-key' })),
        ).rejects.toThrow();
    });

    it('records nothing when there is no user to attribute it to', async () => {
        const { guard, refusals } = createGuard(true);
        await expect(guard.canActivate(createContext(undefined))).rejects.toThrow();
        expect(refusals.record).not.toHaveBeenCalled();
    });

    it('ignores non-HTTP contexts', async () => {
        const { guard } = createGuard(true);
        await expect(guard.canActivate(createContext(undefined, 'rpc'))).resolves.toBe(true);
    });

    it('reads the flag from both the handler and the class', async () => {
        const { guard, reflector } = createGuard(true);
        await guard.canActivate(createContext({ userId: 'u1', authMethod: 'session' }));
        expect(reflector.getAllAndOverride).toHaveBeenCalledWith(HUMAN_ONLY_KEY, [
            expect.any(Function),
            expect.any(Function),
        ]);
    });
});
