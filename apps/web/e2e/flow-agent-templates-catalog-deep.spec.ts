import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';

/**
 * Agent-template CATALOG — deep public/contract coverage + the
 * instantiate-into-a-DRAFT-agent path with the D9 permission clamp.
 *
 * Sources of truth read for this spec (live-probed against the e2e stack —
 * sqlite in-memory, REQUIRE_EMAIL_VERIFICATION=false, NO GitHub token, fake
 * GITHUB_APP_ID=999999, keyless):
 *   - apps/api/src/agents/agent-templates.controller.ts
 *       GET /api/agent-templates?entity=agent|skill|task, @Public(), HttpCode 200.
 *       `entity` coerced: anything that isn't EXACTLY 'skill'|'task' → 'agent'.
 *   - apps/api/src/agents/agent-template-catalog.service.ts
 *       Repo-backed (private ever-works/agents manifest). list(entity): returns []
 *       for entity!=='agent'; for 'agent', returns [] when no token resolves (the
 *       keyless CI case). Never throws — every failure path returns [].
 *   - apps/api/src/agents/agents.controller.ts (export/import — the clone engine).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NON-DUPLICATION — flow-agent-templates-clone.spec.ts already covers (do NOT
 * repeat here):
 *   • one combined "catalog publicly readable for every entity type" test (anon
 *     GET, skill+task=[], unknown→agent normalization, no-query default, the
 *     populated-entry shape guard);
 *   • the full export→import clone round-trip (files/avatar/runtime knobs copy,
 *     the -2/-3 rename ladder, clone independence);
 *   • conflict modes rename/skip/overwrite;
 *   • avatar image→initials degrade;
 *   • cross-user export 404 / unauth 401 / bad-envelope 400 / handed-off clone.
 *
 * THIS spec deepens the THIN edges that file leaves untouched, with finer-grained
 * PROBED contracts:
 *   • HTTP-method allowlist on /api/agent-templates (GET/HEAD only; write verbs 404).
 *   • @Public semantics: a garbage/expired bearer is IGNORED (still 200), and the
 *     CORS preflight (OPTIONS) is 204 — the catalog is consumed by browsers/SSR.
 *   • `entity` normalization is CASE-SENSITIVE ('AGENT','Skill' → agent) and
 *     tolerates empty + repeated (array) query params — never a 400/500.
 *   • Response is always a JSON array with the documented Content-Type, and is
 *     STABLE across repeated calls (1h cache / idempotent fallback).
 *   • catalog-id RESOLUTION error matrix on the instantiate target: malformed id
 *     → 400 "Validation failed (uuid is expected)"; well-formed-but-missing id
 *     → 404 (no existence leak); no `:slug` sub-route on the catalog controller.
 *   • Instantiate-a-template-into-a-user's-Agent CONTRAST: direct create HONORS
 *     granted permissions, but instantiate-via-envelope CLAMPS the clone to the
 *     all-false least-privilege matrix (D9, #1258) — asserted on ALL 8 flags —
 *     and the clone always lands in status DRAFT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Isolation: every mutation runs on its OWN freshly registered user; unique
 * suffixes come from the per-test counter `nextSuffix()` (never a module-scope
 * clock). No module-scope awaits / no module-scope loadSeededTestUser().
 */

const CATALOG_PATH = `${API_BASE}/api/agent-templates`;

/** The full AGENT_PERMISSIONS_DEFAULT key set (agent.entity.ts) — 8 flags. */
const PERMISSION_KEYS = [
    'canCreateAgents',
    'canAssignTasks',
    'canEditSkills',
    'canEditAgentFiles',
    'canSpend',
    'canCommitToRepo',
    'canOpenPullRequests',
    'canCallExternalTools',
] as const;

interface AstTemplateEntry {
    slug: string;
    title: string;
    description: string;
    category?: string;
    iconName?: string;
    tags?: string[];
}

