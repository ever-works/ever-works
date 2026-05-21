import { WebhookSubscriptionDeliveryService } from '../webhook-subscription-delivery.service';
import { WebhookDeliveryService, type DeliveryResult } from '../webhook-delivery.service';

type SubRow = {
    id: string;
    accountId: string;
    workId: string | null;
    url: string;
    secretEncrypted: string;
    status: 'active' | 'paused' | 'failed';
    consecutiveFailures: number;
    lastDeliveryAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
};

function makeSub(overrides: Partial<SubRow> = {}): SubRow {
    return {
        id: 'sub-1',
        accountId: 'acct-1',
        workId: null,
        url: 'https://hooks.example.com/p',
        secretEncrypted: 'enc::v1::ignored', // decryptor returns 'shh' below
        status: 'active',
        consecutiveFailures: 0,
        lastDeliveryAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

function setup(opts: { sub?: SubRow; deliverResult: DeliveryResult; initialFailures?: number }) {
    const sub = opts.sub ?? makeSub();
    const failureCounter = { value: opts.initialFailures ?? sub.consecutiveFailures };

    const subscriptionsRepo = {
        findById: jest.fn().mockResolvedValue(sub),
        markSuccess: jest.fn().mockResolvedValue(undefined),
        incrementFailure: jest.fn().mockImplementation(async () => {
            failureCounter.value += 1;
            return failureCounter.value;
        }),
        markFailed: jest.fn().mockResolvedValue(undefined),
    } as any;
    const deliveriesRepo = {
        recordAttempt: jest.fn().mockResolvedValue(undefined),
    } as any;
    const deliveryService = {
        deliver: jest.fn().mockResolvedValue(opts.deliverResult),
    } as unknown as WebhookDeliveryService;

    const svc = new WebhookSubscriptionDeliveryService(
        deliveryService,
        subscriptionsRepo,
        deliveriesRepo,
    );
    svc.setSecretDecryptor(() => 'shh');

    return { svc, subscriptionsRepo, deliveriesRepo, deliveryService, sub, failureCounter };
}

describe('WebhookSubscriptionDeliveryService.dispatch', () => {
    afterEach(() => delete process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES);

    it('returns subscription_not_found when the row is missing', async () => {
        const { svc, subscriptionsRepo } = setup({
            deliverResult: { ok: true, outcome: 'success', deliveryId: 'd' },
        });
        subscriptionsRepo.findById.mockResolvedValueOnce(null);
        const out = await svc.dispatch({
            subscriptionId: 'missing',
            event: 'x',
            payload: {},
            deliveryId: 'd-1',
        });
        expect(out.result.outcome).toBe('client_error');
        expect(out.result.error).toBe('subscription_not_found');
        expect(out.shouldRetry).toBe(false);
    });

    it('skips dispatch when subscription is paused', async () => {
        const { svc, deliveryService, deliveriesRepo } = setup({
            sub: makeSub({ status: 'paused' }),
            deliverResult: { ok: true, outcome: 'success', deliveryId: 'd' },
        });
        const out = await svc.dispatch({
            subscriptionId: 'sub-1',
            event: 'x',
            payload: {},
            deliveryId: 'd-1',
        });
        expect(out.result.outcome).toBe('client_error');
        expect(out.result.error).toBe('subscription_paused');
        expect(deliveryService.deliver).not.toHaveBeenCalled();
        expect(deliveriesRepo.recordAttempt).not.toHaveBeenCalled();
    });

    it('marks success + resets the counter on 2xx', async () => {
        const { svc, subscriptionsRepo, deliveriesRepo } = setup({
            deliverResult: { ok: true, outcome: 'success', status: 200, deliveryId: 'd-1' },
        });
        const out = await svc.dispatch({
            subscriptionId: 'sub-1',
            event: 'work.created',
            payload: { workId: 'w' },
            deliveryId: 'd-1',
        });
        expect(out.result.ok).toBe(true);
        expect(out.shouldRetry).toBe(false);
        expect(out.consecutiveFailures).toBe(0);
        expect(subscriptionsRepo.markSuccess).toHaveBeenCalledWith('sub-1');
        expect(deliveriesRepo.recordAttempt).toHaveBeenCalledWith(
            'd-1',
            expect.objectContaining({ status: 'delivered', lastOutcome: 'success' }),
        );
    });

    it('marks retry on 5xx but does not dead-letter under threshold', async () => {
        process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES = '10';
        const { svc, subscriptionsRepo, deliveriesRepo } = setup({
            sub: makeSub({ consecutiveFailures: 1 }),
            deliverResult: {
                ok: false,
                outcome: 'server_error',
                status: 503,
                deliveryId: 'd-1',
            },
        });
        const out = await svc.dispatch({
            subscriptionId: 'sub-1',
            event: 'x',
            payload: {},
            deliveryId: 'd-1',
        });
        expect(out.shouldRetry).toBe(true);
        expect(out.consecutiveFailures).toBe(2);
        expect(subscriptionsRepo.markFailed).not.toHaveBeenCalled();
        expect(deliveriesRepo.recordAttempt).toHaveBeenCalledWith(
            'd-1',
            expect.objectContaining({ status: 'retrying', lastOutcome: 'server_error' }),
        );
    });

    it('marks dead-letter when consecutive failures reach the configured threshold', async () => {
        process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES = '3';
        const { svc, subscriptionsRepo, deliveriesRepo } = setup({
            sub: makeSub({ consecutiveFailures: 2 }),
            deliverResult: {
                ok: false,
                outcome: 'server_error',
                status: 500,
                deliveryId: 'd-1',
            },
        });
        const out = await svc.dispatch({
            subscriptionId: 'sub-1',
            event: 'x',
            payload: {},
            deliveryId: 'd-1',
        });
        expect(out.consecutiveFailures).toBe(3);
        expect(out.shouldRetry).toBe(false);
        expect(out.subscription.status).toBe('failed');
        expect(subscriptionsRepo.markFailed).toHaveBeenCalledWith('sub-1');
        expect(deliveriesRepo.recordAttempt).toHaveBeenCalledWith(
            'd-1',
            expect.objectContaining({ status: 'failed' }),
        );
    });

    it('does NOT retry 4xx but still bumps the failure counter', async () => {
        process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES = '10';
        const { svc, subscriptionsRepo, deliveriesRepo } = setup({
            deliverResult: {
                ok: false,
                outcome: 'client_error',
                status: 410,
                deliveryId: 'd-1',
            },
        });
        const out = await svc.dispatch({
            subscriptionId: 'sub-1',
            event: 'x',
            payload: {},
            deliveryId: 'd-1',
        });
        expect(out.shouldRetry).toBe(false);
        expect(subscriptionsRepo.incrementFailure).toHaveBeenCalled();
        expect(subscriptionsRepo.markFailed).not.toHaveBeenCalled();
        expect(deliveriesRepo.recordAttempt).toHaveBeenCalledWith(
            'd-1',
            expect.objectContaining({ status: 'failed', lastOutcome: 'client_error' }),
        );
    });

    it('does NOT retry redirect_refused', async () => {
        process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES = '10';
        const { svc } = setup({
            deliverResult: {
                ok: false,
                outcome: 'redirect_refused',
                status: 302,
                deliveryId: 'd-1',
            },
        });
        const out = await svc.dispatch({
            subscriptionId: 'sub-1',
            event: 'x',
            payload: {},
            deliveryId: 'd-1',
        });
        expect(out.shouldRetry).toBe(false);
    });

    it('does NOT retry payload_too_large', async () => {
        const { svc } = setup({
            deliverResult: {
                ok: false,
                outcome: 'payload_too_large',
                deliveryId: 'd-1',
                error: 'payload_too_large bytes=2097153',
            },
        });
        const out = await svc.dispatch({
            subscriptionId: 'sub-1',
            event: 'x',
            payload: {},
            deliveryId: 'd-1',
        });
        expect(out.shouldRetry).toBe(false);
    });

    it('retries timeout outcomes', async () => {
        process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES = '10';
        const { svc } = setup({
            deliverResult: { ok: false, outcome: 'timeout', deliveryId: 'd-1' },
        });
        const out = await svc.dispatch({
            subscriptionId: 'sub-1',
            event: 'x',
            payload: {},
            deliveryId: 'd-1',
        });
        expect(out.shouldRetry).toBe(true);
    });

    it('treats an empty decrypted secret as decrypt_failed and refuses to send', async () => {
        const { svc, deliveryService } = setup({
            deliverResult: { ok: true, outcome: 'success', deliveryId: 'd' },
        });
        svc.setSecretDecryptor(() => '');
        const out = await svc.dispatch({
            subscriptionId: 'sub-1',
            event: 'x',
            payload: {},
            deliveryId: 'd-1',
        });
        expect(out.shouldRetry).toBe(false);
        expect(out.result.error).toBe('decrypt_failed');
        expect(deliveryService.deliver).not.toHaveBeenCalled();
    });
});
