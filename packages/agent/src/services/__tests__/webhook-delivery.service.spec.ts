import { WebhookDeliveryService, type WebhookHttpClient } from '../webhook-delivery.service';

describe('WebhookDeliveryService.sign', () => {
    const service = new WebhookDeliveryService();

    it('produces a deterministic HMAC-SHA256 signature for the same body+secret', () => {
        const a = service.sign({
            url: 'https://hooks.example.com/path',
            secret: 'shh',
            event: 'onboarding.terminal',
            payload: { workId: 'w-1', status: 'deployed' },
            deliveryId: 'fixed-uuid',
        });
        const b = service.sign({
            url: 'https://hooks.example.com/path',
            secret: 'shh',
            event: 'onboarding.terminal',
            payload: { workId: 'w-1', status: 'deployed' },
            deliveryId: 'fixed-uuid',
        });
        expect(a.headers['X-Hub-Signature-256']).toBe(b.headers['X-Hub-Signature-256']);
        expect(a.headers['X-Hub-Signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);
    });

    it('produces a different signature when the secret changes', () => {
        const a = service.sign({
            url: 'https://hooks.example.com/p',
            secret: 'one',
            event: 'x',
            payload: { a: 1 },
        });
        const b = service.sign({
            url: 'https://hooks.example.com/p',
            secret: 'two',
            event: 'x',
            payload: { a: 1 },
        });
        expect(a.headers['X-Hub-Signature-256']).not.toBe(b.headers['X-Hub-Signature-256']);
    });

    it('emits required headers', () => {
        const signed = service.sign({
            url: 'https://hooks.example.com/p',
            secret: 'shh',
            event: 'work.regenerated',
            payload: { workId: 'w' },
        });
        expect(signed.headers['Content-Type']).toBe('application/json; charset=utf-8');
        expect(signed.headers['X-Ever-Works-Event']).toBe('work.regenerated');
        expect(signed.headers['X-Ever-Works-Delivery']).toEqual(signed.deliveryId);
    });

    it('uses provided deliveryId when supplied', () => {
        const signed = service.sign({
            url: 'https://hooks.example.com/p',
            secret: 'shh',
            event: 'x',
            payload: {},
            deliveryId: 'abc-123',
        });
        expect(signed.deliveryId).toBe('abc-123');
        expect(signed.headers['X-Ever-Works-Delivery']).toBe('abc-123');
    });
});

describe('WebhookDeliveryService.verify', () => {
    it('verifies a signature produced by sign()', () => {
        const svc = new WebhookDeliveryService();
        const signed = svc.sign({
            url: 'https://hooks.example.com/p',
            secret: 'shh',
            event: 'x',
            payload: { hello: 'world' },
            deliveryId: 'd-1',
        });
        const ok = WebhookDeliveryService.verify(
            signed.body,
            signed.headers['X-Hub-Signature-256'],
            'shh',
        );
        expect(ok).toBe(true);
    });

    it('rejects when the secret differs', () => {
        const svc = new WebhookDeliveryService();
        const signed = svc.sign({
            url: 'https://hooks.example.com/p',
            secret: 'good',
            event: 'x',
            payload: {},
            deliveryId: 'd-1',
        });
        const ok = WebhookDeliveryService.verify(
            signed.body,
            signed.headers['X-Hub-Signature-256'],
            'bad',
        );
        expect(ok).toBe(false);
    });

    it('rejects when the body has been tampered with', () => {
        const svc = new WebhookDeliveryService();
        const signed = svc.sign({
            url: 'https://hooks.example.com/p',
            secret: 's',
            event: 'x',
            payload: {},
            deliveryId: 'd-1',
        });
        const ok = WebhookDeliveryService.verify(
            '{"tampered":true}',
            signed.headers['X-Hub-Signature-256'],
            's',
        );
        expect(ok).toBe(false);
    });
});

describe('WebhookDeliveryService.deliver', () => {
    const okClient: WebhookHttpClient = {
        post: jest.fn().mockResolvedValue({ status: 202 }),
    };

    it('returns ok for 2xx responses', async () => {
        const svc = new WebhookDeliveryService(okClient);
        const result = await svc.deliver({
            url: 'https://hooks.example.com/p',
            secret: 's',
            event: 'x',
            payload: { a: 1 },
        });
        expect(result.ok).toBe(true);
        expect(result.status).toBe(202);
    });

    it('returns not ok for 5xx responses', async () => {
        const failingClient: WebhookHttpClient = {
            post: jest.fn().mockResolvedValue({ status: 502 }),
        };
        const svc = new WebhookDeliveryService(failingClient);
        const result = await svc.deliver({
            url: 'https://hooks.example.com/p',
            secret: 's',
            event: 'x',
            payload: {},
        });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(502);
    });

    it('returns ssrf_blocked without calling the HTTP client when the URL is private', async () => {
        const client: WebhookHttpClient = { post: jest.fn() };
        const svc = new WebhookDeliveryService(client);
        const result = await svc.deliver({
            url: 'http://127.0.0.1/incoming',
            secret: 's',
            event: 'x',
            payload: {},
        });
        expect(result.ok).toBe(false);
        expect(result.error).toBe('ssrf_blocked');
        expect(client.post).not.toHaveBeenCalled();
    });

    it('returns not ok with the underlying error when the HTTP client throws', async () => {
        const client: WebhookHttpClient = {
            post: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        };
        const svc = new WebhookDeliveryService(client);
        const result = await svc.deliver({
            url: 'https://hooks.example.com/p',
            secret: 's',
            event: 'x',
            payload: {},
        });
        expect(result.ok).toBe(false);
        expect(result.error).toBe('ECONNREFUSED');
    });
});
