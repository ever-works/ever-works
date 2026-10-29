import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { workDeletedActivity } from './work-deleted-activity';

/** ACC-NEG-07 / C-13 — the one Activity record every Work-deleting surface writes. */
describe('workDeletedActivity', () => {
    const base = {
        slug: 'acme',
        message: 'Work deleted. Kept: the data repository.',
        deleted_repositories: ['acme/acme-website'],
    };

    it('names the Work only in details once its row is gone (the workId foreign key)', () => {
        const entry = workDeletedActivity('u1', 'w1', { ...base, status: 'success' });

        expect(entry).not.toHaveProperty('workId');
        expect(entry).toMatchObject({
            userId: 'u1',
            actionType: ActivityActionType.WORK_DELETED,
            action: 'work.deleted',
            status: ActivityStatus.COMPLETED,
            summary: 'Deleted work',
            details: {
                workId: 'w1',
                slug: 'acme',
                deletedRepositories: ['acme/acme-website'],
                message: base.message,
            },
        });
    });

    it('references the Work while its row remains (pending, or the App runtime took over)', () => {
        for (const result of [
            { ...base, status: 'pending' as const },
            { ...base, status: 'success' as const, deleting: true },
        ]) {
            expect(workDeletedActivity('u1', 'w1', result)).toMatchObject({
                workId: 'w1',
                summary: 'Deleting work',
            });
        }
    });

    it('records no repositories when none were deleted', () => {
        const entry = workDeletedActivity('u1', 'w1', {
            status: 'success',
            slug: 'acme',
            message: 'Work deleted.',
        });
        expect(entry.details).toMatchObject({ deletedRepositories: [] });
    });
});
