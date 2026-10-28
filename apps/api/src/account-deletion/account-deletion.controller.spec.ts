// The deletion service reaches the Work, billing and storage layers through
// optional providers; their barrels pull the whole API graph (better-auth's
// ESM included) into a unit test. Stand-ins keep these specs about this module.
jest.mock('@ever-works/agent/services', () => ({
    WorkLifecycleService: class WorkLifecycleService {},
}));
jest.mock('@ever-works/agent/subscriptions', () => ({
    BillingService: class BillingService {},
    PaygService: class PaygService {},
    NoActiveSubscriptionError: class NoActiveSubscriptionError extends Error {},
    BillingProviderNotConfiguredError: class BillingProviderNotConfiguredError extends Error {},
}));
jest.mock('../uploads/storage-backend.factory', () => ({ getActiveStorageBackend: jest.fn() }));

import {
    ForbiddenException,
    GoneException,
    HttpException,
    NotFoundException,
} from '@nestjs/common';
import { AccountDeletionController } from './account-deletion.controller';
import { InvalidDeletionLinkError } from './account-deletion-token.service';
import { AccountDeletionFailedError } from './account-deletion.service';
import { ACCOUNT_DELETION_LINK_INVALID_MESSAGE } from './account-deletion.tokens';

function setup() {
    const tokens = {
        acceptRequest: jest.fn(() => ({ status: 'accepted' as const })),
        inspect: jest.fn(),
        claim: jest.fn(),
    };
    const deletion = {
        preview: jest.fn(async () => ({
            email: 'j***@example.com',
            accounts: [],
            worksDeleted: 2,
            worksKept: 0,
            apiKeys: 1,
            hasSubscription: false,
        })),
        execute: jest.fn(async () => ({
            deleted: true,
            accounts: 1,
            workspacesDeleted: 1,
            summary: {},
        })),
        emailOf: jest.fn(async () => 'Jane@Example.com'),
    };
    const controller = new AccountDeletionController(tokens as never, deletion as never);
    return { controller, tokens, deletion };
}

async function expectGone(promise: Promise<unknown>) {
    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(GoneException);
    expect((error as GoneException).getResponse()).toEqual({
        message: ACCOUNT_DELETION_LINK_INVALID_MESSAGE,
    });
}

describe('AccountDeletionController', () => {
    it('answers every request with the same accepted body', () => {
        const { controller } = setup();
        expect(controller.request({ email: 'jane@example.com' })).toEqual({ status: 'accepted' });
        expect(controller.request({ email: 'nobody@example.com' })).toEqual({ status: 'accepted' });
    });

    it('verify shows the preview with the expiry and never consumes', async () => {
        const { controller, tokens, deletion } = setup();
        const expiresAt = new Date('2026-10-27T21:30:00.000Z');
        tokens.inspect.mockResolvedValue({ userId: 'u1', expiresAt });
        await expect(controller.verify({ token: 't' })).resolves.toMatchObject({
            worksDeleted: 2,
            expiresAt,
        });
        expect(tokens.claim).not.toHaveBeenCalled();
        expect(deletion.execute).not.toHaveBeenCalled();
    });

    it('maps every unusable link to one 410', async () => {
        const { controller, tokens, deletion } = setup();
        tokens.inspect.mockRejectedValue(new InvalidDeletionLinkError());
        await expectGone(controller.verify({ token: 'x' }));
        tokens.claim.mockRejectedValue(new InvalidDeletionLinkError());
        await expectGone(controller.confirm({ token: 'x', confirm: true }));

        // A link whose account is already gone reads the same way.
        tokens.claim.mockResolvedValue({ id: 'r1', userId: 'u1' });
        deletion.execute.mockRejectedValueOnce(new NotFoundException());
        await expectGone(controller.confirm({ token: 'x', confirm: true }));
    });

    it('confirm deletes through the shared routine and reports counts only', async () => {
        const { controller, tokens, deletion } = setup();
        tokens.claim.mockResolvedValue({ id: 'r1', userId: 'u1' });
        await expect(controller.confirm({ token: 't', confirm: true })).resolves.toEqual({
            deleted: true,
            accounts: 1,
            workspacesDeleted: 1,
        });
        expect(deletion.execute).toHaveBeenCalledWith('u1', {
            source: 'email_link',
            requestId: 'r1',
        });
    });

    it('a billing failure is a 409 with its code, not a 410', async () => {
        const { controller, tokens, deletion } = setup();
        tokens.claim.mockResolvedValue({ id: 'r1', userId: 'u1' });
        deletion.execute.mockRejectedValueOnce(
            new AccountDeletionFailedError('billing_cancel_failed'),
        );
        const error = await controller.confirm({ token: 't', confirm: true }).catch((e) => e);
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(409);
        expect((error as HttpException).getResponse()).toMatchObject({
            code: 'billing_cancel_failed',
        });
    });

    it('the signed-in delete needs the account email typed (case-insensitive)', async () => {
        const { controller, deletion } = setup();
        const req = { user: { userId: 'u1' } };
        await expect(
            controller.deleteMe(req, { confirmEmail: 'someone@else.com' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(deletion.execute).not.toHaveBeenCalled();
        await expect(
            controller.deleteMe(req, { confirmEmail: ' jane@example.com ' }),
        ).resolves.toMatchObject({
            deleted: true,
        });
        expect(deletion.execute).toHaveBeenCalledWith('u1', { source: 'in_product' });
    });
});
