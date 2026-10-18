import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { FleetController } from '../fleet.controller';
import { ApiKeysController } from '../../auth/controllers/api-keys.controller';
import { IntegrationForbiddenGuard } from '../../auth/integration/integration-forbidden.guard';
import { SESSION_CREDENTIAL_ONLY_KEY } from '../../auth/integration/integration.decorators';

/**
 * Works-security (run-token scope, 2026-10-18) — finding 5: minting a node
 * enrollment token (or rotating a node credential, which mints a fresh one)
 * is minting a credential. Like creating an API key it needs a person's
 * interactive session; a personal `ew_live_` key — or an MCP client holding
 * one — used to be able to enroll an attacker's machine into the owner's fleet.
 */
function contextFor(handler: (...args: never[]) => unknown, user: Record<string, unknown>) {
    return {
        getType: () => 'http',
        getHandler: () => handler,
        getClass: () => FleetController,
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
}

describe('FleetController — credential-minting routes are session-only', () => {
    const guard = new IntegrationForbiddenGuard(new Reflector());
    const minting = [
        ['POST /api/fleet/nodes/enrollment-token', FleetController.prototype.createEnrollmentToken],
        ['POST /api/fleet/nodes/:id/rotate', FleetController.prototype.rotate],
    ] as const;

    it.each(minting)('%s carries @SessionCredentialOnly and the guard that enforces it', (_route, handler) => {
        expect(typeof Reflect.getMetadata(SESSION_CREDENTIAL_ONLY_KEY, handler)).toBe('string');
        expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(IntegrationForbiddenGuard);
    });

    it.each(minting)('%s refuses a personal API key / fleet-run token, admits a session', (_route, handler) => {
        expect(() => guard.canActivate(contextFor(handler, { userId: 'u1', authMethod: 'api-key' }))).toThrow(
            ForbiddenException,
        );
        expect(() => guard.canActivate(contextFor(handler, { userId: 'u1' }))).toThrow(ForbiddenException);
        expect(guard.canActivate(contextFor(handler, { userId: 'u1', authMethod: 'session' }))).toBe(true);
    });

    it('names the refused action in the message', () => {
        try {
            guard.canActivate(
                contextFor(FleetController.prototype.createEnrollmentToken, {
                    userId: 'u1',
                    authMethod: 'api-key',
                }),
            );
            throw new Error('expected a refusal');
        } catch (error) {
            expect((error as Error).message).toContain('mint a node enrollment token');
        }
    });

    it('keeps the API-key routes’ original message (no action named)', () => {
        const handler = ApiKeysController.prototype.create;
        expect(Reflect.getMetadata(SESSION_CREDENTIAL_ONLY_KEY, handler)).toBe(true);
        expect(() =>
            guard.canActivate({
                getType: () => 'http',
                getHandler: () => handler,
                getClass: () => ApiKeysController,
                switchToHttp: () => ({
                    getRequest: () => ({ user: { userId: 'u1', authMethod: 'api-key' } }),
                }),
            } as unknown as ExecutionContext),
        ).toThrow('Only a person signed in to Ever Works can create or rotate API keys.');
    });

    it('leaves the read and revoke routes open to a personal key (no session-only metadata)', () => {
        expect(
            Reflect.getMetadata(SESSION_CREDENTIAL_ONLY_KEY, FleetController.prototype.revokeEnrollmentToken),
        ).toBeUndefined();
    });
});
