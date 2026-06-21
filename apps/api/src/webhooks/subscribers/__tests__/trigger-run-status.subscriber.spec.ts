// Match the project-wide test convention (e.g. budget-alert.handler.spec.ts):
// stub external workspace packages so Jest doesn't have to resolve their
// transitive `@src/...` imports that target the API tsconfig path mapping.
jest.mock('@ever-works/agent/database', () => ({
    WorkGenerationHistoryRepository: class {},
}));

import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { WorkGenerationHistoryRepository } from '@ever-works/agent/database';
import { GenerateStatusType } from '@ever-works/contracts/api';
import { TriggerRunStatusSubscriber } from '../trigger-run-status.subscriber';
import {
    TRIGGER_WEBHOOK_EVENTS,
    TriggerWebhookInternalEventName,
    TriggerWebhookInternalEventPayload,
} from '../../trigger-webhook-events';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function envelope(
    internalEventName: TriggerWebhookInternalEventName,
    payloadOverrides: Record<string, unknown> = {},
): TriggerWebhookInternalEventPayload {
    return {
        tenantId: TENANT_ID,
        upstreamEventType: internalEventName.replace('trigger.', 'alert.'),
        internalEventName,
        createdAt: '2026-06-21T12:00:00.000Z',
        payload: {
            run: { id: 'run_abc', status: 'COMPLETED' },
            ...payloadOverrides,
        },
    };
}

function makeHistoryMock(): jest.Mocked<
    Pick<WorkGenerationHistoryRepository, 'findByTriggerRunId' | 'updateEntry'>
> {
    return {
        findByTriggerRunId: jest.fn(),
        updateEntry: jest.fn(),
    };
}

describe('TriggerRunStatusSubscriber', () => {
    let subscriber: TriggerRunStatusSubscriber;
    let history: ReturnType<typeof makeHistoryMock>;
    let logSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        history = makeHistoryMock();
        subscriber = new TriggerRunStatusSubscriber(history as unknown as WorkGenerationHistoryRepository);

        logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
        debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
        errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    });

    afterEach(() => {
        logSpy.mockRestore();
        debugSpy.mockRestore();
        errorSpy.mockRestore();
        jest.resetAllMocks();
    });

    describe('happy path', () => {
        it.each([
            {
                handler: 'onRunSucceeded' as const,
                name: TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED,
                terminal: GenerateStatusType.GENERATED,
            },
            {
                handler: 'onRunFailed' as const,
                name: TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
                terminal: GenerateStatusType.ERROR,
            },
            {
                handler: 'onRunCancelled' as const,
                name: TRIGGER_WEBHOOK_EVENTS.RUN_CANCELLED,
                terminal: GenerateStatusType.CANCELLED,
            },
        ])(
            'flips history row to "$terminal" via $handler',
            async ({ handler, name, terminal }) => {
                history.findByTriggerRunId.mockResolvedValue({
                    id: 'hist-1',
                    status: GenerateStatusType.GENERATING,
                } as never);
                history.updateEntry.mockResolvedValue({ id: 'hist-1' } as never);

                await subscriber[handler](envelope(name));

                expect(history.findByTriggerRunId).toHaveBeenCalledWith('run_abc');
                expect(history.updateEntry).toHaveBeenCalledTimes(1);
                const [id, updates] = history.updateEntry.mock.calls[0];
                expect(id).toBe('hist-1');
                expect(updates.status).toBe(terminal);
                expect(updates.finishedAt).toBeInstanceOf(Date);
            },
        );
    });

    it('persists errorMessage from payload.run.error.message on RUN_FAILED', async () => {
        history.findByTriggerRunId.mockResolvedValue({
            id: 'hist-1',
            status: GenerateStatusType.GENERATING,
        } as never);
        history.updateEntry.mockResolvedValue({ id: 'hist-1' } as never);

        await subscriber.onRunFailed(
            envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED, {
                run: { id: 'run_abc', error: { message: 'task crashed: ENOMEM' } },
            }),
        );

        expect(history.updateEntry).toHaveBeenCalledWith(
            'hist-1',
            expect.objectContaining({
                status: GenerateStatusType.ERROR,
                errorMessage: 'task crashed: ENOMEM',
            }),
        );
    });

    it('is idempotent — same delivery twice yields one terminal write + one no-op', async () => {
        // First delivery: row is GENERATING, gets flipped.
        history.findByTriggerRunId.mockResolvedValueOnce({
            id: 'hist-1',
            status: GenerateStatusType.GENERATING,
        } as never);
        history.updateEntry.mockResolvedValueOnce({ id: 'hist-1' } as never);
        // Second delivery: row is already GENERATED.
        history.findByTriggerRunId.mockResolvedValueOnce({
            id: 'hist-1',
            status: GenerateStatusType.GENERATED,
        } as never);

        await subscriber.onRunSucceeded(envelope(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED));
        await subscriber.onRunSucceeded(envelope(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED));

        // updateEntry called only on the first delivery — terminal
        // short-circuit catches the second.
        expect(history.updateEntry).toHaveBeenCalledTimes(1);
    });

    it('logs + drops when no history row matches the triggerRunId', async () => {
        history.findByTriggerRunId.mockResolvedValue(null);

        await subscriber.onRunSucceeded(envelope(TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED));

        expect(history.updateEntry).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalled();
        expect(String(debugSpy.mock.calls.at(-1)?.[0] ?? '')).toContain('no work_generation_history');
    });

    it('drops payload missing run.id without throwing', async () => {
        await expect(
            subscriber.onRunFailed(
                envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED, { run: { status: 'FAILED' } }),
            ),
        ).resolves.toBeUndefined();

        expect(history.findByTriggerRunId).not.toHaveBeenCalled();
        expect(history.updateEntry).not.toHaveBeenCalled();
        expect(debugSpy).toHaveBeenCalled();
        expect(String(debugSpy.mock.calls.at(-1)?.[0] ?? '')).toContain('missing payload.run.id');
    });

    it('catches + logs when the repository throws — does not propagate', async () => {
        history.findByTriggerRunId.mockRejectedValue(new Error('db connection lost'));

        await expect(
            subscriber.onRunFailed(envelope(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED)),
        ).resolves.toBeUndefined();

        expect(errorSpy).toHaveBeenCalled();
        expect(String(errorSpy.mock.calls[0][0])).toContain('db connection lost');
    });

    it('does not have handlers for deployment.* events', () => {
        // Channel-purity check: the subscriber must expose only the
        // three run.* handlers. If a future contributor wires a
        // deployment.* handler here by mistake, this assertion catches
        // it.
        const proto = TriggerRunStatusSubscriber.prototype;
        const ownMethods = Object.getOwnPropertyNames(proto).filter(
            (n) => n !== 'constructor' && typeof (proto as any)[n] === 'function',
        );
        expect(ownMethods.sort()).toEqual(
            ['handle', 'onRunCancelled', 'onRunFailed', 'onRunSucceeded'].sort(),
        );
    });
});
