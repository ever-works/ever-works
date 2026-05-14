import {
    CloudflareDnsError,
    CloudflareDnsProvider,
    EverWorksDnsService,
} from '../cloudflare-dns.provider';

describe('CloudflareDnsProvider (EW-617 G5)', () => {
    type FetchCall = { url: string; init: RequestInit };

    function buildProvider(opts: {
        listResult?: any[];
        createResult?: any;
        updateResult?: any;
        deleteOk?: boolean;
        deleteStatus?: number;
        deleteBody?: any;
    } = {}) {
        const calls: FetchCall[] = [];
        const fakeFetch = jest.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            const method = (init.method ?? 'GET').toUpperCase();
            if (method === 'GET' && url.includes('/dns_records?')) {
                return new Response(
                    JSON.stringify({ success: true, result: opts.listResult ?? [] }),
                    { status: 200 },
                );
            }
            if (method === 'POST' && url.endsWith('/dns_records')) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: opts.createResult ?? {
                            id: 'rec-new',
                            type: 'CNAME',
                            name: JSON.parse(init.body as string).name,
                            content: JSON.parse(init.body as string).content,
                        },
                    }),
                    { status: 200 },
                );
            }
            if (method === 'PUT' && url.includes('/dns_records/')) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: opts.updateResult ?? {
                            id: 'rec-existing',
                            type: 'CNAME',
                            name: JSON.parse(init.body as string).name,
                            content: JSON.parse(init.body as string).content,
                        },
                    }),
                    { status: 200 },
                );
            }
            if (method === 'DELETE' && url.includes('/dns_records/')) {
                if (opts.deleteOk === false) {
                    return new Response(
                        JSON.stringify({
                            success: false,
                            errors: opts.deleteBody ?? [{ code: 7003, message: 'no route' }],
                        }),
                        { status: opts.deleteStatus ?? 404 },
                    );
                }
                return new Response(JSON.stringify({ success: true, result: { id: 'x' } }), {
                    status: 200,
                });
            }
            throw new Error(`Unexpected fetch ${method} ${url}`);
        }) as any;

        const provider = new CloudflareDnsProvider(
            {
                apiToken: 'tk',
                zoneId: 'zone1',
                rootDomain: 'ever.works',
                targetHostname: 'k8s.lb.example',
            },
            fakeFetch,
        );

        return { provider, calls, fakeFetch };
    }

    it('creates a fresh CNAME when no record exists', async () => {
        const { provider, calls } = buildProvider({ listResult: [] });
        const result = await provider.ensureWorkSubdomain('ai-coding');

        expect(result.name).toBe('ai-coding.ever.works');
        expect(result.content).toBe('k8s.lb.example');
        expect(calls).toHaveLength(2);
        expect(calls[0].url).toContain('name=ai-coding.ever.works');
        expect(calls[0].init.method).toBe('GET');
        expect(calls[1].init.method).toBe('POST');
        const body = JSON.parse(calls[1].init.body as string);
        expect(body).toMatchObject({
            type: 'CNAME',
            name: 'ai-coding.ever.works',
            content: 'k8s.lb.example',
            proxied: false,
            ttl: 1,
        });
    });

    it('returns the existing record when content already matches', async () => {
        const { provider, calls } = buildProvider({
            listResult: [
                {
                    id: 'rec-existing',
                    type: 'CNAME',
                    name: 'ai-coding.ever.works',
                    content: 'k8s.lb.example',
                },
            ],
        });
        const result = await provider.ensureWorkSubdomain('ai-coding');
        expect(result.id).toBe('rec-existing');
        // GET only — no POST/PUT.
        expect(calls).toHaveLength(1);
        expect(calls[0].init.method).toBe('GET');
    });

    it('PUTs an updated CNAME when the content drifted from target', async () => {
        const { provider, calls } = buildProvider({
            listResult: [
                {
                    id: 'rec-drifted',
                    type: 'CNAME',
                    name: 'ai-coding.ever.works',
                    content: 'old.lb.example',
                },
            ],
        });
        const result = await provider.ensureWorkSubdomain('ai-coding');
        expect(calls.map((c) => c.init.method)).toEqual(['GET', 'PUT']);
        expect(calls[1].url).toContain('/dns_records/rec-drifted');
        expect(result.content).toBe('k8s.lb.example');
    });

    it('rejects slugs that fail the DNS-safe regex', async () => {
        const { provider } = buildProvider();
        await expect(provider.ensureWorkSubdomain('NOT_OK')).rejects.toThrow(/Invalid slug/);
    });

    it('no-ops when removing a non-existent record', async () => {
        const { provider, calls } = buildProvider({ listResult: [] });
        await expect(provider.removeWorkSubdomain('gone')).resolves.toBeUndefined();
        expect(calls).toHaveLength(1);
        expect(calls[0].init.method).toBe('GET');
    });

    it('deletes the record when one exists', async () => {
        const { provider, calls } = buildProvider({
            listResult: [
                {
                    id: 'rec-to-go',
                    type: 'CNAME',
                    name: 'foo.ever.works',
                    content: 'old.lb',
                },
            ],
        });
        await provider.removeWorkSubdomain('foo');
        expect(calls.map((c) => c.init.method)).toEqual(['GET', 'DELETE']);
        expect(calls[1].url).toContain('/dns_records/rec-to-go');
    });

    it('throws CloudflareDnsError on a non-success API response', async () => {
        const fakeFetch = jest.fn(async () =>
            new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), {
                status: 401,
            }),
        ) as any;
        const provider = new CloudflareDnsProvider(
            { apiToken: 'bad', zoneId: 'z', rootDomain: 'ever.works', targetHostname: 'lb' },
            fakeFetch,
        );
        await expect(provider.ensureWorkSubdomain('x')).rejects.toThrow(CloudflareDnsError);
    });

    it('sends bearer authorization on every request', async () => {
        const { provider, calls } = buildProvider({ listResult: [] });
        await provider.ensureWorkSubdomain('ai-coding');
        for (const c of calls) {
            expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer tk');
        }
    });
});

