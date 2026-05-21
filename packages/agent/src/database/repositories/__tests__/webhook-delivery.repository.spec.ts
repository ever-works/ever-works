import type { Repository } from 'typeorm';
import { WebhookDeliveryRepository } from '../webhook-delivery.repository';
import { WebhookDelivery } from '../../../entities';

type Mocked = jest.Mocked<
    Pick<
        Repository<WebhookDelivery>,
        'create' | 'save' | 'find' | 'update' | 'increment' | 'findOne' | 'delete'
    >
>;

describe('WebhookDeliveryRepository', () => {
    let repository: Mocked;
    let service: WebhookDeliveryRepository;

    beforeEach(() => {
        repository = {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            update: jest.fn(),
            increment: jest.fn(),
            findOne: jest.fn(),
            delete: jest.fn(),
        };
        service = new WebhookDeliveryRepository(
            repository as unknown as Repository<WebhookDelivery>,
        );
    });

    describe('markEnqueued', () => {
        it('stamps the Trigger.dev run id on the pending row WITHOUT touching attempts', async () => {
            await service.markEnqueued('d-1', 'run_abc123');
            expect(repository.update).toHaveBeenCalledWith('d-1', {
                triggerRunId: 'run_abc123',
            });
            // Crucially: no increment call. attempts stays at whatever
            // createPending set it to (0).
            expect(repository.increment).not.toHaveBeenCalled();
        });
    });

    describe('recordAttempt', () => {
        it('bumps the attempts counter and writes the outcome fields', async () => {
            await service.recordAttempt('d-1', {
                status: 'delivered',
                lastResponseStatus: 200,
                lastOutcome: 'success',
                durationMs: 42,
                triggerRunId: 'run_abc',
            });
            expect(repository.increment).toHaveBeenCalledWith({ id: 'd-1' }, 'attempts', 1);
            expect(repository.update).toHaveBeenCalledWith(
                'd-1',
                expect.objectContaining({
                    status: 'delivered',
                    lastResponseStatus: 200,
                    lastOutcome: 'success',
                    durationMs: 42,
                    triggerRunId: 'run_abc',
                }),
            );
        });

        it('preserves an existing triggerRunId when the attempt does NOT supply one', async () => {
            // EW-634 Codex P2 fix: previously the update set
            // `triggerRunId: attempt.triggerRunId ?? null`, which clobbered
            // the value the producer-side `markEnqueued` had stamped on
            // the pending row. Now the update only writes triggerRunId
            // when the attempt actually supplied one.
            await service.recordAttempt('d-1', {
                status: 'retrying',
                lastResponseStatus: 503,
                lastOutcome: 'server_error',
            });
            const update = (repository.update.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;
            expect('triggerRunId' in update).toBe(false);
        });

        it('also preserves the existing run id when triggerRunId is explicitly null', async () => {
            // In-process orchestrator callers pass `triggerRunId: null`
            // (no Trigger.dev context to draw from). Must NOT clobber.
            await service.recordAttempt('d-1', {
                status: 'delivered',
                lastResponseStatus: 200,
                lastOutcome: 'success',
                triggerRunId: null,
            });
            const update = (repository.update.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;
            expect('triggerRunId' in update).toBe(false);
        });
    });
});
