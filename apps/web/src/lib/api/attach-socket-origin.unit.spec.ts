import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The browser-reachable socket origin, walked across every deployment shape
 * this repo actually ships.
 *
 * Two facts make this worth pinning down case by case:
 *
 *  1. `API_URL` is the SERVER-ONLY address the BFF fetches with. In
 *     `docker-compose.yml` and in every `.deploy/k8s` web Deployment it is
 *     `http://ever-works-api:3100` — a name that resolves inside the cluster
 *     and nowhere else. A socket URL minted from it is dead on arrival in the
 *     browser.
 *  2. A deployment where `API_URL` IS browser-reachable and
 *     `NEXT_PUBLIC_API_URL` is unset must keep minting exactly what it minted
 *     before. Fixing (1) must not narrow (2).
 *
 * `API_URL` is the constant from `lib/constants` (which appends `/api` when
 * the env value lacks it), so each case mocks the constant with the value that
 * constant would actually hold for the environment named in the test.
 */

const WS_PATH = '/ws/terminal/8b1f1e2c-4d5a-4e6b-9c7d-0a1b2c3d4e5f';
const ORIGINAL_PUBLIC = process.env.NEXT_PUBLIC_API_URL;

async function socketUrlFor(shape: { apiUrlConstant: string; publicApiUrl?: string }) {
    vi.resetModules();
    vi.doMock('@/lib/constants', () => ({ API_URL: shape.apiUrlConstant }));
    if (shape.publicApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = shape.publicApiUrl;
    const { toAttachSocketUrl, resolveBrowserApiBaseUrl } = await import('./attach-socket-origin');
    return { url: toAttachSocketUrl(WS_PATH), base: resolveBrowserApiBaseUrl() };
}

afterEach(() => {
    if (ORIGINAL_PUBLIC === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = ORIGINAL_PUBLIC;
    vi.doUnmock('@/lib/constants');
    vi.resetModules();
});

describe('browser-reachable attach socket origin', () => {
    it('keeps the API_URL origin when nothing public is set (nothing-set default)', async () => {
        // `lib/constants`: process.env.API_URL || 'http://localhost:3100', + '/api'.
        const { url, base } = await socketUrlFor({ apiUrlConstant: 'http://localhost:3100/api' });
        expect(base).toBe('http://localhost:3100/api');
        expect(url).toBe(`ws://localhost:3100${WS_PATH}`);
    });

    it('keeps the API_URL origin for the .env.example default', async () => {
        // apps/web/.env.example — API_URL=http://localhost:3100.
        const { url } = await socketUrlFor({ apiUrlConstant: 'http://localhost:3100/api' });
        expect(url).toBe(`ws://localhost:3100${WS_PATH}`);
    });

    it('keeps a browser-reachable API_URL untouched when NEXT_PUBLIC_API_URL is unset', async () => {
        // The constraint that matters most: a single-origin install where
        // API_URL is already the public host must not be narrowed.
        const { url } = await socketUrlFor({ apiUrlConstant: 'https://api.ever.works/api' });
        expect(url).toBe(`wss://api.ever.works${WS_PATH}`);
    });

    it('prefers the public origin over an in-cluster API_URL (k8s web Deployment)', async () => {
        // .deploy/k8s/k8s-manifest.prod.yaml — API_URL: http://ever-works-api:3100,
        // reachable only inside the cluster; the public API is its own ingress.
        const { url } = await socketUrlFor({
            apiUrlConstant: 'http://ever-works-api:3100/api',
            publicApiUrl: 'https://api.ever.works',
        });
        expect(url).toBe(`wss://api.ever.works${WS_PATH}`);
    });

    it('prefers the published host port over the compose service name', async () => {
        // docker-compose.yml — API_URL: http://ever-works-api:3100 on the
        // compose network, published to the host as localhost:3100.
        const { url } = await socketUrlFor({
            apiUrlConstant: 'http://ever-works-api:3100/api',
            publicApiUrl: 'http://localhost:3100',
        });
        expect(url).toBe(`ws://localhost:3100${WS_PATH}`);
    });

    it('strips the trailing /api the e2e workflow sets on NEXT_PUBLIC_API_URL', async () => {
        // .github/workflows/e2e.yml — API_URL: http://127.0.0.1:3100 and
        // NEXT_PUBLIC_API_URL: http://127.0.0.1:3100/api. Both reachable; the
        // public one wins and its /api suffix must not reach the gateway path.
        const { url } = await socketUrlFor({
            apiUrlConstant: 'http://127.0.0.1:3100/api',
            publicApiUrl: 'http://127.0.0.1:3100/api',
        });
        expect(url).toBe(`ws://127.0.0.1:3100${WS_PATH}`);
    });

    it('tolerates a trailing slash and an empty public value', async () => {
        expect(
            (
                await socketUrlFor({
                    apiUrlConstant: 'http://ever-works-api:3100/api',
                    publicApiUrl: 'https://api.ever.works/api/',
                })
            ).url,
        ).toBe(`wss://api.ever.works${WS_PATH}`);

        // An empty value is not a configured override — fall back, don't
        // mint a schemeless URL.
        expect(
            (
                await socketUrlFor({
                    apiUrlConstant: 'http://ever-works-api:3100/api',
                    publicApiUrl: '',
                })
            ).url,
        ).toBe(`ws://ever-works-api:3100${WS_PATH}`);
    });

    it('normalises a wsPath that arrives without its leading slash', async () => {
        vi.resetModules();
        vi.doMock('@/lib/constants', () => ({ API_URL: 'http://localhost:3100/api' }));
        delete process.env.NEXT_PUBLIC_API_URL;
        const { toAttachSocketUrl } = await import('./attach-socket-origin');
        expect(toAttachSocketUrl('ws/computer/abc')).toBe('ws://localhost:3100/ws/computer/abc');
    });
});
