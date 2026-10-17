import { WebhookDeliveryService, type WebhookHttpClient } from '../webhook-delivery.service';
import { WebhookSubscriptionDeliveryService } from '../webhook-subscription-delivery.service';
import { verifyWebhookV2Signature } from '../webhook-signature-v2';

/**
 * Webhooks v2 delivery (EW-P1-5): `X-Ever-Works-Signature: t=,v1=` over
 * `"<t>.<rawBody>"`, `X-Ever-Works-Event-Id`, no legacy `sha256=` headers, and
 * a second `v1=` during a secret rotation's grace window.
 */
const ENVELOPE = {
    id: 'evt_01JABZ3K9QW8E5R2T7Y4V6X0ZP',
    seq: '42',
    type: 'task.updated',
    data: { id: 't-1', title: 'Ship it — 🚀' },
};

describe('webhooks v2 delivery', () => {
    it('signs v2 deliveries with t=,v1= that the reference verifier accepts', () => {
        const service = new WebhookDeliveryService();
        const signed = service.signV2({
            url: 'https://hooks.example.com/ever',
            secret: 'current-secret-0123456789abcdef0123',
            event: 'task.updated',
            payload: ENVELOPE,
            deliveryId: 'dlv-1',
            timestampSeconds: 1792087200,
        });
        expect(signed.headers).toEqual({
            'Content-Type': 'application/json; charset=utf-8',
            'X-Ever-Works-Signature': expect.stringMatching(/^t=1792087200,v1=[0-9a-f]{64}$/),
            'X-Ever-Works-Event': 'task.updated',
            'X-Ever-Works-Event-Id': ENVELOPE.id,
            'X-Ever-Works-Delivery': 'dlv-1',
        });
        expect(signed.body).toBe(JSON.stringify(ENVELOPE));
        expect(
            verifyWebhookV2Signature(
                signed.body,
                signed.headers['X-Ever-Works-Signature'],
                'current-secret-0123456789abcdef0123',
                1792087200,
            ),
        ).toBe(true);
    });

    it('adds the previous secret as a second v1 during the rotation grace window', () => {
        const signed = new WebhookDeliveryService().signV2({
            url: 'https://hooks.example.com/ever',
            secret: 'current-secret-0123456789abcdef0123',
            previousSecret: 'previous-secret-0123456789abcdef012',
            event: 'task.updated',
            payload: ENVELOPE,
            timestampSeconds: 1792087200,
        });
        const header = signed.headers['X-Ever-Works-Signature'];
        expect(header.split(',').filter((part) => part.startsWith('v1='))).toHaveLength(2);
        for (const secret of [
            'current-secret-0123456789abcdef0123',
            'previous-secret-0123456789abcdef012',
        ]) {
            expect(verifyWebhookV2Signature(signed.body, header, secret, 1792087200)).toBe(true);
        }
    });

    it('deliver() posts the v2 headers for signatureVersion 2 and the v1 headers otherwise', async () => {
        const posts: Array<Record<string, string>> = [];
        const http: WebhookHttpClient = {
            post: async (args) => {
                posts.push(args.headers);
                return { status: 204 };
            },
        };
        const service = new WebhookDeliveryService(http);
        const base = {
            url: 'https://hooks.example.com/ever',
            secret: 'current-secret-0123456789abcdef0123',
            event: 'task.updated',
            payload: ENVELOPE,
        };
        await expect(service.deliver({ ...base, signatureVersion: 2 })).resolves.toMatchObject({
            ok: true,
            outcome: 'success',
        });
        await service.deliver(base);
        expect(Object.keys(posts[0]).sort()).toEqual(
            [
                'Content-Type',
                'X-Ever-Works-Delivery',
                'X-Ever-Works-Event',
                'X-Ever-Works-Event-Id',
                'X-Ever-Works-Signature',
            ].sort(),
        );
        expect(posts[1]).toMatchObject({
            'X-Ever-Works-Signature-256': expect.stringMatching(/^sha256=/),
            'X-Hub-Signature-256': expect.stringMatching(/^sha256=/),
        });
        expect(posts[1]).not.toHaveProperty('X-Ever-Works-Signature');
    });

    describe('orchestrator', () => {
        const setup = (
            sub: Record<string, unknown>,
            access: { allowed: boolean; disable: boolean } | null = {
                allowed: true,
                disable: false,
            },
        ) => {
            const deliver = jest
                .fn()
                .mockResolvedValue({ ok: true, outcome: 'success', deliveryId: 'd' });
            const markDisabled = jest.fn().mockResolvedValue(undefined);
            const service = new WebhookSubscriptionDeliveryService(
                { deliver } as unknown as WebhookDeliveryService,
                {
                    findById: jest.fn().mockResolvedValue({
                        id: 'sub-1',
                        accountId: 'acct-1',
                        url: 'https://hooks.example.com/ever',
                        secretEncrypted: 'enc-current',
                        status: 'active',
                        consecutiveFailures: 0,
                        ...sub,
                    }),
                    markSuccess: jest.fn().mockResolvedValue(undefined),
                    markDisabled,
                } as never,
                { recordAttempt: jest.fn().mockResolvedValue(undefined) } as never,
                access === null
                    ? undefined
                    : ({ canReceive: jest.fn().mockResolvedValue(access) } as never),
            );
            service.setSecretDecryptor((encrypted) =>
                encrypted === 'enc-current'
                    ? 'current'
                    : encrypted === 'enc-previous'
                      ? 'previous'
                      : '',
            );
            return { service, deliver, markDisabled };
        };

        it('signs a v2 subscription v2, with the previous secret while its grace lasts', async () => {
            const { service, deliver } = setup({
                version: 2,
                previousSecretEncrypted: 'enc-previous',
                previousSecretExpiresAt: new Date(Date.now() + 60_000),
            });
            await service.dispatch({
                subscriptionId: 'sub-1',
                event: 'task.updated',
                payload: ENVELOPE,
                deliveryId: 'd',
            });
            expect(deliver).toHaveBeenCalledWith(
                expect.objectContaining({
                    signatureVersion: 2,
                    secret: 'current',
                    previousSecret: 'previous',
                }),
            );
        });

        it('drops an expired previous secret, and keeps v1 subscriptions on v1 signing', async () => {
            const expired = setup({
                version: 2,
                previousSecretEncrypted: 'enc-previous',
                previousSecretExpiresAt: new Date(Date.now() - 1),
            });
            await expired.service.dispatch({
                subscriptionId: 'sub-1',
                event: 'task.updated',
                payload: ENVELOPE,
                deliveryId: 'd',
            });
            expect(expired.deliver).toHaveBeenCalledWith(
                expect.objectContaining({ signatureVersion: 2, previousSecret: null }),
            );

            const legacy = setup({ version: 1 });
            await legacy.service.dispatch({
                subscriptionId: 'sub-1',
                event: 'work.created',
                payload: {},
                deliveryId: 'd',
            });
            expect(legacy.deliver).toHaveBeenCalledWith(
                expect.objectContaining({ signatureVersion: 1 }),
            );
        });

        it('re-checks the owner before a v2 send: no access, no send; revoked, disabled', async () => {
            const left = setup({ version: 2 }, { allowed: false, disable: false });
            const result = await left.service.dispatch({
                subscriptionId: 'sub-1',
                event: 'task.updated',
                payload: { ...ENVELOPE, organizationId: 'org-1' },
                deliveryId: 'd',
            });
            expect(left.deliver).not.toHaveBeenCalled();
            expect(result).toMatchObject({
                shouldRetry: false,
                result: { error: 'owner_access_denied' },
            });
            expect(left.markDisabled).not.toHaveBeenCalled();

            const revoked = setup({ version: 2 }, { allowed: false, disable: true });
            await revoked.service.dispatch({
                subscriptionId: 'sub-1',
                event: 'task.updated',
                payload: ENVELOPE,
                deliveryId: 'd',
            });
            expect(revoked.deliver).not.toHaveBeenCalled();
            expect(revoked.markDisabled).toHaveBeenCalledWith('sub-1');

            // Without the access service a v2 delivery is refused, never sent unchecked.
            const unchecked = setup({ version: 2 }, null);
            await unchecked.service.dispatch({
                subscriptionId: 'sub-1',
                event: 'task.updated',
                payload: ENVELOPE,
                deliveryId: 'd',
            });
            expect(unchecked.deliver).not.toHaveBeenCalled();
        });

        // Review 2026-10-17 F11 (P1): one shared counter must not dead-letter a busy v2
        // subscription during a short outage; the 24 h ladder is the promise.
        describe('dead-letter (F11)', () => {
            const failing = (sub: Record<string, unknown>, failures: number) => {
                const markFailed = jest.fn().mockResolvedValue(undefined);
                const service = new WebhookSubscriptionDeliveryService(
                    {
                        deliver: jest.fn().mockResolvedValue({
                            ok: false,
                            outcome: 'server_error',
                            status: 503,
                            deliveryId: 'd',
                        }),
                    } as unknown as WebhookDeliveryService,
                    {
                        findById: jest.fn().mockResolvedValue({
                            id: 'sub-1',
                            accountId: 'acct-1',
                            url: 'https://hooks.example.com/ever',
                            secretEncrypted: 'enc-current',
                            status: 'active',
                            consecutiveFailures: failures - 1,
                            ...sub,
                        }),
                        incrementFailure: jest.fn().mockResolvedValue(failures),
                        markFailed,
                    } as never,
                    { recordAttempt: jest.fn().mockResolvedValue(undefined) } as never,
                    {
                        canReceive: jest.fn().mockResolvedValue({ allowed: true, disable: false }),
                    } as never,
                );
                service.setSecretDecryptor(() => 'current');
                return { service, markFailed };
            };
            const input = { subscriptionId: 'sub-1', event: 'task.updated', payload: ENVELOPE };
            const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

            it('keeps retrying a v2 subscription that succeeded minutes ago, whatever the counter', async () => {
                const { service, markFailed } = failing(
                    { version: 2, lastDeliveryAt: minutesAgo(2) },
                    25,
                );
                const out = await service.dispatch(input);
                expect(out.shouldRetry).toBe(true);
                expect(out.subscription.status).toBe('active');
                expect(markFailed).not.toHaveBeenCalled();
            });

            it('dead-letters a v2 subscription failing for over 24 h with no success', async () => {
                const { service, markFailed } = failing(
                    { version: 2, lastDeliveryAt: minutesAgo(25 * 60) },
                    10,
                );
                const out = await service.dispatch(input);
                expect(out.shouldRetry).toBe(false);
                expect(out.subscription.status).toBe('failed');
                expect(markFailed).toHaveBeenCalledWith('sub-1');
            });

            it('keeps the counter rule for v1 subscriptions', async () => {
                const { service, markFailed } = failing(
                    { version: 1, lastDeliveryAt: minutesAgo(2) },
                    10,
                );
                const out = await service.dispatch(input);
                expect(out.subscription.status).toBe('failed');
                expect(markFailed).toHaveBeenCalled();
            });
        });

        it('does not deliver to a disabled subscription', async () => {
            const { service, deliver } = setup({ version: 2, status: 'disabled' });
            const result = await service.dispatch({
                subscriptionId: 'sub-1',
                event: 'task.updated',
                payload: ENVELOPE,
                deliveryId: 'd',
            });
            expect(deliver).not.toHaveBeenCalled();
            expect(result).toMatchObject({
                shouldRetry: false,
                result: { error: 'subscription_disabled' },
            });
        });
    });
});
