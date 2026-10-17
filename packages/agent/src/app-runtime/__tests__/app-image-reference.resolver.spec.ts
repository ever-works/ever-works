/**
 * APW-06 T72 / T35 — `RegistryAppImageReferenceResolver` (plan §5.8, ACC-06-52, ACC-06-53).
 *
 * Digest existence, tag resolution recorded as `resolvedFromTag`, the anonymous-token retry,
 * and one case per registry answer. The registry is a hand-written fake `fetch`; nothing here
 * touches a network.
 */

import {
    RegistryAppImageReferenceResolver,
    parseBearerChallenge,
    parseImageReference,
} from '../app-image-reference.resolver';

const DIGEST = `sha256:${'a'.repeat(64)}`;

type Answer = { status: number; headers?: Record<string, string>; body?: unknown };

function fakeFetch(answers: Answer[]) {
    const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
    const fetchImpl = async (url: string, init?: Record<string, unknown>) => {
        calls.push({ url, init });
        const next = answers.shift() ?? { status: 500 };
        const headers = Object.fromEntries(
            Object.entries(next.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
        );
        return {
            status: next.status,
            ok: next.status >= 200 && next.status < 300,
            headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
            json: async () => next.body,
        };
    };
    return { fetchImpl, calls };
}

const request = (reference: string) => ({ workId: 'w-1', reference, specCommitSha: 'abc' });

describe('parseImageReference', () => {
    it('reads Docker Hub short names, registries with ports, tags and digests', () => {
        expect(parseImageReference('nginx')).toMatchObject({
            registry: 'docker.io',
            repository: 'library/nginx',
            tag: null,
            name: 'nginx',
        });
        expect(parseImageReference('ghcr.io/acme/app/ever-works-app:1.2')).toMatchObject({
            registry: 'ghcr.io',
            repository: 'acme/app/ever-works-app',
            tag: '1.2',
        });
        expect(parseImageReference(`localhost:5000/team/api@${DIGEST}`)).toMatchObject({
            registry: 'localhost:5000',
            repository: 'team/api',
            digest: DIGEST,
            tag: null,
        });
    });

    it('refuses what is not a reference', () => {
        expect(parseImageReference('')).toBeNull();
        expect(parseImageReference('https://ghcr.io/x')).toBeNull();
        expect(parseImageReference('Upper/Case')).toBeNull();
        expect(parseImageReference('nginx@sha256:short')).toBeNull();
    });
});

describe('parseBearerChallenge', () => {
    it('reads realm, service and scope; refuses a non-https realm', () => {
        expect(
            parseBearerChallenge(
                'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"',
            ),
        ).toEqual({
            realm: 'https://ghcr.io/token',
            service: 'ghcr.io',
            scope: 'repository:a/b:pull',
        });
        expect(parseBearerChallenge('Bearer realm="http://x/token"')).toBeNull();
        expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
        // A multi-action scope keeps its first action; a hostile header is bounded, not scanned.
        expect(
            parseBearerChallenge('Bearer realm="https://r/t",scope="repository:a/b:pull,push"')
                ?.scope,
        ).toBe('repository:a/b:pull');
        expect(parseBearerChallenge(`Bearer ${'0'.repeat(100_000)}`)).toBeNull();
    });
});

describe('RegistryAppImageReferenceResolver', () => {
    it('resolves a tag to a digest once and records resolvedFromTag', async () => {
        const { fetchImpl, calls } = fakeFetch([
            { status: 200, headers: { 'Docker-Content-Digest': DIGEST } },
        ]);
        const result = await new RegistryAppImageReferenceResolver(fetchImpl).resolve(
            request('ghcr.io/acme/app:latest'),
        );

        expect(result).toEqual({
            status: 'resolved',
            reference: `ghcr.io/acme/app@${DIGEST}`,
            digest: DIGEST,
            resolvedFromTag: true,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://ghcr.io/v2/acme/app/manifests/latest');
        expect(calls[0].init?.method).toBe('HEAD');
    });

    it('checks a digest exists and does not call it resolved-from-tag', async () => {
        const { fetchImpl } = fakeFetch([{ status: 200, headers: {} }]);
        const result = await new RegistryAppImageReferenceResolver(fetchImpl).resolve(
            request(`nginx@${DIGEST}`),
        );

        expect(result).toMatchObject({
            status: 'resolved',
            digest: DIGEST,
            resolvedFromTag: false,
        });
    });

    it('answers a 401 challenge with ONE anonymous token request, then retries with it', async () => {
        const { fetchImpl, calls } = fakeFetch([
            {
                status: 401,
                headers: {
                    'WWW-Authenticate':
                        'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
                },
            },
            { status: 200, body: { token: 'anon-token' } },
            { status: 200, headers: { 'Docker-Content-Digest': DIGEST } },
        ]);
        const result = await new RegistryAppImageReferenceResolver(fetchImpl).resolve(
            request('nginx:1.27'),
        );

        expect(result).toMatchObject({ status: 'resolved', reference: `nginx@${DIGEST}` });
        expect(calls[0].url).toBe('https://registry-1.docker.io/v2/library/nginx/manifests/1.27');
        expect(calls[1].url).toContain('https://auth.docker.io/token?service=registry.docker.io');
        expect((calls[2].init?.headers as Record<string, string>).Authorization).toBe(
            'Bearer anon-token',
        );
    });

    it('maps 404 to image_not_found', async () => {
        const { fetchImpl } = fakeFetch([{ status: 404 }]);
        await expect(
            new RegistryAppImageReferenceResolver(fetchImpl).resolve(
                request('ghcr.io/acme/gone:1'),
            ),
        ).resolves.toMatchObject({ status: 'refused', code: 'image_not_found' });
    });

    it('maps a refused anonymous pull to image_private_unsupported', async () => {
        const { fetchImpl } = fakeFetch([
            {
                status: 401,
                headers: {
                    'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
                },
            },
            { status: 403 },
        ]);
        await expect(
            new RegistryAppImageReferenceResolver(fetchImpl).resolve(
                request('ghcr.io/acme/private:1'),
            ),
        ).resolves.toMatchObject({ status: 'refused', code: 'image_private_unsupported' });
    });

    it('maps a missing digest, a 5xx and a thrown fetch to image_unresolvable', async () => {
        const noDigest = fakeFetch([{ status: 200, headers: {} }]);
        await expect(
            new RegistryAppImageReferenceResolver(noDigest.fetchImpl).resolve(
                request('ghcr.io/a/b:1'),
            ),
        ).resolves.toMatchObject({ code: 'image_unresolvable' });

        const serverError = fakeFetch([{ status: 503 }]);
        await expect(
            new RegistryAppImageReferenceResolver(serverError.fetchImpl).resolve(
                request('ghcr.io/a/b:1'),
            ),
        ).resolves.toMatchObject({ code: 'image_unresolvable' });

        const thrown = new RegistryAppImageReferenceResolver(async () => {
            throw new Error('ECONNRESET');
        });
        await expect(thrown.resolve(request('ghcr.io/a/b:1'))).resolves.toMatchObject({
            code: 'image_unresolvable',
        });

        await expect(
            new RegistryAppImageReferenceResolver(noDigest.fetchImpl).resolve(request('not a ref')),
        ).resolves.toMatchObject({ code: 'image_unresolvable' });
    });
});
