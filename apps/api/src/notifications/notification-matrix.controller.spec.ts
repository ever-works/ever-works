jest.mock('../auth', () => ({
    CurrentUser: () => () => undefined,
    AuthSessionGuard: class AuthSessionGuard {},
}));
jest.mock('./notification-matrix.service', () => ({ NotificationMatrixService: class {} }));

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
    NotificationMatrixController,
    ResetNotificationMatrixBody,
} from './notification-matrix.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

describe('NotificationMatrixController', () => {
    const auth = { userId: 'user-1' } as AuthenticatedUser;
    let matrix: { getMatrix: jest.Mock; reset: jest.Mock };
    let controller: NotificationMatrixController;

    beforeEach(() => {
        matrix = {
            getMatrix: jest.fn().mockResolvedValue({ events: [], columns: [] }),
            reset: jest.fn().mockResolvedValue({ changed: 2 }),
        };
        controller = new NotificationMatrixController(matrix as never);
    });

    it('is session-guarded as a whole', () => {
        const guards = Reflect.getMetadata(GUARDS_METADATA, NotificationMatrixController) ?? [];
        expect(guards.map((g: { name: string }) => g.name)).toContain('AuthSessionGuard');
    });

    it('reads the matrix for the calling user only', async () => {
        await expect(controller.getMatrix(auth)).resolves.toEqual({ events: [], columns: [] });
        expect(matrix.getMatrix).toHaveBeenCalledWith('user-1');
    });

    it('never caches the matrix', () => {
        const headers = Reflect.getMetadata(
            '__headers__',
            NotificationMatrixController.prototype.getMatrix,
        );
        expect(headers).toEqual([{ name: 'Cache-Control', value: 'private, no-store' }]);
    });

    it('resets the named keys, or everything when none are named, for the calling user', async () => {
        await expect(controller.reset(auth, { eventKeys: ['generation_error'] })).resolves.toEqual({
            changed: 2,
        });
        expect(matrix.reset).toHaveBeenCalledWith('user-1', ['generation_error']);
        await controller.reset(auth, {});
        expect(matrix.reset).toHaveBeenLastCalledWith('user-1', undefined);
    });

    describe('reset body validation', () => {
        async function errorsFor(body: unknown) {
            return validate(plainToInstance(ResetNotificationMatrixBody, body));
        }

        it('accepts an omitted list and a list of keys', async () => {
            expect(await errorsFor({})).toHaveLength(0);
            expect(await errorsFor({ eventKeys: ['a', 'b'] })).toHaveLength(0);
        });

        it('rejects a non-array, non-string members, over-long keys and oversized lists', async () => {
            expect(await errorsFor({ eventKeys: 'generation_error' })).not.toHaveLength(0);
            expect(await errorsFor({ eventKeys: [42] })).not.toHaveLength(0);
            expect(await errorsFor({ eventKeys: ['x'.repeat(121)] })).not.toHaveLength(0);
            expect(
                await errorsFor({ eventKeys: Array.from({ length: 501 }, (_, i) => `k${i}`) }),
            ).not.toHaveLength(0);
        });
    });
});
