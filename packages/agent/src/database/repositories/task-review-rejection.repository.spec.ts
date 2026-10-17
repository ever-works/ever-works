import { QueryFailedError } from 'typeorm';
import { TaskReviewRejectionRepository } from './task-review-rejection.repository';

/**
 * Item 11 (10-09 fleet handover) — a redelivered GitHub `created` webhook must
 * not record the same finding twice. The unique (taskId, sourceKey) index is
 * the guarantee; the repository turns both the known duplicate and a lost race
 * into "nothing recorded" (`null`), never a second row or a 500.
 */
describe('TaskReviewRejectionRepository.record — source dedup', () => {
    const input = {
        taskId: 'task-1',
        source: 'pull-request' as const,
        feedback: 'Major: the guard is missing on the retry path.',
        sourceKey: 'pull_request_review_comment:42',
    };

    function build(over: { existing?: unknown; saveError?: unknown } = {}) {
        const repository = {
            findOne: jest.fn(async () => over.existing ?? null),
            create: jest.fn((row: Record<string, unknown>) => row),
            save: jest.fn(async (row: Record<string, unknown>) => {
                if (over.saveError) throw over.saveError;
                return { id: 'row-1', ...row };
            }),
        };
        return { repository, rejections: new TaskReviewRejectionRepository(repository as never) };
    }

    it('records the first delivery with its source key', async () => {
        const { repository, rejections } = build();
        await expect(rejections.record(input)).resolves.toMatchObject({ sourceKey: input.sourceKey });
        expect(repository.findOne).toHaveBeenCalledWith({
            where: { taskId: 'task-1', sourceKey: input.sourceKey },
        });
    });

    it('records nothing for a redelivery of the same source', async () => {
        const { repository, rejections } = build({ existing: { id: 'row-1' } });
        await expect(rejections.record(input)).resolves.toBeNull();
        expect(repository.save).not.toHaveBeenCalled();
    });

    it('turns a lost race on the unique index into "nothing recorded"', async () => {
        const duplicate = new QueryFailedError('INSERT', [], new Error('UNIQUE constraint failed'));
        const { rejections } = build({ saveError: duplicate });
        await expect(rejections.record(input)).resolves.toBeNull();
    });

    it('still throws a real failure, and never dedups a row without a source', async () => {
        const { rejections } = build({ saveError: new Error('db down') });
        await expect(rejections.record(input)).rejects.toThrow('db down');
        const { repository, rejections: plain } = build({ existing: { id: 'x' } });
        await expect(plain.record({ ...input, sourceKey: null })).resolves.toMatchObject({ sourceKey: null });
        expect(repository.findOne).not.toHaveBeenCalled();
    });
});