describe('EverWorksDnsService (EW-617 G5)', () => {
    const ENV_KEYS = [
        'CLOUDFLARE_API_TOKEN',
        'CLOUDFLARE_ZONE_ID',
        'EVER_WORKS_DOMAIN',
        'EVER_WORKS_DEPLOY_LB_HOSTNAME',
    ] as const;

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

    it('returns null from getProvider() when env is unset (dev / preview)', () => {
        const svc = new EverWorksDnsService();
        expect(svc.getProvider()).toBeNull();
    });

    it('caches the null result so we do not re-read env per call', () => {
        const svc = new EverWorksDnsService();
        const a = svc.getProvider();
        const b = svc.getProvider();
        expect(a).toBe(b);
        expect(a).toBeNull();
    });

    it('builds a provider once env is fully configured', () => {
        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';
        process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'k8s.lb.example';

        const svc = new EverWorksDnsService();
        const provider = svc.getProvider();
        expect(provider).toBeInstanceOf(CloudflareDnsProvider);
    });

    it('defaults rootDomain to "ever.works" when env is not overridden', () => {
        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';
        process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'k8s.lb';
        const svc = new EverWorksDnsService();
        expect(svc.ingressHostFor('ai-coding')).toBe('ai-coding.ever.works');
    });

    it('respects EVER_WORKS_DOMAIN override for ingressHostFor', () => {
        process.env.EVER_WORKS_DOMAIN = 'preview.ever.works';
        const svc = new EverWorksDnsService();
        expect(svc.ingressHostFor('ai-coding')).toBe('ai-coding.preview.ever.works');
    });

    it('swallows ensureWorkSubdomain errors so a flaky DNS does not abort deploys', async () => {
        process.env.CLOUDFLARE_API_TOKEN = 'tk';
        process.env.CLOUDFLARE_ZONE_ID = 'zone1';
        process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME = 'k8s.lb';

        const svc = new EverWorksDnsService();
        const provider = svc.getProvider()!;
        jest.spyOn(provider, 'ensureWorkSubdomain').mockRejectedValue(new Error('boom'));

        await expect(svc.ensureWorkSubdomain('ai-coding')).resolves.toBeUndefined();
    });
});
