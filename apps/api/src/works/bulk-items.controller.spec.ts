// Stub transitive imports pulled in via the controller's AuthService
// constructor type. Without these, `@ever-works/agent/database` drags
// the entity barrel into the test runtime, which fails on the
// `@src/config` path alias that's only mapped in the Nest runtime.
jest.mock('../auth/services/auth.service', () => ({
    AuthService: class {},
}));
jest.mock('../auth/guards/auth-session.guard', () => ({
    AuthSessionGuard: class {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkGenerationService: class {},
    WorkOwnershipService: class {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        ITEM_REMOVED: 'item_removed',
        ITEM_UPDATED: 'item_updated',
    },
    ActivityStatus: {
        COMPLETED: 'completed',
        FAILED: 'failed',
    },
}));

import { BulkItemsController } from './bulk-items.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

const mkAuth = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
    ({
        userId: overrides.userId ?? 'user-1',
        email: 'u@example.test',
        username: 'u',
        provider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
    }) as AuthenticatedUser;

describe('BulkItemsController', () => {
    let authService: { getUser: jest.Mock };
    let workGenerationService: { removeItem: jest.Mock; updateItemMetadata: jest.Mock };
    let workOwnershipService: { ensureCanEdit: jest.Mock };
    let activityLogService: { log: jest.Mock };
    let controller: BulkItemsController;

    beforeEach(() => {
        authService = { getUser: jest.fn().mockResolvedValue({ id: 'user-1' }) };
        workGenerationService = {
            removeItem: jest.fn().mockResolvedValue({ ok: true }),
            updateItemMetadata: jest.fn().mockResolvedValue({ ok: true }),
        };
        workOwnershipService = { ensureCanEdit: jest.fn().mockResolvedValue({ id: 'work-1' }) };
        activityLogService = { log: jest.fn().mockResolvedValue(undefined) };
        controller = new BulkItemsController(
            authService as any,
            workGenerationService as any,
            workOwnershipService as any,
            activityLogService as any,
        );
    });

    describe('bulkDelete', () => {
        it('rejects strangers via ensureCanEdit', async () => {
            workOwnershipService.ensureCanEdit.mockRejectedValueOnce(new Error('Forbidden'));
            await expect(
                controller.bulkDelete(mkAuth(), 'work-1', { item_slugs: ['a'] }),
            ).rejects.toThrow('Forbidden');
            expect(workGenerationService.removeItem).not.toHaveBeenCalled();
        });

        it('returns zero-summary for empty input without touching git', async () => {
            const r = await controller.bulkDelete(mkAuth(), 'work-1', { item_slugs: [] });
            expect(r).toEqual({ requested: 0, succeeded: 0, failed: 0, errors: [] });
            expect(workGenerationService.removeItem).not.toHaveBeenCalled();
        });

        it('de-duplicates slugs — same slug listed twice only removes once', async () => {
            const r = await controller.bulkDelete(mkAuth(), 'work-1', {
                item_slugs: ['a', 'a', 'b', 'a'],
            });
            expect(r.requested).toBe(2);
            expect(r.succeeded).toBe(2);
            expect(workGenerationService.removeItem).toHaveBeenCalledTimes(2);
        });

        it('reports per-item errors without aborting the batch', async () => {
            workGenerationService.removeItem
                .mockResolvedValueOnce({ ok: true })
                .mockRejectedValueOnce(new Error('item not found'))
                .mockResolvedValueOnce({ ok: true });
            const r = await controller.bulkDelete(mkAuth(), 'work-1', {
                item_slugs: ['a', 'b', 'c'],
            });
            expect(r.requested).toBe(3);
            expect(r.succeeded).toBe(2);
            expect(r.failed).toBe(1);
            expect(r.errors).toEqual([{ item_slug: 'b', message: 'item not found' }]);
        });

        it('forwards reason to removeItem', async () => {
            await controller.bulkDelete(mkAuth(), 'work-1', {
                item_slugs: ['a'],
                reason: 'spam',
            });
            expect(workGenerationService.removeItem).toHaveBeenCalledWith(
                'work-1',
                { item_slug: 'a', reason: 'spam' },
                { id: 'user-1' },
            );
        });
    });

    describe('bulkUpdate', () => {
        it('returns zero-summary for empty updates without writes', async () => {
            const r = await controller.bulkUpdate(mkAuth(), 'work-1', { updates: [] });
            expect(r.requested).toBe(0);
            expect(workGenerationService.updateItemMetadata).not.toHaveBeenCalled();
        });

        it('treats published as an alias for featured', async () => {
            await controller.bulkUpdate(mkAuth(), 'work-1', {
                updates: [{ item_slug: 'a', published: true }],
            });
            expect(workGenerationService.updateItemMetadata).toHaveBeenCalledWith(
                'work-1',
                { item_slug: 'a', featured: true },
                { id: 'user-1' },
            );
        });

        it('errors per-item when no update fields provided', async () => {
            const r = await controller.bulkUpdate(mkAuth(), 'work-1', {
                updates: [{ item_slug: 'a' }],
            });
            expect(r.failed).toBe(1);
            expect(r.errors[0]).toMatchObject({
                item_slug: 'a',
                message: 'no update fields provided',
            });
        });

        it('de-duplicates by slug (last write wins)', async () => {
            await controller.bulkUpdate(mkAuth(), 'work-1', {
                updates: [
                    { item_slug: 'a', featured: false },
                    { item_slug: 'a', featured: true },
                ],
            });
            expect(workGenerationService.updateItemMetadata).toHaveBeenCalledTimes(1);
            expect(workGenerationService.updateItemMetadata).toHaveBeenCalledWith(
                'work-1',
                { item_slug: 'a', featured: true },
                { id: 'user-1' },
            );
        });
    });

    describe('bulkPublish', () => {
        it('defaults published to true when omitted', async () => {
            await controller.bulkPublish(mkAuth(), 'work-1', { item_slugs: ['a'] });
            expect(workGenerationService.updateItemMetadata).toHaveBeenCalledWith(
                'work-1',
                { item_slug: 'a', featured: true },
                { id: 'user-1' },
            );
        });

        it('unpublishes when published: false', async () => {
            await controller.bulkPublish(mkAuth(), 'work-1', {
                item_slugs: ['a'],
                published: false,
            });
            expect(workGenerationService.updateItemMetadata).toHaveBeenCalledWith(
                'work-1',
                { item_slug: 'a', featured: false },
                { id: 'user-1' },
            );
        });

        it('zero-summary for empty input', async () => {
            const r = await controller.bulkPublish(mkAuth(), 'work-1', { item_slugs: [] });
            expect(r.requested).toBe(0);
            expect(workGenerationService.updateItemMetadata).not.toHaveBeenCalled();
        });

        it('owner-gates via ensureCanEdit before any write', async () => {
            workOwnershipService.ensureCanEdit.mockRejectedValueOnce(new Error('Forbidden'));
            await expect(
                controller.bulkPublish(mkAuth(), 'work-1', { item_slugs: ['a'] }),
            ).rejects.toThrow('Forbidden');
            expect(workGenerationService.updateItemMetadata).not.toHaveBeenCalled();
        });
    });

    describe('activity log', () => {
        it('logs bulk_deleted with COMPLETED status when all succeed', async () => {
            await controller.bulkDelete(mkAuth(), 'work-1', { item_slugs: ['a', 'b'] });
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'items.bulk_deleted',
                    workId: 'work-1',
                    userId: 'user-1',
                }),
            );
        });

        it('logs FAILED status when at least one item failed', async () => {
            workGenerationService.removeItem.mockRejectedValueOnce(new Error('x'));
            await controller.bulkDelete(mkAuth(), 'work-1', { item_slugs: ['a'] });
            const call = activityLogService.log.mock.calls[0][0];
            expect(call.status).toBe('failed');
        });

        it('activity-log failures do not propagate (fire-and-forget)', async () => {
            activityLogService.log.mockRejectedValueOnce(new Error('log down'));
            await expect(
                controller.bulkDelete(mkAuth(), 'work-1', { item_slugs: ['a'] }),
            ).resolves.toBeDefined();
        });
    });
});
