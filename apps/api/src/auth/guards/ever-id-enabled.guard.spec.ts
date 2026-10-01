import { HttpException } from '@nestjs/common';
import { EverIdEnabledGuard } from './ever-id-enabled.guard';
import { everIdError } from '../services/ever-id-errors';
import type { EverIdSignInService } from '../services/ever-id-sign-in.service';

/**
 * APW-12 (Ever ID) — the guard in front of the sign-in family (FR-5, ACC-12-01):
 * it lets a request through only while Ever ID is on, and otherwise answers the
 * same error the routes do, before any body is looked at.
 */
function guardWith(requireEnabled: () => Promise<void>): EverIdEnabledGuard {
    return new EverIdEnabledGuard({ requireEnabled } as unknown as EverIdSignInService);
}

describe('EverIdEnabledGuard', () => {
    it('lets the request through while Ever ID is on', async () => {
        await expect(guardWith(async () => undefined).canActivate()).resolves.toBe(true);
    });

    it('answers 404 ever_id_disabled while Ever ID is off', async () => {
        const guard = guardWith(async () => {
            throw everIdError('everIdDisabled');
        });

        const error = await guard.canActivate().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(404);
        expect((error as HttpException).getResponse()).toMatchObject({
            status: 'error',
            code: 'ever_id_disabled',
        });
    });

    it('answers 503 provider_unavailable while the provider is marked unavailable', async () => {
        const guard = guardWith(async () => {
            throw everIdError('providerUnavailable');
        });

        const error = await guard.canActivate().catch((caught: unknown) => caught);

        expect((error as HttpException).getStatus()).toBe(503);
        expect((error as HttpException).getResponse()).toMatchObject({
            code: 'provider_unavailable',
        });
    });
});
