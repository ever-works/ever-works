import { OnboardingTerminalService } from './onboarding-terminal.service';

jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    OnboardingRequest: class OnboardingRequest {},
    WebhookSubscription: class WebhookSubscription {},
}));

describe('OnboardingTerminalService', () => {
    const baseInput = {
        onboardingId: 'ob-1',
        workId: 'w-1',
        status: 'deployed' as const,
        subdomain: 'mydir.ever.works',
        deploymentUrl: 'https://mydir.ever.works',
    };

    const create = (overrides: {
        onboardingRow?: Partial<{ id: string; webhookUrl: string | null; accountId: string | null }>;
        deliveryResult?: { ok: boolean; status?: number };
        subscriptions?: Array<{ id: string; url: string; secretEncrypted: string }>;
    } = {}) => {
        const onboardingRepo = {
            findById: jest.fn().mockResolvedValue(
                overrides.onboardingRow === undefined
                    ? { id: 'ob-1', webhookUrl: 'https://hooks.example.com/p', accountId: null }
                    : overrides.onboardingRow,
            ),
        };
        const webhookSubs = {
            listActiveForWork: jest.fn().mockResolvedValue(overrides.subscriptions ?? []),
            markSuccess: jest.fn().mockResolvedValue(undefined),
            incrementFailure: jest.fn().mockResolvedValue(1),
            markFailed: jest.fn().mockResolvedValue(undefined),
        };
        const delivery = {
            deliver: jest
                .fn()
                .mockResolvedValue(overrides.deliveryResult ?? { ok: true, status: 202, deliveryId: 'd-1' }),
        };
        const svc = new OnboardingTerminalService(
            onboardingRepo as any,
            webhookSubs as any,
            delivery as any,
        );
        return { svc, onboardingRepo, webhookSubs, delivery };
    };

    it('returns markerWritten=false and no webhook when no row exists', async () => {
        const { svc, onboardingRepo, delivery } = create({ onboardingRow: null as any });
        const result = await svc.notify(baseInput);
        expect(onboardingRepo.findById).toHaveBeenCalledWith('ob-1');
        expect(delivery.deliver).not.toHaveBeenCalled();
        expect(result.markerWritten).toBe(false);
    });

    it('delivers a webhook for the per-request hook URL', async () => {
        const { svc, delivery } = create();
        const result = await svc.notify(baseInput);
        expect(delivery.deliver).toHaveBeenCalledTimes(1);
        const arg = delivery.deliver.mock.calls[0][0];
        expect(arg.url).toBe('https://hooks.example.com/p');
        expect(arg.event).toBe('onboarding.terminal');
        expect(arg.payload.status).toBe('deployed');
        expect(arg.payload.workId).toBe('w-1');
        expect(result.webhook?.ok).toBe(true);
    });

    it('marks subscriptions success when delivery is 2xx', async () => {
        const { svc, webhookSubs, delivery } = create({
            onboardingRow: {
                id: 'ob-1',
                webhookUrl: null,
                accountId: 'acc-1',
            },
            subscriptions: [
                { id: 'sub-1', url: 'https://hooks.example.com/x', secretEncrypted: 's1' },
                { id: 'sub-2', url: 'https://hooks.example.com/y', secretEncrypted: 's2' },
            ],
            deliveryResult: { ok: true, status: 200 },
        });

        await svc.notify(baseInput);
        expect(delivery.deliver).toHaveBeenCalledTimes(2);
        expect(webhookSubs.markSuccess).toHaveBeenCalledTimes(2);
        expect(webhookSubs.markSuccess.mock.calls.map((c) => c[0])).toEqual(['sub-1', 'sub-2']);
    });

    it('increments failure counter and marks failed at 6 consecutive failures', async () => {
        const { svc, webhookSubs } = create({
            onboardingRow: { id: 'ob-1', webhookUrl: null, accountId: 'acc-1' },
            subscriptions: [{ id: 'sub-1', url: 'https://h.ex/x', secretEncrypted: 's' }],
            deliveryResult: { ok: false, status: 502 },
        });
        webhookSubs.incrementFailure.mockResolvedValueOnce(6);

        await svc.notify(baseInput);
        expect(webhookSubs.incrementFailure).toHaveBeenCalledWith('sub-1');
        expect(webhookSubs.markFailed).toHaveBeenCalledWith('sub-1');
    });

    it('passes failure metadata into the payload', async () => {
        const { svc, delivery } = create();
        await svc.notify({
            ...baseInput,
            status: 'failed',
            failureCode: 'manifest_invalid',
            failureMessage: 'spec.domain invalid',
        });
        const arg = delivery.deliver.mock.calls[0][0];
        expect(arg.payload.status).toBe('failed');
        expect(arg.payload.failureCode).toBe('manifest_invalid');
        expect(arg.payload.failureMessage).toBe('spec.domain invalid');
    });
});
