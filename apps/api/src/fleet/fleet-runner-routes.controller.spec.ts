import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { FleetController } from './fleet.controller';
import { ClearFleetExecutionPreferenceDto, SetFleetExecutionPreferenceDto } from './dto/fleet.dto';

const auth = { userId: 'user-1' } as AuthenticatedUser;
const otherAuth = { userId: 'user-2' } as AuthenticatedUser;
const WORK_ID = '44444444-4444-4444-8444-444444444444';

/**
 * Runner status + execution-preference routes — the surfaces added for
 * the local-runner UX.
 *
 * One property dominates all of them, and it is the reason the Fleet
 * controller carries the scoping note it does: the OWNER comes from the
 * session and is never accepted from the caller. A Work id travels — it
 * appears in URLs, logs and job payloads — so a preference route that
 * trusted a caller-supplied owner would turn that id into a
 * cross-account read/write primitive.
 *
 * The second property is anti-"wired-but-dead": every field the DTO
 * accepts must reach the service. A body-mapping whitelist that silently
 * drops one is how a shipped setting ends up doing nothing at all.
 */
describe('FleetController runner status + execution preferences', () => {
    let runners: { snapshot: jest.Mock };
    let preferences: {
        listForUser: jest.Mock;
        setForUser: jest.Mock;
        clearForUser: jest.Mock;
    };
    let controller: FleetController;

    beforeEach(() => {
        runners = {
            snapshot: jest.fn(async () => ({
                total: 2,
                online: 1,
                busy: 0,
                offline: 1,
                drained: 0,
                refreshIntervalSec: 30,
                loadUnavailable: false,
                nodes: [],
            })),
        };
        preferences = {
            listForUser: jest.fn(async () => []),
            setForUser: jest.fn(async (_userId: string, input: Record<string, unknown>) => ({
                id: 'pref-1',
                scopeType: input.scopeType,
                scopeId: input.scopeId ?? null,
                mode: input.mode,
                createdAt: null,
                updatedAt: null,
            })),
            clearForUser: jest.fn(async () => undefined),
        };
        controller = new FleetController(
            { listForUser: jest.fn(async () => []) } as never,
            { loadByNodeForUser: jest.fn(async () => ({})) } as never,
            runners as never,
            preferences as never,
        );
    });

    describe('authorization scoping', () => {
        it('scopes runner status to the SESSION user', async () => {
            const result = await controller.runnerStatus(auth);

            expect(runners.snapshot).toHaveBeenCalledWith('user-1');
            expect(result.total).toBe(2);
        });

        it('gives a different session a different owner scope', async () => {
            await controller.runnerStatus(otherAuth);
            expect(runners.snapshot).toHaveBeenCalledWith('user-2');
        });

        it('scopes the preference list to the session user', async () => {
            await controller.listExecutionPreferences(auth);
            expect(preferences.listForUser).toHaveBeenCalledWith('user-1');
        });

        it('writes a preference under the session user, not a body-supplied one', async () => {
            await controller.setExecutionPreference(otherAuth, {
                scopeType: 'work',
                scopeId: WORK_ID,
                mode: 'local-wait',
            });

            expect(preferences.setForUser).toHaveBeenCalledWith('user-2', expect.anything());
        });

        it('is NOT a public route — runner status requires a session', () => {
            // The class has no @Public(); only enroll/heartbeat/pause/
            // unenroll do. If someone ever marks the whole controller
            // public, this catches it.
            const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, controller.runnerStatus);
            expect(isPublic).toBeFalsy();
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, FleetController)).toBeFalsy();
        });
    });

    describe('body mapping', () => {
        it('forwards EVERY field of the set-preference body', async () => {
            const view = await controller.setExecutionPreference(auth, {
                scopeType: 'work',
                scopeId: WORK_ID,
                mode: 'local-wait',
            });

            expect(preferences.setForUser).toHaveBeenCalledWith('user-1', {
                scopeType: 'work',
                scopeId: WORK_ID,
                mode: 'local-wait',
            });
            expect(view.mode).toBe('local-wait');
        });

        it('normalizes a missing scopeId to null for the account scope', async () => {
            await controller.setExecutionPreference(auth, { scopeType: 'user', mode: 'cloud' });

            expect(preferences.setForUser).toHaveBeenCalledWith('user-1', {
                scopeType: 'user',
                scopeId: null,
                mode: 'cloud',
            });
        });

        it('clears a scope under the session owner', async () => {
            await controller.clearExecutionPreference(auth, {
                scopeType: 'work',
                scopeId: WORK_ID,
            });

            expect(preferences.clearForUser).toHaveBeenCalledWith('user-1', 'work', WORK_ID);
        });

        it('clears the account scope with a null id', async () => {
            await controller.clearExecutionPreference(auth, { scopeType: 'user' });

            expect(preferences.clearForUser).toHaveBeenCalledWith('user-1', 'user', null);
        });
    });
});

describe('execution-preference DTO validation', () => {
    const validateSet = async (payload: Record<string, unknown>) =>
        validate(plainToInstance(SetFleetExecutionPreferenceDto, payload));

    it('accepts an account-scoped body with no id', async () => {
        await expect(validateSet({ scopeType: 'user', mode: 'cloud' })).resolves.toHaveLength(0);
    });

    it('accepts a Work-scoped body with a uuid', async () => {
        await expect(
            validateSet({ scopeType: 'work', scopeId: WORK_ID, mode: 'local-wait' }),
        ).resolves.toHaveLength(0);
    });

    it('rejects a Work-scoped body with no id', async () => {
        // Would otherwise save cleanly and behave like an account
        // default — invisible, and wrong.
        const errors = await validateSet({ scopeType: 'work', mode: 'local-wait' });
        expect(errors.map((error) => error.property)).toContain('scopeId');
    });

    it('rejects a non-uuid scope id', async () => {
        const errors = await validateSet({
            scopeType: 'goal',
            scopeId: 'my-goal',
            mode: 'cloud',
        });
        expect(errors.map((error) => error.property)).toContain('scopeId');
    });

    it('rejects an unknown mode', async () => {
        const errors = await validateSet({ scopeType: 'user', mode: 'teleport' });
        expect(errors.map((error) => error.property)).toContain('mode');
    });

    it('rejects an unknown scope type', async () => {
        const errors = await validateSet({ scopeType: 'galaxy', mode: 'cloud' });
        expect(errors.map((error) => error.property)).toContain('scopeType');
    });

    it('validates the clear query the same way', async () => {
        const ok = await validate(
            plainToInstance(ClearFleetExecutionPreferenceDto, { scopeType: 'user' }),
        );
        expect(ok).toHaveLength(0);

        const bad = await validate(
            plainToInstance(ClearFleetExecutionPreferenceDto, { scopeType: 'work' }),
        );
        expect(bad.map((error) => error.property)).toContain('scopeId');
    });
});
