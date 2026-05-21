import {
    PayloadTooLargeError,
    WEBHOOK_MAX_BODY_BYTES,
    WebhookDeliveryService,
    type WebhookHttpClient,
} from '../webhook-delivery.service';

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

    it('emits the Ever-Works-branded signature header alongside the GitHub-style alias', () => {
        const signed = service.sign({
            url: 'https://hooks.example.com/path',
            secret: 'shh',
            event: 'work.created',
            payload: { workId: 'w-1' },
            deliveryId: 'fixed-uuid',
        });
        expect(signed.headers['X-Ever-Works-Signature-256']).toBe(
            signed.headers['X-Hub-Signature-256'],
        );
        expect(signed.headers['X-Ever-Works-Signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);
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
        expect(a.headers['X-Ever-Works-Signature-256']).not.toBe(
            b.headers['X-Ever-Works-Signature-256'],
        );
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

    it('throws PayloadTooLargeError when the serialized body exceeds 1 MiB', () => {
        const huge = 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1);
        expect(() =>
            service.sign({
                url: 'https://hooks.example.com/p',
                secret: 's',
                event: 'x',
                payload: { huge },
            }),
        ).toThrow(PayloadTooLargeError);
    });
});

describe('WebhookDeliveryService.verify', () => {
    it('verifies a signature produced by sign() — Ever-Works header', () => {
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
            signed.headers['X-Ever-Works-Signature-256'],
            'shh',
        );
        expect(ok).toBe(true);
    });

    it('verifies a signature produced by sign() — GitHub-style alias header', () => {
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
            signed.headers['X-Ever-Works-Signature-256'],
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
            signed.headers['X-Ever-Works-Signature-256'],
            's',
        );
        expect(ok).toBe(false);
    });

    it('rejects an empty header value', () => {
        expect(WebhookDeliveryService.verify('{}', '', 's')).toBe(false);
    });
});

describe('WebhookDeliveryService.deliver', () => {
    it('returns ok / success for 2xx responses', async () => {
        const okClient: WebhookHttpClient = {
            post: jest.fn().mockResolvedValue({ status: 202 }),
        };
        const svc = new WebhookDeliveryService(okClient);
        const result = await svc.deliver({
            url: 'https://hooks.example.com/p',
            secret: 's',
            event: 'x',
            payload: { a: 1 },
        });
        expect(result.ok).toBe(true);
        expect(result.outcome).toBe('success');
        expect(result.status).toBe(202);
    });

    it('classifies 5xx as server_error (retryable)', async () => {
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
        expect(result.outcome).toBe('server_error');
        expect(result.status).toBe(502);
    });

    it('classifies 4xx as client_error (NOT retryable)', async () => {
        const failingClient: WebhookHttpClient = {
            post: jest.fn().mockResolvedValue({ status: 410 }),
        };
        const svc = new WebhookDeliveryService(failingClient);
        const result = await svc.deliver({
            url: 'https://hooks.example.com/p',
            secret: 's',
            event: 'x',
            payload: {},
        });
        expect(result.ok).toBe(false);
        expect(result.outcome).toBe('client_error');
        expect(result.status).toBe(410);
    });

    it('classifies 3xx as redirect_refused (NOT retryable)', async () => {
        const redirectClient: WebhookHttpClient = {
            post: jest.fn().mockResolvedValue({ status: 301 }),
        };
        const svc = new WebhookDeliveryService(redirectClient);
        const result = await svc.deliver({
            url: 'https://hooks.example.com/p',
            secret: 's',
            event: 'x',
            payload: {},
        });
        expect(result.ok).toBe(false);
        expect(result.outcome).toBe('redirect_refused');
        expect(result.status).toBe(301);
    });

    it('classifies an AbortError as timeout (retryable)', async () => {
        const timeoutClient: WebhookHttpClient = {
            post: jest.fn().mockImplementation(() => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                throw err;
            }),
        };
        const svc = new WebhookDeliveryService(timeoutClient);
        const result = await svc.deliver({
            url: 'https://hooks.example.com/p',
            secret: 's',
            event: 'x',
            payload: {},
        });
        expect(result.ok).toBe(false);
        expect(result.outcome).toBe('timeout');
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
        expect(result.outcome).toBe('ssrf_blocked');
        expect(result.error).toBe('ssrf_blocked');
        expect(client.post).not.toHaveBeenCalled();
    });

    it('returns server_error with the underlying message when the HTTP client throws a non-abort error', async () => {
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
        expect(result.outcome).toBe('server_error');
        expect(result.error).toBe('ECONNREFUSED');
    });

    it('returns payload_too_large without calling the HTTP client when body exceeds 1 MiB', async () => {
        const client: WebhookHttpClient = { post: jest.fn() };
        const svc = new WebhookDeliveryService(client);
        const huge = 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1);
        const result = await svc.deliver({
            url: 'https://hooks.example.com/p',
            secret: 's',
            event: 'x',
            payload: { huge },
        });
        expect(result.ok).toBe(false);
        expect(result.outcome).toBe('payload_too_large');
        expect(client.post).not.toHaveBeenCalled();
    });

    it('records a non-zero durationMs on successful delivery', async () => {
        const client: WebhookHttpClient = {
            post: jest.fn().mockImplementation(async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                return { status: 200 };
            }),
        };
        const svc = new WebhookDeliveryService(client);
        const result = await svc.deliver({
            url: 'https://hooks.example.com/p',
            secret: 's',
            event: 'x',
            payload: {},
        });
        expect(result.ok).toBe(true);
        expect(typeof result.durationMs).toBe('number');
        expect(result.durationMs!).toBeGreaterThanOrEqual(0);
    });
});
