import { InboundTriggerFireRepository } from '../inbound-trigger-fire.repository';
import type { InboundTriggerFire } from '../../entities/inbound-trigger-fire.entity';

/**
 * The claim ledger is the idempotency primitive of every delivery path,
 * so its three outcomes are pinned directly: a fresh claim, a duplicate
 * inside the window, and a re-claim once the window has elapsed.
 */
function makeRepo(existing: Partial<InboundTriggerFire> | null = null) {
    const repository = {
        findOne: jest.fn(async () => existing as InboundTriggerFire | null),
        create: jest.fn((partial: Partial<InboundTriggerFire>) => ({ ...partial })),
        save: jest.fn(async (row: Partial<InboundTriggerFire>) => ({
            id: 'fire-new',
            firedAt: new Date(),
            ...row,
        })),
        update: jest.fn(async () => ({ affected: 1 })),
    };
    return { repository, svc: new InboundTriggerFireRepository(repository as never) };
}

describe('InboundTriggerFireRepository.claim', () => {
    it('inserts and wins when nothing has claimed the key', async () => {
        const { repository, svc } = makeRepo(null);
        const claim = await svc.claim('t1', 'event-1', 'event');
        expect(claim.won).toBe(true);
        expect(repository.save).toHaveBeenCalled();
        expect(repository.create).toHaveBeenCalledWith(
            expect.objectContaining({ triggerId: 't1', dedupeKey: 'event-1', status: 'running' }),
        );
    });

    it('loses to any existing claim when no window is given (event path fires once, forever)', async () => {
        const existing = { id: 'fire-1', firedAt: new Date(Date.now() - 10 * 365 * 86_400_000) };
        const { repository, svc } = makeRepo(existing);
        const claim = await svc.claim('t1', 'event-1', 'event');
        expect(claim).toEqual({ fire: existing, won: false });
        expect(repository.save).not.toHaveBeenCalled();
        expect(repository.update).not.toHaveBeenCalled();
    });

    it('dedupes a delivery repeated INSIDE the window', async () => {
        const existing = { id: 'fire-1', firedAt: new Date(Date.now() - 1_000) };
        const { svc } = makeRepo(existing);
        const claim = await svc.claim('t1', 'wh:id:gh-42', 'webhook', 60_000);
        expect(claim.won).toBe(false);
    });

    it('re-claims the row — and MOVES firedAt — once the window has elapsed', async () => {
        const existing = {
            id: 'fire-1',
            firedAt: new Date(Date.now() - 120_000),
            status: 'done' as const,
            taskId: 'task-old',
            reason: 'stale',
        };
        const { repository, svc } = makeRepo(existing);
        // Captured up front: the claim resets the row in place.
        const originalFiredAt = existing.firedAt.getTime();
        const claim = await svc.claim('t1', 'wh:id:gh-42', 'webhook', 60_000);

        expect(claim.won).toBe(true);
        // firedAt is a @CreateDateColumn, so the reset has to go through an
        // explicit UPDATE — entity save() would not move it, and the window
        // would stay anchored on the original delivery.
        const [id, patch] = repository.update.mock.calls[0] as unknown as [
            string,
            Partial<InboundTriggerFire>,
        ];
        expect(id).toBe('fire-1');
        expect(patch.status).toBe('running');
        expect(patch.taskId).toBeNull();
        expect(patch.reason).toBeNull();
        expect(patch.firedAt).toBeInstanceOf(Date);
        expect(patch.firedAt!.getTime()).toBeGreaterThan(originalFiredAt);
        // The returned row reflects the reset without a re-read.
        expect(claim.fire.status).toBe('running');
    });

    it('treats a lost insert race as the idempotent outcome it is', async () => {
        const winner = { id: 'fire-winner', firedAt: new Date() } as InboundTriggerFire;
        const repository = {
            findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
            create: jest.fn((partial: Partial<InboundTriggerFire>) => ({ ...partial })),
            save: jest.fn(async () => {
                throw Object.assign(new Error('duplicate key'), { code: '23505' });
            }),
            update: jest.fn(),
        };
        const svc = new InboundTriggerFireRepository(repository as never);

        await expect(svc.claim('t1', 'event-1', 'event')).resolves.toEqual({
            fire: winner,
            won: false,
        });
    });

    it('rethrows a non-unique-violation failure instead of swallowing a real fault', async () => {
        const repository = {
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn((partial: Partial<InboundTriggerFire>) => ({ ...partial })),
            save: jest.fn(async () => {
                throw new Error('connection reset');
            }),
            update: jest.fn(),
        };
        const svc = new InboundTriggerFireRepository(repository as never);
        await expect(svc.claim('t1', 'event-1', 'event')).rejects.toThrow('connection reset');
    });
});