interface AgentDto {
    id: string;
    name: string;
    slug: string;
    scope: string;
    status: string;
    permissions: Record<string, boolean>;
}

interface AgentExportEnvelope {
    version: number;
    identity: { name: string; slug: string; title: string | null; scope: string };
    runtime: { permissions: Record<string, boolean> };
    [k: string]: unknown;
}

interface ImportResult {
    created: AgentDto;
    conflictResolution: 'none' | 'skipped' | 'overwritten' | 'renamed';
    originalSlug: string;
    finalSlug: string;
}

// Per-test counter → deterministic unique suffixes WITHOUT a module-scope clock.
let SUFFIX_SEQ = 0;
function nextSuffix(): string {
    SUFFIX_SEQ += 1;
    return `${SUFFIX_SEQ.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

async function freshToken(
    request: APIRequestContext,
): Promise<{ user: RegisteredUser; token: string }> {
    const user = await registerUserViaAPI(request);
    return { user, token: user.access_token };
}

async function createAgent(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<AgentDto> {
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', ...body },
    });
    expect(res.status(), `create body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function exportAgent(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<AgentExportEnvelope> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/export`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `export body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('Agent-template catalog — HTTP surface + @Public semantics (deep)', () => {
    /**
     * The catalog controller registers ONLY a GET handler. Every write verb must
     * 404 (no route), proving there is no hidden mutation surface on a route that
     * is intentionally public + unauthenticated. HEAD mirrors GET (200).
     */
    test('only GET/HEAD are routed; POST/PUT/DELETE on the catalog are 404', async ({
        request,
    }) => {
        const get = await request.get(`${CATALOG_PATH}?entity=agent`);
        expect(get.status()).toBe(200);

        const head = await request.head(`${CATALOG_PATH}?entity=agent`);
        expect(head.status()).toBe(200);

        for (const verb of ['post', 'put', 'delete'] as const) {
            const res = await request[verb](CATALOG_PATH, { data: {} });
            expect(res.status(), `${verb} should be unrouted`).toBe(404);
        }
    });

    /**
     * @Public() means the auth guard is skipped entirely — a malformed/expired
     * bearer must be IGNORED, not rejected. A 401 here would prove the route
     * isn't actually public. (The clone spec asserts the anon path; this asserts
     * the "garbage credential is harmless" path, which is distinct.)
     */
    test('a garbage bearer token is ignored — the public catalog still 200s', async ({
        request,
    }) => {
        const res = await request.get(`${CATALOG_PATH}?entity=agent`, {
            headers: { Authorization: 'Bearer not.a.real.jwt.value' },
        });
        expect(res.status()).toBe(200);
        expect(Array.isArray(await res.json())).toBe(true);
    });

    /**
     * The catalog is fetched by the web app (SSR + potentially the browser), so
     * the CORS preflight must succeed. Probed: OPTIONS → 204.
     */
    test('CORS preflight (OPTIONS) on the catalog returns 204', async ({ request }) => {
        const res = await request.fetch(CATALOG_PATH, { method: 'OPTIONS' });
        expect(res.status()).toBe(204);
    });

    /**
     * Content-type contract: a successful list is a JSON array served as
     * application/json. The web fallback depends on parsing JSON, never HTML.
     */
    test('catalog responds with a JSON array and application/json content-type', async ({
        request,
    }) => {
        const res = await request.get(`${CATALOG_PATH}?entity=agent`);
        expect(res.status()).toBe(200);
        expect(res.headers()['content-type'] ?? '').toContain('application/json');
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
    });

    /**
     * The catalog surfaces strings sourced from an EXTERNAL repo manifest, so the
     * API must ship the anti-MIME-sniffing defense header. Probed: the response
     * carries `X-Content-Type-Options: nosniff` (a defense-in-depth contract that
     * complements the service-side HTML stripping in the catalog mapper).
     */
    test('catalog response carries the X-Content-Type-Options: nosniff hardening header', async ({
        request,
    }) => {
        const res = await request.get(`${CATALOG_PATH}?entity=agent`);
        expect(res.status()).toBe(200);
        expect(res.headers()['x-content-type-options']).toBe('nosniff');
    });
});

test.describe('Agent-template catalog — entity normalization edge cases (deep)', () => {
    /**
     * The controller coerces `entity` with an EXACT match: only the lowercase
     * literals 'skill' and 'task' are honored; anything else (including a
     * capitalized 'AGENT'/'Skill'/'TASK') normalizes to 'agent'. The clone spec
     * only checks lowercase skill/task and a single 'banana'; this pins the
     * case-sensitivity boundary explicitly.
     */
    test('entity matching is case-sensitive — capitalized variants normalize to agent', async ({
        request,
    }) => {
        const agentRes = await request.get(`${CATALOG_PATH}?entity=agent`);
        expect(agentRes.status()).toBe(200);
        const agentLen = ((await agentRes.json()) as AstTemplateEntry[]).length;

        // Capitalized — NOT an exact match for 'skill'/'task' → coerced to 'agent'.
        for (const entity of ['AGENT', 'Skill', 'TASK', 'Agent']) {
            const res = await request.get(`${CATALOG_PATH}?entity=${entity}`);
            expect(res.status(), `entity=${entity}`).toBe(200);
            const list = (await res.json()) as AstTemplateEntry[];
            expect(Array.isArray(list)).toBe(true);
            // Same result as the canonical agent list (they all collapse to agent).
            expect(list.length).toBe(agentLen);
        }
    });

    /**
     * Degenerate query params must never 4xx/5xx: an empty `entity=` and a
     * repeated `entity=skill&entity=task` (array binding) both fall through the
     * coercion to a valid list. Probed: both 200 + array.
     */
    test('empty and repeated entity params are tolerated (no 400/500)', async ({ request }) => {
        const empty = await request.get(`${CATALOG_PATH}?entity=`);
        expect(empty.status()).toBe(200);
        expect(Array.isArray(await empty.json())).toBe(true);

        const repeated = await request.get(`${CATALOG_PATH}?entity=skill&entity=task`);
        expect(repeated.status()).toBe(200);
        expect(Array.isArray(await repeated.json())).toBe(true);

        // A long junk value also coerces to agent rather than erroring.
        const junk = await request.get(`${CATALOG_PATH}?entity=${'x'.repeat(200)}`);
        expect(junk.status()).toBe(200);
        expect(Array.isArray(await junk.json())).toBe(true);
    });

    /**
     * skill + task are NEVER repo-backed (the service short-circuits to [] for
     * entity!=='agent'), so they are EXACTLY an empty array regardless of token
     * availability — a stable contract worth pinning on its own.
     */
    test('skill and task catalogs are always exactly empty arrays', async ({ request }) => {
        for (const entity of ['skill', 'task']) {
            const res = await request.get(`${CATALOG_PATH}?entity=${entity}`);
            expect(res.status()).toBe(200);
            const list = (await res.json()) as AstTemplateEntry[];
            expect(list).toEqual([]);
        }
    });

    /**
     * Repeated calls return the SAME array (1h cache when populated; idempotent
     * empty fallback when keyless). Either way the catalog is stable, never
     * flickering between shapes — important because the web layer caches it.
     * If/when a token is present the entry shape is asserted (skipped in CI).
     */
    test('catalog is stable across repeated reads and entries are well-shaped when present', async ({
        request,
    }) => {
        const first = (await (
            await request.get(`${CATALOG_PATH}?entity=agent`)
        ).json()) as AstTemplateEntry[];
        const second = (await (
            await request.get(`${CATALOG_PATH}?entity=agent`)
        ).json()) as AstTemplateEntry[];
        expect(second.length).toBe(first.length);
        expect(second.map((e) => e.slug)).toEqual(first.map((e) => e.slug));

        if (first.length > 0) {
            for (const entry of first) {
                expect(typeof entry.slug).toBe('string');
                expect(entry.slug.length).toBeGreaterThan(0);
                expect(typeof entry.title).toBe('string');
                expect(typeof entry.description).toBe('string');
                if (entry.tags !== undefined) expect(Array.isArray(entry.tags)).toBe(true);
                if (entry.category !== undefined) expect(typeof entry.category).toBe('string');
                if (entry.iconName !== undefined) expect(typeof entry.iconName).toBe('string');
            }
        } else {
            test.info().annotations.push({
                type: 'note',
                description:
                    'agent catalog empty (keyless e2e: no GitHub token / fake GITHUB_APP_ID) — repo-backed entry shape not asserted; expected fallback contract.',
            });
        }
    });
});

test.describe('Agent-template catalog-id resolution — error matrix (deep)', () => {
    /**
     * "Instantiate a template" resolves a catalog id against the agent export/
     * import surface. The id-resolution error matrix is sharply different by
     * shape: a syntactically invalid id is rejected by the UUID pipe BEFORE any
     * lookup (400 with a precise message), while a syntactically valid but
     * non-existent id reaches the repo and 404s WITHOUT leaking existence.
     */
    test('malformed id → 400 uuid-validation; well-formed-missing id → 404 (no leak)', async ({
        request,
    }) => {
        const { token } = await freshToken(request);

        const malformed = await request.get(`${API_BASE}/api/agents/not-a-real-id/export`, {
            headers: authedHeaders(token),
        });
        expect(malformed.status()).toBe(400);
        expect((await malformed.json()).message ?? '').toContain('uuid is expected');

        const missing = await request.get(
            `${API_BASE}/api/agents/00000000-0000-4000-8000-000000000000/export`,
            { headers: authedHeaders(token) },
        );
        expect(missing.status()).toBe(404);
    });

    /**
     * The catalog controller exposes ONLY the list route — there is no
     * `GET /api/agent-templates/:slug` single-template endpoint, so a slug path
     * 404s. This pins the absence of a per-template resolution route (the web
     * app resolves a chosen template client-side from the already-fetched list).
     */
    test('there is no per-slug catalog route — /api/agent-templates/:slug is 404', async ({
        request,
    }) => {
        const anon = await request.get(`${CATALOG_PATH}/content-strategist`);
        expect(anon.status()).toBe(404);

        const { token } = await freshToken(request);
        const authed = await request.get(`${CATALOG_PATH}/content-strategist`, {
            headers: authedHeaders(token),
        });
        expect(authed.status()).toBe(404);
    });
});

test.describe('Instantiate a template into a DRAFT agent — D9 permission clamp (deep)', () => {
    /**
     * The clone spec asserts the clamp on a richly-configured agent with three
     * specific grants. THIS test isolates the CONTRAST that makes the clamp
     * meaningful: direct create HONORS every granted permission, but
     * instantiate-via-envelope (the clone path a template instantiation uses)
     * CLAMPS the result to the all-false least-privilege matrix across ALL 8
     * flags — and the instantiated agent is always a DRAFT. Probed end to end.
     */
    test('create honors granted permissions; instantiate clamps ALL 8 flags to false and lands DRAFT', async ({
        request,
    }) => {
        const { token } = await freshToken(request);

        // Grant EVERY permission on the source so the clamp is unambiguous.
        const allGranted: Record<string, boolean> = {};
        for (const key of PERMISSION_KEYS) allGranted[key] = true;

        const source = await createAgent(request, token, {
            name: `TplSrc ${nextSuffix()}`,
            permissions: allGranted,
        });
        // Direct create HONORS the grants (sanity baseline for the contrast).
        expect(source.status).toBe('draft');
        for (const key of PERMISSION_KEYS) {
            expect(source.permissions[key], `create should honor ${key}`).toBe(true);
        }

        // The envelope is the instantiation payload; it CARRIES the grants…
        const envelope = await exportAgent(request, token, source.id);
        expect(envelope.version).toBe(1);
        for (const key of PERMISSION_KEYS) {
            expect(envelope.runtime.permissions[key], `envelope carries ${key}`).toBe(true);
        }

        // …but instantiating (import) CLAMPS to least-privilege (D9, #1258).
        const res = await request.post(`${API_BASE}/api/agents/import`, {
            headers: authedHeaders(token),
            data: envelope,
        });
        expect(res.status(), `import body=${await res.text().catch(() => '')}`).toBe(201);
        const result = (await res.json()) as ImportResult;

        const clone = result.created;
        expect(clone.status).toBe('draft');
        expect(clone.id).not.toBe(source.id);
        // The headline assertion: every one of the 8 flags is false on the clone.
        for (const key of PERMISSION_KEYS) {
            expect(clone.permissions[key], `clone must clamp ${key} to false`).toBe(false);
        }
    });

    /**
     * Instantiating the same source again yields ANOTHER independent DRAFT clone
     * (the rename ladder continues), and that second clone is ALSO clamped — the
     * clamp is applied per-import, not cached/leaked from the first. This pins
     * that the least-privilege guarantee holds for every instantiation, not just
     * the first one off a given envelope.
     */
    test('re-instantiating the same template produces another clamped DRAFT clone', async ({
        request,
    }) => {
        const { token } = await freshToken(request);
        const source = await createAgent(request, token, {
            name: `TplRe ${nextSuffix()}`,
            permissions: { canSpend: true, canCommitToRepo: true, canCallExternalTools: true },
        });
        const envelope = await exportAgent(request, token, source.id);

        const firstRes = await request.post(`${API_BASE}/api/agents/import`, {
            headers: authedHeaders(token),
            data: envelope,
        });
        expect(firstRes.status()).toBe(201);
        const first = (await firstRes.json()) as ImportResult;
        expect(first.finalSlug).toBe(`${source.slug}-2`);

        const secondRes = await request.post(`${API_BASE}/api/agents/import`, {
            headers: authedHeaders(token),
            data: envelope,
        });
        expect(secondRes.status()).toBe(201);
        const second = (await secondRes.json()) as ImportResult;
        expect(second.finalSlug).toBe(`${source.slug}-3`);
        expect(second.created.id).not.toBe(first.created.id);

        expect(second.created.status).toBe('draft');
        for (const key of PERMISSION_KEYS) {
            expect(second.created.permissions[key], `2nd clone must clamp ${key}`).toBe(false);
        }
    });

    /**
     * Anonymous + cross-user guards on the instantiate (import/export) surface,
     * framed from the template-instantiation angle: instantiating requires auth
     * (unauth import → 401) and a stranger cannot read another user's source to
     * instantiate from it (export 404 — no existence leak). The clone spec hits
     * these inside a larger combined test; isolating them keeps the
     * auth-boundary contract legible on its own.
     */
    test('instantiation requires auth; a stranger cannot read another user’s source to clone', async ({
        request,
    }) => {
        const owner = await freshToken(request);
        const stranger = await freshToken(request);

        const source = await createAgent(request, owner.token, {
            name: `TplGuard ${nextSuffix()}`,
        });
        const envelope = await exportAgent(request, owner.token, source.id);

        // Unauthenticated import (instantiate) → 401.
        const unauth = await request.post(`${API_BASE}/api/agents/import`, { data: envelope });
        expect(unauth.status()).toBe(401);

        // Stranger cannot export (read-to-instantiate) the owner's source → 404.
        const strangerExport = await request.get(`${API_BASE}/api/agents/${source.id}/export`, {
            headers: authedHeaders(stranger.token),
        });
        expect(strangerExport.status()).toBe(404);
    });
});
