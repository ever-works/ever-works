import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-facade-error-mapping — pins the contract of the global
 * `FacadeExceptionFilter` (apps/api/src/common/filters/facade-exception.filter.ts).
 *
 * The `@ever-works/agent` facades (git / deploy / oauth / content-extractor)
 * throw `FacadeError` subclasses — plain `Error`s, NOT NestJS HttpExceptions.
 * Before this filter, any such error that reached a controller UNCAUGHT became
 * a generic HTTP 500 ("the git-gate signature"). The filter now maps the
 * caller-actionable leaves to the correct 4xx:
 *   - NoGitProviderError / NoGitCredentialsError / No*ProviderError → 409
 *   - *ProviderNotFoundError                                        → 404
 *   - OAuthNotSupportedError                                        → 400
 * while generic facade wrappers stay 500 with NO internal-message leak.
 *
 * The CI driver has NO connected git provider (no GitHub OAuth, no PAT), so any
 * data-repo operation resolves a token and throws `NoGitCredentialsError`. This
 * file pins that as a clean 409 PRECONDITION (error name + envelope shape), the
 * new first-class contract the per-feature specs (collections / taxonomy /
 * comparison / community-pr) now assert as a status only.
 *
 * Every probe registers a FRESH user (isolated, no shared seeded state). Filename
 * uses the safe `flow-` prefix. TS strict.
 */

let counter = 0;
function uniq(): string {
    counter += 1;
    return `${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

interface FacadeEnvelope {
    statusCode?: number;
    message?: unknown;
    error?: string;
    status?: string;
}

async function freshWork(request: APIRequestContext): Promise<{ token: string; workId: string }> {
    const u = await registerUserViaAPI(request);
    const s = uniq();
    const { id } = await createWorkViaAPI(request, u.access_token, {
        name: `Facade ${s}`,
        slug: `facade-${s}`,
    });
    return { token: u.access_token, workId: id };
}

test.describe('FacadeExceptionFilter — git-not-connected maps to a clean 409 precondition', () => {
    test('a git-gated taxonomy write on a non-connected work → 409 NoGitCredentialsError (not a 500)', async ({
        request,
    }) => {
        const { token, workId } = await freshWork(request);

        const res = await request.post(`${API_BASE}/api/works/${workId}/collections`, {
            headers: authedHeaders(token),
            data: { name: `Collection ${uniq()}` },
        });

        expect(res.status(), 'git-gated write is a 409 precondition, never a 500').toBe(409);
        const body = (await res.json()) as FacadeEnvelope;
        expect(body.statusCode).toBe(409);
        // The filter surfaces the facade's intentional, caller-facing class name
        // + message (this is the SAFE 4xx path; 500s keep the generic body).
        expect(body.error).toBe('NoGitCredentialsError');
        expect(String(body.message)).toMatch(
            /No connected account found for user .* with provider github/i,
        );
        // It is NOT a success envelope and does NOT leak a stack trace.
        expect(body.status).not.toBe('success');
        expect(JSON.stringify(body)).not.toMatch(/\bat \w+.*\(.*\.ts:\d+/); // no stack
    });

    test('community-PR processing on a non-connected work → 409 (was a generic 500)', async ({
        request,
    }) => {
        const { token, workId } = await freshWork(request);

        const enable = await request.patch(`${API_BASE}/api/works/${workId}`, {
            headers: authedHeaders(token),
            data: { communityPrEnabled: true },
        });
        expect(enable.status()).toBe(200);

        // Poll the gate open (findById can lag the PATCH under sqlite), then assert 409.
        let res!: Awaited<ReturnType<typeof request.post>>;
        await expect
            .poll(
                async () => {
                    res = await request.post(
                        `${API_BASE}/api/works/${workId}/process-community-prs`,
                        {
                            headers: authedHeaders(token),
                        },
                    );
                    return res.status();
                },
                { timeout: 20_000 },
            )
            .not.toBe(400);
        expect(res.status(), 'no git provider connected → 409 precondition').toBe(409);
        const body = (await res.json()) as FacadeEnvelope;
        expect(body.error).toBe('NoGitCredentialsError');
    });

    test('DTO validation still precedes the facade filter: an invalid body is 400, not 409', async ({
        request,
    }) => {
        const { token, workId } = await freshWork(request);

        // Unknown property → ValidationPipe 400 BEFORE the service ever reaches git.
        const res = await request.post(`${API_BASE}/api/works/${workId}/collections`, {
            headers: authedHeaders(token),
            data: { name: `OK ${uniq()}`, bogusField: 'nope' },
        });
        expect(res.status(), 'validation fires before the git-gate').toBe(400);
        const body = (await res.json()) as FacadeEnvelope;
        expect(body.statusCode).toBe(400);
        expect(String(body.message)).toMatch(/should not exist/i);
    });

    test('ownership still precedes the facade filter: a ghost work is 404, not 409', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const ghost = '00000000-0000-0000-0000-000000000000';

        const res = await request.post(`${API_BASE}/api/works/${ghost}/collections`, {
            headers: authedHeaders(u.access_token),
            data: { name: `Ghost ${uniq()}` },
        });
        // The work-row lookup (404) precedes the data-repo save (would-be 409).
        expect(res.status(), 'absent work id is a 404 before the git-gate').toBe(404);
    });
});
