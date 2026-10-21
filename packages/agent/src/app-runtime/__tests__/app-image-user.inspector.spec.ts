import {
    RegistryAppImageUserInspector,
    judgeImageUser,
    matchingCredential,
    platformManifestDigest,
    trustedRealm,
} from '../app-image-user.inspector';

/**
 * App Works follow-up (d), 2026-10-21 — the registry `USER` pre-check.
 *
 * The rule is the kubelet's own (`runAsNonRoot`): root and a user NAME are refused with the rollout
 * classifier's codes, a positive uid passes, a declared `runAsUser` wins. The registry dialogue
 * sends the App's pull credential only to the registry it was issued for, and never refuses on a
 * read it could not complete.
 */

const IMAGE = 'ghcr.io/ever-works/fixture@sha256:' + 'a'.repeat(64);
const CONFIG_DIGEST = 'sha256:' + 'c'.repeat(64);
const AMD64_DIGEST = 'sha256:' + 'd'.repeat(64);
const PULL = { server: 'ghcr.io', username: 'ever-works-bot', password: 'pull-token' };

function judge(user: string, over: { runAsNonRoot?: boolean; runAsUser?: number | null } = {}) {
    return judgeImageUser(user, {
        runAsNonRoot: over.runAsNonRoot ?? true,
        runAsUser: over.runAsUser ?? null,
        component: 'web',
        image: IMAGE,
    });
}

describe('judgeImageUser — the kubelet runAsNonRoot rule', () => {
    it.each([['1000'], ['1000:1000'], ['65532:65532']])(
        'passes a numeric non-root USER %s',
        (user) => {
            expect(judge(user)).toBeNull();
        },
    );

    it.each([[''], ['0'], ['0:0']])('refuses root (USER %j) as managed_root_forbidden', (user) => {
        expect(judge(user)?.code).toBe('managed_root_forbidden');
    });

    it.each([['node'], ['nextjs:nodejs'], ['root']])(
        'refuses a user NAME (%s) as image_user_unverifiable',
        (user) => {
            const verdict = judge(user);
            expect(verdict?.code).toBe('image_user_unverifiable');
            expect(verdict?.message).toContain('USER 1000:1000');
        },
    );

    it('lets a declared numeric runAsUser win over the image', () => {
        expect(judge('node', { runAsUser: 1000 })).toBeNull();
        expect(judge('', { runAsUser: 1000 })).toBeNull();
        expect(judge('1000', { runAsUser: 0 })?.code).toBe('managed_root_forbidden');
    });

    it('refuses nothing when the target allows root (no runAsNonRoot)', () => {
        expect(judge('', { runAsNonRoot: false })).toBeNull();
        expect(judge('node', { runAsNonRoot: false })).toBeNull();
    });
});

describe('the credential only ever reaches its own registry', () => {
    it('matches the pull credential to its registry, and to nothing else', () => {
        expect(matchingCredential(PULL, 'ghcr.io', 'ghcr.io')).toBe(
            Buffer.from('ever-works-bot:pull-token').toString('base64'),
        );
        expect(matchingCredential(PULL, 'quay.io', 'quay.io')).toBeNull();
        expect(
            matchingCredential({ ...PULL, server: 'https://ghcr.io/' }, 'ghcr.io', 'ghcr.io'),
        ).not.toBeNull();
        expect(matchingCredential(null, 'ghcr.io', 'ghcr.io')).toBeNull();
        expect(matchingCredential({ ...PULL, password: '' }, 'ghcr.io', 'ghcr.io')).toBeNull();
    });

    it('trusts a token realm on the registry itself or Docker Hub auth, never a named third host', () => {
        expect(trustedRealm('https://ghcr.io/token', 'ghcr.io', 'ghcr.io')).toBe(true);
        expect(
            trustedRealm('https://auth.docker.io/token', 'docker.io', 'registry-1.docker.io'),
        ).toBe(true);
        expect(trustedRealm('https://evil.example/token', 'ghcr.io', 'ghcr.io')).toBe(false);
        expect(trustedRealm('not a url', 'ghcr.io', 'ghcr.io')).toBe(false);
    });
});

describe('platformManifestDigest', () => {
    it('picks linux/amd64 from an index, skipping attestations', () => {
        expect(
            platformManifestDigest({
                manifests: [
                    {
                        digest: 'sha256:' + 'e'.repeat(64),
                        platform: { os: 'unknown', architecture: 'unknown' },
                    },
                    {
                        digest: 'sha256:' + 'f'.repeat(64),
                        platform: { os: 'linux', architecture: 'arm64' },
                    },
                    { digest: AMD64_DIGEST, platform: { os: 'linux', architecture: 'amd64' } },
                ],
            }),
        ).toBe(AMD64_DIGEST);
    });

    it('answers null for a plain manifest', () => {
        expect(platformManifestDigest({ config: { digest: CONFIG_DIGEST } })).toBeNull();
    });
});

describe('RegistryAppImageUserInspector.readUser — the GHCR dialogue', () => {
    function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
        return {
            status,
            ok: status >= 200 && status < 300,
            headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
            text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        };
    }

    it('answers the Bearer challenge with the pull credential, follows the index and reads config.User', async () => {
        const calls: Array<{ url: string; auth: string | null }> = [];
        const fetchImpl = jest.fn(async (url: string, init?: Record<string, unknown>) => {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            calls.push({ url, auth: headers.Authorization ?? null });
            if (url.startsWith('https://ghcr.io/token')) {
                return answer(200, { token: 'registry-token' });
            }
            if (!headers.Authorization) {
                return answer(
                    401,
                    {},
                    {
                        'www-authenticate':
                            'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:ever-works/fixture:pull"',
                    },
                );
            }
            if (url.includes(`/manifests/sha256:${'a'.repeat(64)}`)) {
                return answer(200, {
                    manifests: [
                        { digest: AMD64_DIGEST, platform: { os: 'linux', architecture: 'amd64' } },
                    ],
                });
            }
            if (url.includes(`/manifests/${AMD64_DIGEST}`)) {
                return answer(200, { config: { digest: CONFIG_DIGEST } });
            }
            if (url.includes(`/blobs/${CONFIG_DIGEST}`)) {
                return answer(200, { config: { User: '1000:1000' } });
            }
            return answer(404, {});
        });
        const inspector = new RegistryAppImageUserInspector(fetchImpl as never);

        const read = await inspector.readUser({ reference: IMAGE, pull: PULL });

        expect(read).toEqual({ status: 'read', user: '1000:1000' });
        const tokenCall = calls.find((call) => call.url.startsWith('https://ghcr.io/token'));
        expect(tokenCall?.auth).toBe(
            `Basic ${Buffer.from('ever-works-bot:pull-token').toString('base64')}`,
        );
        // Every registry call after the challenge carries the token, never the raw credential.
        expect(
            calls
                .filter((call) => call.url.includes('/v2/') && call.auth)
                .every((call) => call.auth === 'Bearer registry-token'),
        ).toBe(true);
    });

    it('is `unavailable` (never a refusal) when the registry cannot be read', async () => {
        const inspector = new RegistryAppImageUserInspector(
            jest.fn(async () => {
                throw new Error('ECONNREFUSED');
            }) as never,
        );

        const read = await inspector.readUser({ reference: IMAGE, pull: PULL });

        expect(read.status).toBe('unavailable');
    });

    it('is `unavailable` for a reference it cannot parse', async () => {
        const inspector = new RegistryAppImageUserInspector(jest.fn() as never);

        expect((await inspector.readUser({ reference: 'not a ref' })).status).toBe('unavailable');
    });
});
