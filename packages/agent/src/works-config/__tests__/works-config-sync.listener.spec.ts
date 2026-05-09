import { WorksConfigSyncRequestedEvent } from '../../events';
import { WorksConfigSyncListener } from '../services/works-config-sync.listener';

describe('WorksConfigSyncListener', () => {
    let syncWork: jest.Mock;
    let syncService: { syncWork: jest.Mock };
    let listener: WorksConfigSyncListener;

    beforeEach(() => {
        syncWork = jest.fn().mockResolvedValue(undefined);
        syncService = { syncWork };
        listener = new WorksConfigSyncListener(syncService as never);
    });

    it('forwards workId/userId/reason from the event verbatim', async () => {
        const event = new WorksConfigSyncRequestedEvent(
            'work-123',
            'user-456',
            'schedule_updated',
        );

        await listener.handleSyncRequested(event);

        expect(syncWork).toHaveBeenCalledTimes(1);
        expect(syncWork).toHaveBeenCalledWith({
            workId: 'work-123',
            userId: 'user-456',
            reason: 'schedule_updated',
        });
    });

    it('calls syncService.syncWork with EXACTLY the documented option keys (no extras)', async () => {
        // Pinned via Object.keys regression guard so a future "smuggle the full event onto
        // the call" refactor (which would forward unrelated fields like timestamps) is a
        // deliberate change.
        const event = new WorksConfigSyncRequestedEvent('w', 'u', 'provider_changed');

        await listener.handleSyncRequested(event);

        expect(syncWork).toHaveBeenCalledTimes(1);
        const arg = syncWork.mock.calls[0][0];
        expect(Object.keys(arg).sort()).toEqual(['reason', 'userId', 'workId']);
    });

    it('forwards each documented WorksConfigSyncReason value', async () => {
        // Each reason corresponds to a different upstream caller; pinned so a future
        // narrowing of the union (e.g. dropping `pipeline_settings_changed`) breaks
        // any caller that emits that reason.
        const reasons = [
            'schedule_updated',
            'schedule_cancelled',
            'provider_changed',
            'pipeline_settings_changed',
        ] as const;

        for (const reason of reasons) {
            syncWork.mockClear();
            await listener.handleSyncRequested(
                new WorksConfigSyncRequestedEvent('w', 'u', reason),
            );
            expect(syncWork).toHaveBeenCalledWith(
                expect.objectContaining({ reason }),
            );
        }
    });

    it('awaits the syncService — rejection propagates out of the handler', async () => {
        // The handler is decorated with `{ async: true }` so Nest will not block other
        // listeners, but the rejection MUST propagate so EventEmitter2 can surface it
        // for monitoring. Pinned so a future try/catch swallow has to be deliberate.
        const boom = new Error('sync failed');
        syncWork.mockRejectedValueOnce(boom);

        await expect(
            listener.handleSyncRequested(
                new WorksConfigSyncRequestedEvent('w', 'u', 'schedule_updated'),
            ),
        ).rejects.toBe(boom);
    });

    it('returns the resolved sentinel undefined (Promise<void>)', async () => {
        // Pinned because `syncService.syncWork` returns Promise<void> and the handler
        // does not transform the result — a future "return the sync result" refactor
        // would change the contract.
        await expect(
            listener.handleSyncRequested(
                new WorksConfigSyncRequestedEvent('w', 'u', 'schedule_updated'),
            ),
        ).resolves.toBeUndefined();
    });

    it('is a stateless single-call passthrough — separate events do not share state', async () => {
        await listener.handleSyncRequested(
            new WorksConfigSyncRequestedEvent('w1', 'u1', 'schedule_updated'),
        );
        await listener.handleSyncRequested(
            new WorksConfigSyncRequestedEvent('w2', 'u2', 'provider_changed'),
        );
        expect(syncWork).toHaveBeenCalledTimes(2);
        expect(syncWork.mock.calls[0][0]).toEqual({
            workId: 'w1',
            userId: 'u1',
            reason: 'schedule_updated',
        });
        expect(syncWork.mock.calls[1][0]).toEqual({
            workId: 'w2',
            userId: 'u2',
            reason: 'provider_changed',
        });
    });
});
