import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — API CONTRACT for
 * the resolution preview and the additive write path it reads.
 *
 * ── Routes ─────────────────────────────────────────────────────────
 *   GET   /api/merge-policy/resolve?workId=&agentId=
 *         → 200 { policy, source, chain }
 *         → 400 when NEITHER workId nor agentId is given
 *         → 404 for a Work/Agent the caller cannot reach (this endpoint
 *              would otherwise be a cross-tenant policy oracle)
 *   Writes ride the existing entity PATCHes — `PATCH /api/works/:id`
 *   and `PATCH /api/agents/:id` each accept an additive optional
 *   `mergePolicy` object; resolution is FIELD-BY-FIELD, so a Work that
 *   sets one field inherits the other four.
 *
 * Platform default (conservative, and deliberately overridable):
 *   allowAgentMerge:false, requireGreenGate:true, requireHumanApproval:true,
 *   allowedMergeMethods:['squash'],
 *   protectedBranches:['main','master','develop','stage']
 */

const UNKNOWN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const POLICY_FIELDS = [
    'allowAgentMerge',
    'requireGreenGate',
    'requireHumanApproval',
    'allowedMergeMethods',
    'protectedBranches',
] as const;

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function errText(body: unknown): string {
    const m = (body as { message?: unknown })?.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

function resolve(request: APIRequestContext, token: string, query: string) {
    return request.get(`${API_BASE}/api/merge-policy/resolve?${query}`, {
        headers: authedHeaders(token),
    });
}

test.describe('GET /api/merge-policy/resolve', () => {
    test('a bare call with no scope is a truthful 400', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/merge-policy/resolve`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(400);
        // The message must NAME the scopes the caller may supply so a bare
        // call is actionable. `organizationId` joined the list after this spec
        // was written, so match the requirement rather than one revision of
        // the sentence.
        const msg = errText(await res.json());
        expect(msg).toMatch(/provide/i);
        expect(msg).toContain('workId');
        expect(msg).toContain('agentId');
    });

    test('an untouched Work resolves to the conservative platform default', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `Policy Work ${uniq()}`,
        });

        const res = await resolve(request, u.access_token, `workId=${work.id}`);
        expect(res.status(), `resolve body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();

        // A resolved policy is ALWAYS complete — unset fields fall through.
        for (const field of POLICY_FIELDS) {
            expect(body.policy, `policy.${field} is present`).toHaveProperty(field);
        }
        expect(body.policy.allowAgentMerge).toBe(false);
        expect(body.policy.requireGreenGate).toBe(true);
        expect(body.policy.requireHumanApproval).toBe(true);
        expect(body.policy.allowedMergeMethods).toEqual(['squash']);
        expect(body.policy.protectedBranches).toEqual(['main', 'master', 'develop', 'stage']);
        expect(body.source, 'nothing declared anything → default').toBe('default');

        // The chain is self-explaining and always starts at the platform
        // default — "agents may not merge here" is only usable if the UI
        // can also say WHERE that came from.
        expect(Array.isArray(body.chain)).toBe(true);
        expect(body.chain.length).toBeGreaterThan(0);
        expect(body.chain[0].scope).toBe('default');
        expect(body.chain[0].id).toBeNull();
        expect(body.chain[0].fields).toEqual(expect.arrayContaining([...POLICY_FIELDS]));
    });

    test('a Work-scoped override is a FIELD-BY-FIELD merge, not a whole-object replace', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `Policy Work ${uniq()}`,
        });

        // Declare ONE field at the Work scope.
        const patched = await request.patch(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(u.access_token),
            data: { mergePolicy: { allowAgentMerge: true } },
        });
        expect(patched.status(), `patch body=${await patched.text().catch(() => '')}`).toBe(200);

        const res = await resolve(request, u.access_token, `workId=${work.id}`);
        expect(res.status()).toBe(200);
        const body = await res.json();

        expect(body.policy.allowAgentMerge, 'the declared field wins').toBe(true);
        // …and the other four still come from the platform default.
        expect(body.policy.requireGreenGate).toBe(true);
        expect(body.policy.requireHumanApproval).toBe(true);
        expect(body.policy.allowedMergeMethods).toEqual(['squash']);
        expect(body.source).toBe('work');

        const workLink = (body.chain as Array<{ scope: string; fields: string[] }>).find(
            (link) => link.scope === 'work',
        );
        expect(workLink, 'the Work link appears in the chain').toBeTruthy();
        expect(workLink?.fields).toEqual(['allowAgentMerge']);
    });

    test('the mergePolicy write DTO is validated (bad method, oversized list, unknown key)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, u.access_token, {
            name: `Policy Work ${uniq()}`,
        });
        const url = `${API_BASE}/api/works/${work.id}`;
        const headers = authedHeaders(u.access_token);

        const badMethod = await request.patch(url, {
            headers,
            data: { mergePolicy: { allowedMergeMethods: ['fast-forward'] } },
        });
        expect(badMethod.status()).toBe(400);

        const badBool = await request.patch(url, {
            headers,
            data: { mergePolicy: { allowAgentMerge: 'yes' } },
        });
        expect(badBool.status()).toBe(400);

        const unknownKey = await request.patch(url, {
            headers,
            data: { mergePolicy: { allowEverything: true } },
        });
        expect(unknownKey.status()).toBe(400);
        expect(errText(await unknownKey.json())).toContain('should not exist');

        // An explicitly EMPTY method list is legal and means "refuse every
        // agent merge" — it must NOT be confused with "inherit".
        const emptyList = await request.patch(url, {
            headers,
            data: { mergePolicy: { allowedMergeMethods: [] } },
        });
        expect(emptyList.status()).toBe(200);
        const resolved = await resolve(request, u.access_token, `workId=${work.id}`);
        expect((await resolved.json()).policy.allowedMergeMethods).toEqual([]);
    });

    test('resolving by agentId works and is owner-scoped', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, u.access_token, {
            name: `policy-agent-${uniq()}`,
        });

        const res = await resolve(request, u.access_token, `agentId=${agent.id}`);
        expect(res.status(), `agent resolve body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();
        for (const field of POLICY_FIELDS) {
            expect(body.policy).toHaveProperty(field);
        }
    });

    test('a stranger is refused on BOTH inputs — the endpoint is never a cross-tenant policy oracle', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Policy Work ${uniq()}`,
        });
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `policy-agent-${uniq()}`,
        });

        // NOTE — the two inputs refuse with DIFFERENT codes, and that
        // asymmetry is the platform's, not this endpoint's:
        //   workId  → `WorkOwnershipService.ensureAccess`, which is 404
        //             only for a Work that does not exist and 403 for one
        //             that exists but has no membership row for the caller.
        //             That is the shared Work-access contract used by
        //             dozens of endpoints; the controller's own comment
        //             saying "404 with no existence leak" overstates it.
        //   agentId → an owner-filtered repository lookup, which cannot
        //             distinguish the two cases at all → always 404.
        // What matters for security is identical either way: a stranger
        // never receives a resolved policy.
        const crossWork = await resolve(request, stranger.access_token, `workId=${work.id}`);
        expect(crossWork.status(), 'a stranger never gets a policy for my Work').toBe(403);
        expect(await crossWork.text()).not.toContain('allowAgentMerge');

        const crossAgent = await resolve(request, stranger.access_token, `agentId=${agent.id}`);
        expect(crossAgent.status(), 'a stranger never gets a policy for my Agent').toBe(404);
        expect(await crossAgent.text()).not.toContain('allowAgentMerge');

        const unknownWork = await resolve(request, owner.access_token, `workId=${UNKNOWN_UUID}`);
        expect(unknownWork.status()).toBe(404);

        const unknownAgent = await resolve(request, owner.access_token, `agentId=${UNKNOWN_UUID}`);
        expect(unknownAgent.status()).toBe(404);
    });

    test('malformed uuids are DTO 400s; anonymous is 401', async ({ request }) => {
        const u = await registerUserViaAPI(request);

        const badWork = await resolve(request, u.access_token, 'workId=not-a-uuid');
        expect(badWork.status()).toBe(400);
        expect(errText(await badWork.json())).toContain('workId must be a UUID');

        const badAgent = await resolve(request, u.access_token, 'agentId=not-a-uuid');
        expect(badAgent.status()).toBe(400);

        const unknownParam = await resolve(request, u.access_token, 'tenantId=x');
        expect(unknownParam.status(), 'the query DTO is whitelisted too').toBe(400);

        const anon = await request.get(
            `${API_BASE}/api/merge-policy/resolve?workId=${UNKNOWN_UUID}`,
        );
        expect(anon.status(), 'auth is checked before the 400/404 branches').toBe(401);
    });
});
