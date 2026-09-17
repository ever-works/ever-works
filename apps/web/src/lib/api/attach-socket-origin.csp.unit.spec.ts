import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The socket URL the attach-token routes mint, and the `connect-src` sources
 * the CSP emits, must agree in EVERY deployment shape.
 *
 * They live in two modules that cannot share code: `lib/csp-api-sources.ts`
 * is evaluated by Next's config loader outside the app's module graph, so it
 * may not import `lib/api/attach-socket-origin.ts` (path aliases, the
 * `lib/constants` module). Nothing but this spec stops the two from drifting.
 *
 * For each shape the browser needs two things, and this asserts both:
 *
 *  1. the minted socket origin is one it can REACH (never an in-cluster name
 *     when a public origin is configured), and
 *  2. the policy AUTHORISES that exact origin.
 *
 * Nothing is mocked: `lib/constants` computes `API_URL` from the env exactly
 * as it does in production, and both modules are re-imported per case.
 */

const WS_PATH = '/ws/computer/33333333-2222-4333-8444-555555555555';

interface Shape {
    readonly name: string;
    readonly env: { API_URL?: string; NEXT_PUBLIC_API_URL?: string };
    /** The origin a user's browser must be told to dial. */
    readonly socketOrigin: string;
}

const SHAPES: readonly Shape[] = [
    {
        name: 'nothing set',
        env: {},
        socketOrigin: 'ws://localhost:3100',
    },
    {
        name: 'apps/web/.env.example (API_URL only, localhost)',
        env: { API_URL: 'http://localhost:3100' },
        socketOrigin: 'ws://localhost:3100',
    },
    {
        name: 'single-origin install: public API_URL, NEXT_PUBLIC_API_URL unset',
        env: { API_URL: 'https://api.ever.works' },
        socketOrigin: 'wss://api.ever.works',
    },
    {
        name: '.github/workflows/e2e.yml',
        env: { API_URL: 'http://127.0.0.1:3100', NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3100/api' },
        socketOrigin: 'ws://127.0.0.1:3100',
    },
    {
        name: '.env.compose / .env.demo.compose',
        env: {
            API_URL: 'http://ever-works-api:3100',
            NEXT_PUBLIC_API_URL: 'http://localhost:3100',
        },
        socketOrigin: 'ws://localhost:3100',
    },
    {
        name: '.deploy/k8s prod web Deployment',
        env: {
            API_URL: 'http://ever-works-api:3100',
            NEXT_PUBLIC_API_URL: 'https://api.ever.works',
        },
        socketOrigin: 'wss://api.ever.works',
    },
    {
        name: '.deploy/k8s stage web Deployment',
        env: {
            API_URL: 'http://ever-works-api-stage:3100',
            NEXT_PUBLIC_API_URL: 'https://apistage.ever.works',
        },
        socketOrigin: 'wss://apistage.ever.works',
    },
    {
        name: '.deploy/k8s dev web Deployment',
        env: {
            API_URL: 'http://ever-works-api-dev:3100',
            NEXT_PUBLIC_API_URL: 'https://apidev.ever.works',
        },
        socketOrigin: 'wss://apidev.ever.works',
    },
    {
        name: 'IPv6 loopback API_URL',
        env: { API_URL: 'http://[::1]:3100' },
        socketOrigin: 'ws://[::1]:3100',
    },
];

async function load(env: Shape['env']) {
    // `undefined` genuinely unsets the variable for the duration of the test.
    vi.stubEnv('API_URL', env.API_URL);
    vi.stubEnv('NEXT_PUBLIC_API_URL', env.NEXT_PUBLIC_API_URL);
    vi.resetModules();
    const [{ toAttachSocketUrl }, { resolveApiCspSocketSources }] = await Promise.all([
        import('./attach-socket-origin'),
        import('@/lib/csp-api-sources'),
    ]);
    return { minted: toAttachSocketUrl(WS_PATH), sources: resolveApiCspSocketSources() };
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('attach socket URL and connect-src agree in every deployment shape', () => {
    it.each(SHAPES)('$name', async ({ env, socketOrigin }) => {
        const { minted, sources } = await load(env);

        expect(minted).toBe(`${socketOrigin}${WS_PATH}`);
        expect(sources).toContain(new URL(minted).origin);
    });

    it('never mints on the in-cluster name once a public origin is configured', async () => {
        const { minted, sources } = await load({
            API_URL: 'http://ever-works-api:3100',
            NEXT_PUBLIC_API_URL: 'https://api.ever.works',
        });

        expect(new URL(minted).hostname).toBe('api.ever.works');
        // The policy still lists the in-cluster twin too. That is its rule, not
        // a leak from this configuration: it always emits both twins so an
        // install that sets API_URL alone stays authorised. Nothing mints on it
        // here, and a browser cannot resolve the name anyway.
        expect(sources).toEqual(['wss://api.ever.works', 'ws://ever-works-api:3100']);
    });
});
