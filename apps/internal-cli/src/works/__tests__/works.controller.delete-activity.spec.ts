import { describe, it, expect, vi } from 'vitest';
import { WorksController } from '../works.controller';

/**
 * C-13 (Gauzy Ever Works #33) — the internal CLI's `deleteWork` wrote no Activity row, so a Work
 * deleted from the CLI vanished from the feed without a trace. It now writes the same record the
 * API does (`workDeletedActivity`), and a failed write never fails the delete.
 */
function build(overrides: { log?: ReturnType<typeof vi.fn> } = {}) {
    const result = {
        status: 'success' as const,
        slug: 'acme',
        message: 'Work deleted.',
        deleted_repositories: ['acme/acme-website'],
    };
    const lifecycle = { deleteWork: vi.fn().mockResolvedValue(result) };
    const users = { createOrGetLocalUser: vi.fn().mockResolvedValue({ id: 'local-user' }) };
    const activity = { log: overrides.log ?? vi.fn().mockResolvedValue({}) };
    const controller = new WorksController(
        {} as never,
        lifecycle as never,
        {} as never,
        {} as never,
        users as never,
        activity as never,
    );
    return { controller, lifecycle, activity, result };
}

describe('internal CLI WorksController.deleteWork — Activity (C-13)', () => {
    it('records the deletion like the API does', async () => {
        const { controller, activity, result } = build();

        await expect(controller.deleteWork('w1', {} as never)).resolves.toBe(result);

        expect(activity.log).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'local-user',
                action: 'work.deleted',
                summary: 'Deleted work',
                details: expect.objectContaining({ workId: 'w1', slug: 'acme' }),
            }),
        );
        // The row is gone, so the record must not reference it (the activity_log FK).
        expect(activity.log.mock.calls[0][0]).not.toHaveProperty('workId');
    });

    it('still answers the delete when the Activity write fails', async () => {
        const { controller, result } = build({
            log: vi.fn().mockRejectedValue(new Error('activity store down')),
        });

        await expect(controller.deleteWork('w1', {} as never)).resolves.toBe(result);
    });
});
