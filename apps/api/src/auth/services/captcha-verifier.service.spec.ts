import { CaptchaVerifierService } from './captcha-verifier.service';

describe('CaptchaVerifierService (EW-617 G7)', () => {
    const ENV_KEYS = ['CAPTCHA_PROVIDER', 'CAPTCHA_SECRET', 'CAPTCHA_VERIFY_URL'] as const;
    const previous: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of ENV_KEYS) {
            previous[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (previous[k] === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = previous[k];
            }
        }
    });

    function buildSvc(fetchImpl?: typeof fetch) {
        const fakeFetch = fetchImpl ?? (jest.fn() as any);
        const svc = new CaptchaVerifierService(fakeFetch);
        svc.resetCacheForTest();
        return { svc, fakeFetch };
    }

    it('returns success+skipped when no provider is configured (dev/preview default)', async () => {
        const { svc, fakeFetch } = buildSvc();
        const result = await svc.verify({ token: 'whatever' });
        expect(result).toEqual({ success: true, skipped: true });
        expect(fakeFetch).not.toHaveBeenCalled();
    });

    it('rejects empty token even when provider is enabled', async () => {
        process.env.CAPTCHA_PROVIDER = 'turnstile';
        process.env.CAPTCHA_SECRET = 'tk';
        const { svc, fakeFetch } = buildSvc();
        const result = await svc.verify({ token: '' });
        expect(result.success).toBe(false);
        expect(result.skipped).toBe(false);
        expect(result.errorCodes).toContain('missing-input-response');
        expect(fakeFetch).not.toHaveBeenCalled();
    });

    it('POSTs to the Turnstile verify URL with secret+response and parses success', async () => {
        process.env.CAPTCHA_PROVIDER = 'turnstile';
        process.env.CAPTCHA_SECRET = 'sec';
        const fakeFetch = jest.fn(async (url: string, init: RequestInit) =>
            new Response(JSON.stringify({ success: true, hostname: 'ever.works' }), {
                status: 200,
            }),
        ) as any;
        const { svc } = buildSvc(fakeFetch);

        const result = await svc.verify({ token: 'tok-1', remoteIp: '1.2.3.4' });

        expect(result).toEqual({
            success: true,
            skipped: false,
            errorCodes: undefined,
            hostname: 'ever.works',
        });
        expect(fakeFetch).toHaveBeenCalledTimes(1);
        const [url, init] = fakeFetch.mock.calls[0];
        expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
        expect(init.method).toBe('POST');
        const body = new URLSearchParams(init.body as string);
        expect(body.get('secret')).toBe('sec');
        expect(body.get('response')).toBe('tok-1');
        expect(body.get('remoteip')).toBe('1.2.3.4');
    });

    it('treats success=false from provider as a failed verify (no throw)', async () => {
        process.env.CAPTCHA_PROVIDER = 'turnstile';
        process.env.CAPTCHA_SECRET = 'sec';
        const fakeFetch = jest.fn(async () =>
            new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
                status: 200,
            }),
        ) as any;
        const { svc } = buildSvc(fakeFetch);

        const result = await svc.verify({ token: 'tok-2' });
        expect(result.success).toBe(false);
        expect(result.errorCodes).toEqual(['invalid-input-response']);
    });

    it('falls open (success=true skipped) when the verifier throws — provider outage', async () => {
        process.env.CAPTCHA_PROVIDER = 'turnstile';
        process.env.CAPTCHA_SECRET = 'sec';
        const fakeFetch = jest.fn(async () => {
            throw new Error('econnreset');
        }) as any;
        const { svc } = buildSvc(fakeFetch);

        const result = await svc.verify({ token: 'tok-3' });
        expect(result.success).toBe(true);
        expect(result.skipped).toBe(true);
        expect(result.errorCodes).toEqual(['verifier-exception']);
    });

    it('lets CAPTCHA_VERIFY_URL override the default for staging mirrors', async () => {
        process.env.CAPTCHA_PROVIDER = 'turnstile';
        process.env.CAPTCHA_SECRET = 'sec';
        process.env.CAPTCHA_VERIFY_URL = 'https://staging-verify.local/siteverify';
        const fakeFetch = jest.fn(async () => new Response(JSON.stringify({ success: true }))) as any;
        const { svc } = buildSvc(fakeFetch);

        await svc.verify({ token: 't' });
        expect(fakeFetch.mock.calls[0][0]).toBe('https://staging-verify.local/siteverify');
    });

    it('treats unknown provider as disabled (no verify URL resolves)', async () => {
        process.env.CAPTCHA_PROVIDER = 'invented';
        process.env.CAPTCHA_SECRET = 'sec';
        const { svc, fakeFetch } = buildSvc();
        expect(svc.isEnabled()).toBe(false);
        const result = await svc.verify({ token: 't' });
        expect(result).toEqual({ success: true, skipped: true });
        expect(fakeFetch).not.toHaveBeenCalled();
    });
});
