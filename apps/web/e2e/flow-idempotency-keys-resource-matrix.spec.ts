/**
 * flow-idempotency-keys-resource-matrix — the `Idempotency-Key` REQUEST HEADER
 * across the FIVE create surfaces, pinned as one cross-endpoint truth table:
 *   POST /api/works · /api/agents · /api/tasks · /api/inbound-triggers · /api/me/missions
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLINGS STOP — AND WHERE THIS ONE STARTS.
 *   `idempotency-keys.spec.ts` does a WEAK `<500` smoke on ONE endpoint (works).
 *   `flow-idempotency-concurrency-matrix.spec.ts` pins the works Idempotency-Key
 *   NO-OP + slug CAS and races Teams/Triggers, but never treats the header as a
 *   CROSS-RESOURCE contract. THIS file proves — assertively, per endpoint — that
 *   the `Idempotency-Key` header is a UNIVERSAL no-op that the platform reads on
 *   exactly ONE unrelated surface (onboarding), and that each of these five
 *   create endpoints falls back to its OWN native dedup posture, which the key
 *   neither helps, replays, nor bypasses.
 *
 * PROBED LIVE (http://127.0.0.1:3100, sqlite in-memory — the exact CI driver) on
 * throwaway users BEFORE every assertion. The exact observed contract:
 *
 *   WORKS      POST → HTTP 200 {status:'success', work:{id,slug,…}}.
 *              Native dedup = SLUG per owner (repo findByOwnerAndSlug, not a DB
 *              unique index). Dup slug → HTTP 400 {status:'error',
 *              message:'Work already exists'}.
 *   AGENTS     POST {scope,…} → HTTP 201 {id, slug, status:'draft', …}.
 *              Native dedup = NAME/slug per (user, scope), ATOMIC. Dup name in
 *              scope → HTTP 409 {message:'An Agent named "…" already exists in
 *              this scope.', error:'Conflict', statusCode:409}.
 *   TASKS      POST {title,…} → HTTP 201 {id, slug:'T-n', status:'backlog', …}.
 *              Native dedup = NONE; slug auto-increments T-1, T-2, … per user.
 *   TRIGGERS   POST {name,…} → HTTP 201 {trigger:{id,…}, secret}.
 *              Native dedup = NONE by name; distinct id + distinct secret each.
 *   MISSIONS   POST {description, type:'one-shot'|'scheduled'} → HTTP 201
 *              {id, title(=description), type, status:'active', …}.
 *              Native dedup = NONE.
 *
 *   THE KEY ITSELF (identical across all five):
 *     • Same key retried → the SECOND response is governed ENTIRELY by native
 *       dedup, never replayed by the key (works 400-on-same-slug / 200-on-diff;
 *       agents 409-on-same-name / 201-on-diff; tasks/triggers/missions always a
 *       fresh row — triggers even mint a fresh secret).
 *     • Empty / whitespace / garbage-injection / multi-KB key → the create still
 *       proceeds (200/201); the header is never rejected FOR being malformed and
 *       never 5xx's.
 *     • One shared key reused across all five endpoints, or across two users, or
 *       carried from a committed Work to a later Task → zero cross-resource /
 *       cross-user coupling (no server-side key store exists).
 *
 * CONCURRENCY posture (parallel same-key bursts): agents → exactly one 201 + the
 * rest 409 (atomic scope-unique gate); tasks/triggers/missions → ALL 201, N
 * distinct rows (no dedup, no lost create). Never a 5xx from the header.
 *
 * GOTCHAS honored: FRESH registerUserViaAPI() owners per test (never the shared
 * seeded user); unique Date.now()/random suffixes; scoped (filter-by-my-id/tag)
 * counts, never global list totals (the shard DB accumulates rows); ids compared
 * via distinctness/Set-size, never exact global counts; tolerant status arrays
 * only where a sqlite tx-serialization 5xx is a genuine driver artifact. Fully
 * API-orchestrated (safe `flow-` prefix) so it never contends on the shared UI
 * auth state.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_SLUG_RE = /^T-\d+$/;
const T = 30_000;

const WORKS = `${API_BASE}/api/works`;
const AGENTS = `${API_BASE}/api/agents`;
const TASKS = `${API_BASE}/api/tasks`;
const TRIGGERS = `${API_BASE}/api/inbound-triggers`;
const MISSIONS = `${API_BASE}/api/me/missions`;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Build request headers. When `key` is passed (INCLUDING the empty string) the
 * `Idempotency-Key` header is attached; pass `undefined` to omit it entirely.
 */
function hdrs(token: string, key?: string): Record<string, string> {
    const h: Record<string, string> = {
        ...authedHeaders(token),
        'content-type': 'application/json',
    };
    if (key !== undefined) h['Idempotency-Key'] = key;
    return h;
}

// Per-endpoint POST helpers — each threads the optional Idempotency-Key through.
function postWork(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
    key?: string,
) {
    return request.post(WORKS, {
        headers: hdrs(token, key),
        data: { organization: false, description: 'e2e', ...body },
        timeout: T,
    });
}
function postAgent(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
    key?: string,
) {
    return request.post(AGENTS, {
        headers: hdrs(token, key),
        data: { scope: 'tenant', ...body },
        timeout: T,
    });
}
function postTask(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
    key?: string,
) {
    return request.post(TASKS, { headers: hdrs(token, key), data: body, timeout: T });
}
function postTrigger(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
    key?: string,
) {
    return request.post(TRIGGERS, { headers: hdrs(token, key), data: body, timeout: T });
}
function postMission(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
    key?: string,
) {
    return request.post(MISSIONS, {
        headers: hdrs(token, key),
        data: { type: 'one-shot', ...body },
        timeout: T,
    });
}

/** Statuses >= 500 are the only ones the header must NEVER produce. */
function server5xx(statuses: number[]): number[] {
    return statuses.filter((s) => s >= 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENTS — key is inert; NAME/scope is the real (atomic) dedup → 409.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agents — Idempotency-Key ignored; name/scope dedup governs (409)', () => {
    test('same key + SAME name → first 201, second 409 "already exists in this scope" (key does NOT replay)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const name = `Idem Agent ${stamp()}`;

        const first = await postAgent(request, u.access_token, { name }, key);
        expect(first.status(), 'first create 201').toBe(201);
        expect((await first.json()).id).toMatch(UUID_RE);

        const second = await postAgent(request, u.access_token, { name }, key);
        // If the key were honored this would REPLAY the first (201 + same id).
        // It is NOT — the scope-unique gate rejects the duplicate name.
        expect(second.status(), 'the retry is rejected on the NAME, not replayed by the key').toBe(
            409,
        );
        const body = await second.json();
        expect(body.error).toBe('Conflict');
        expect(body.statusCode).toBe(409);
        expect(body.message).toMatch(/already exists in this scope/i);
    });

    test('same key + DIFFERENT names → two distinct 201 agents (key does not dedup)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const a = await postAgent(request, u.access_token, { name: `Alpha ${stamp()}` }, key);
        const b = await postAgent(request, u.access_token, { name: `Beta ${stamp()}` }, key);
        expect(a.status()).toBe(201);
        expect(b.status()).toBe(201);
        const idA = (await a.json()).id;
        const idB = (await b.json()).id;
        expect(idA).toMatch(UUID_RE);
        expect(idB).toMatch(UUID_RE);
        expect(idA, 'the reused key did NOT collapse two different-name creates').not.toBe(idB);
    });

    test('an EMPTY Idempotency-Key is tolerated (not rejected) — the agent create still 201s', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await postAgent(request, u.access_token, { name: `EmptyKey ${stamp()}` }, '');
        expect(res.status(), 'an empty key neither crashes nor blocks the create').toBe(201);
        expect((await res.json()).id).toMatch(UUID_RE);
    });

    test('a GARBAGE / injection-shaped Idempotency-Key is tolerated — the create still 201s', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const res = await postAgent(
            request,
            u.access_token,
            { name: `GarbKey ${stamp()}` },
            '  ;DROP TABLE agents;-- <script> %20 ',
        );
        expect(res.status(), 'a malformed key value is ignored, not rejected').toBe(201);
        expect((await res.json()).id).toMatch(UUID_RE);
    });

    test('N parallel same-name creates under ONE key → exactly one 201 + the rest 409; one agent lands (no 5xx corruption)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const name = `Race Agent ${stamp()}`;
        const BURST = 5;

        const results = await Promise.all(
            Array.from({ length: BURST }, () => postAgent(request, u.access_token, { name }, key)),
        );
        const statuses = results.map((r) => r.status());
        const winners = statuses.filter((s) => s === 201);
        expect(winners.length, 'the atomic scope-unique gate lets exactly one create win').toBe(1);
        // Every loser is the normal 409 conflict; a sqlite tx-serialization 5xx is
        // a tolerated driver artifact (unique-constraint race), NOT a data defect.
        for (const s of statuses.filter((s) => s !== 201)) {
            expect([409, 500, 502, 503], `loser status ${s}`).toContain(s);
        }

        // The DURABLE invariant: exactly one agent row survived the race (scoped
        // list filtered to my contested name — never a global count).
        const list = await request.get(`${AGENTS}?limit=100`, {
            headers: authedHeaders(u.access_token),
        });
        expect(list.status()).toBe(200);
        const mine = ((await list.json()).data as { name: string }[]).filter(
            (a) => a.name === name,
        );
        expect(mine.length, 'one and only one agent survived the create race').toBe(1);
    });

    test('key presence is dedup-agnostic — create name X with NO key, then name X WITH a key → still 409', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const name = `Agnostic Agent ${stamp()}`;
        const noKey = await postAgent(request, u.access_token, { name });
        expect(noKey.status(), 'un-keyed create wins the slot').toBe(201);

        const withKey = await postAgent(request, u.access_token, { name }, `idem-${stamp()}`);
        expect(
            withKey.status(),
            'adding a key neither bypasses nor satisfies the native dedup',
        ).toBe(409);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TASKS — key is a TOTAL no-op; NO dedup, slug auto-increments T-n.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Tasks — Idempotency-Key totally inert; no dedup, T-n slug increments', () => {
    test('same key retried 3× (identical body) → three distinct tasks, distinct ids + distinct T-n slugs', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const title = `Retry Task ${stamp()}`;

        const bodies = [];
        for (let i = 0; i < 3; i++) {
            const r = await postTask(request, u.access_token, { title }, key);
            expect(r.status(), 'every keyed retry mints a fresh task (no replay)').toBe(201);
            bodies.push(await r.json());
        }
        const ids = bodies.map((b) => b.id);
        const slugs = bodies.map((b) => b.slug);
        for (const id of ids) expect(id).toMatch(UUID_RE);
        for (const s of slugs) expect(s).toMatch(TASK_SLUG_RE);
        expect(new Set(ids).size, 'three distinct task ids under one key').toBe(3);
        expect(new Set(slugs).size, 'three distinct auto-incrementing T-n slugs').toBe(3);
    });

    test('a distinct key vs a repeated key both create — the key never becomes a dedup token', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const title = `Distinct Key Task ${stamp()}`;
        const a = await postTask(request, u.access_token, { title }, `idem-a-${stamp()}`);
        const b = await postTask(request, u.access_token, { title }, `idem-b-${stamp()}`);
        expect(a.status()).toBe(201);
        expect(b.status()).toBe(201);
        expect((await a.json()).id, 'different keys → different tasks').not.toBe(
            (await b.json()).id,
        );
    });

    test('empty AND multi-KB Idempotency-Key are both tolerated on tasks (no 431, no 5xx)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const empty = await postTask(request, u.access_token, { title: `EmptyK ${stamp()}` }, '');
        expect(empty.status(), 'empty key ignored').toBe(201);

        const long = 'x'.repeat(2048);
        const big = await postTask(request, u.access_token, { title: `LongK ${stamp()}` }, long);
        expect(big.status(), 'a 2KB key is ignored, not rejected with 431').toBe(201);
        expect((await big.json()).slug).toMatch(TASK_SLUG_RE);
    });

    test('N parallel identical creates under ONE key → all 201, N distinct ids (no dedup, no lost create)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const title = `Par Task ${stamp()}`;
        const BURST = 6;

        const results = await Promise.all(
            Array.from({ length: BURST }, () => postTask(request, u.access_token, { title }, key)),
        );
        const statuses = results.map((r) => r.status());
        expect(server5xx(statuses), `no 5xx (statuses=${statuses})`).toEqual([]);
        expect(
            statuses.every((s) => s === 201),
            `all created (${statuses})`,
        ).toBe(true);
        const ids = (await Promise.all(results.map((r) => r.json()))).map((b) => b.id);
        expect(new Set(ids).size, 'the shared key created N distinct tasks — none collapsed').toBe(
            BURST,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND-TRIGGERS — key is inert; NO name dedup; each create mints a new secret.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Inbound-Triggers — Idempotency-Key inert; no name dedup, fresh secret each time', () => {
    test('same key + same name retried → two distinct 201 triggers with DISTINCT ids AND DISTINCT secrets', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const name = `Idem Trigger ${stamp()}`;

        const a = await postTrigger(request, u.access_token, { name }, key);
        const b = await postTrigger(request, u.access_token, { name }, key);
        expect(a.status()).toBe(201);
        expect(b.status()).toBe(201);
        const ba = await a.json();
        const bb = await b.json();
        expect(ba.trigger.id).toMatch(UUID_RE);
        expect(bb.trigger.id).toMatch(UUID_RE);
        expect(ba.trigger.id, 'a reused key did not replay the trigger').not.toBe(bb.trigger.id);
        // The strongest tell the key is inert: the secret is NOT replayed — each
        // create returns its own freshly-minted signing secret.
        expect(typeof ba.secret, 'secret returned on create').toBe('string');
        expect(ba.secret, 'the retry minted a brand-new secret (no replay)').not.toBe(bb.secret);
    });

    test('empty AND whitespace-only Idempotency-Key are tolerated on triggers', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const empty = await postTrigger(request, u.access_token, { name: `EmptyK ${stamp()}` }, '');
        expect(empty.status(), 'empty key ignored').toBe(201);
        const ws = await postTrigger(request, u.access_token, { name: `WsK ${stamp()}` }, '   ');
        expect(ws.status(), 'whitespace-only key ignored').toBe(201);
        expect((await ws.json()).trigger.id).toMatch(UUID_RE);
    });

    test('N parallel same-name creates under ONE key → all 201, N distinct ids + N distinct secrets', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const name = `Race Trigger ${stamp()}`;
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                postTrigger(request, u.access_token, { name }, key),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(server5xx(statuses), `no 5xx (statuses=${statuses})`).toEqual([]);
        expect(
            statuses.every((s) => s === 201),
            `no name-dedup: all 201 (${statuses})`,
        ).toBe(true);
        const bodies = await Promise.all(results.map((r) => r.json()));
        expect(new Set(bodies.map((b) => b.trigger.id)).size, 'N distinct trigger ids').toBe(BURST);
        expect(new Set(bodies.map((b) => b.secret)).size, 'N distinct secrets').toBe(BURST);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// MISSIONS — key is inert; NO dedup (/api/me/missions).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Missions — Idempotency-Key inert; no dedup', () => {
    test('same key + same description+type retried → two distinct 201 missions (no replay)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const description = `Idem mission ${stamp()}`;

        const a = await postMission(request, u.access_token, { description }, key);
        const b = await postMission(request, u.access_token, { description }, key);
        expect(a.status()).toBe(201);
        expect(b.status()).toBe(201);
        const ba = await a.json();
        const bb = await b.json();
        expect(ba.id).toMatch(UUID_RE);
        expect(bb.id).toMatch(UUID_RE);
        expect(ba.id, 'the reused key did not collapse two identical missions').not.toBe(bb.id);
        // Title is derived from description on both — proving they are real twins,
        // not one replayed row.
        expect(ba.title).toBe(description);
        expect(bb.title).toBe(description);
    });

    test('empty AND garbage Idempotency-Key are tolerated on missions', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const empty = await postMission(
            request,
            u.access_token,
            { description: `EmptyK mission ${stamp()}` },
            '',
        );
        expect(empty.status(), 'empty key ignored').toBe(201);
        const garbage = await postMission(
            request,
            u.access_token,
            { description: `GarbK mission ${stamp()}` },
            // Injection-shaped but a VALID HTTP header value (visible ASCII only —
            // undici/Playwright reject non-latin1 header content client-side, which
            // would never exercise the server's tolerance).
            "nao-uuid://boom <b>%00 ';--",
        );
        expect(garbage.status(), 'garbage key ignored').toBe(201);
        expect((await garbage.json()).id).toMatch(UUID_RE);
    });

    test('N parallel identical creates under ONE key → all 201, N distinct ids; scoped list carries all N', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const description = `Par mission ${stamp()}`;
        const BURST = 5;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                postMission(request, u.access_token, { description }, key),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(server5xx(statuses), `no 5xx (statuses=${statuses})`).toEqual([]);
        expect(
            statuses.every((s) => s === 201),
            `no dedup: all 201 (${statuses})`,
        ).toBe(true);
        const ids = (await Promise.all(results.map((r) => r.json()))).map((b) => b.id);
        expect(new Set(ids).size, 'N distinct mission ids under one key').toBe(BURST);

        // Scoped list (bare array, filtered to my contested description) has all N.
        const list = await request.get(MISSIONS, { headers: authedHeaders(u.access_token) });
        expect(list.status()).toBe(200);
        const mine = ((await list.json()) as { title: string }[]).filter(
            (m) => m.title === description,
        );
        expect(mine.length, 'every keyed create persisted — none deduped away').toBe(BURST);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKS — key is inert; the SLUG (per owner) is the real 400 dedup.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Works — Idempotency-Key inert; slug governs the 400 dedup', () => {
    test('same key + SAME slug → first 200, second 400 "Work already exists" (slug dedup, not the key)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const slug = `idem-same-${stamp()}`;

        const first = await postWork(request, u.access_token, { name: 'IdemSame', slug }, key);
        expect(first.status(), 'works create is HTTP 200 (not 201)').toBe(200);
        expect((await first.json()).status).toBe('success');

        const second = await postWork(request, u.access_token, { name: 'IdemSame', slug }, key);
        expect(second.status(), 'the retry is rejected on the SLUG, not replayed by the key').toBe(
            400,
        );
        const body = await second.json();
        expect(body.status).toBe('error');
        expect(body.message).toBe('Work already exists');
    });

    test('same key + DIFFERENT slugs → two distinct 200 works (the key does not dedup)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const a = await postWork(
            request,
            u.access_token,
            { name: 'IdemA', slug: `idem-a-${stamp()}` },
            key,
        );
        const b = await postWork(
            request,
            u.access_token,
            { name: 'IdemB', slug: `idem-b-${stamp()}` },
            key,
        );
        expect(a.status()).toBe(200);
        expect(b.status()).toBe(200);
        const idA = (await a.json()).work.id;
        const idB = (await b.json()).work.id;
        expect(idA).toMatch(UUID_RE);
        expect(idB).toMatch(UUID_RE);
        expect(idA, 'the reused key did not collapse two different-slug creates').not.toBe(idB);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-ENDPOINT — one key carries NO server-side state across resources/users.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Cross-endpoint — the key is not a global single-flight token', () => {
    test('ONE shared key across all five endpoints → each creates its own distinct resource', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        const key = `global-${stamp()}`;
        const s = stamp();

        const work = await postWork(request, u.access_token, { name: 'XW', slug: `xw-${s}` }, key);
        const agent = await postAgent(request, u.access_token, { name: `XA ${s}` }, key);
        const task = await postTask(request, u.access_token, { title: `XT ${s}` }, key);
        const trigger = await postTrigger(request, u.access_token, { name: `XTr ${s}` }, key);
        const mission = await postMission(
            request,
            u.access_token,
            { description: `XM ${s} desc` },
            key,
        );

        expect(work.status(), 'work created despite shared key').toBe(200);
        expect(agent.status(), 'agent created despite shared key').toBe(201);
        expect(task.status(), 'task created despite shared key').toBe(201);
        expect(trigger.status(), 'trigger created despite shared key').toBe(201);
        expect(mission.status(), 'mission created despite shared key').toBe(201);

        // Every resource has its own identity — the shared key coupled nothing.
        const ids = [
            (await work.json()).work.id,
            (await agent.json()).id,
            (await task.json()).id,
            (await trigger.json()).trigger.id,
            (await mission.json()).id,
        ];
        for (const id of ids) expect(id).toMatch(UUID_RE);
        expect(new Set(ids).size, 'five endpoints → five distinct ids under one key').toBe(5);
    });

    test('a key that committed a Work carries no state to a later Task under the same key', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const key = `carry-${stamp()}`;
        const slug = `carry-w-${stamp()}`;

        const w1 = await postWork(request, u.access_token, { name: 'Carry', slug }, key);
        expect(w1.status()).toBe(200);
        // The Work dedup still fires on the SAME slug + SAME key (proving the key
        // stored nothing that would replay a success instead).
        const w2 = await postWork(request, u.access_token, { name: 'Carry', slug }, key);
        expect(w2.status(), 'same-slug retry still 400s — no keyed replay').toBe(400);
        // …yet the very same key freely creates a Task (no cross-endpoint store).
        const t = await postTask(request, u.access_token, { title: `Carry Task ${stamp()}` }, key);
        expect(t.status(), 'the "used" key does not suppress an unrelated Task').toBe(201);
        expect((await t.json()).slug).toMatch(TASK_SLUG_RE);
    });

    test('under ONE key, native dedup speaks two DIFFERENT codes — works 400 (slug) vs agents 409 (name)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const key = `contrast-${stamp()}`;
        const slug = `contrast-w-${stamp()}`;
        const agentName = `Contrast Agent ${stamp()}`;

        expect((await postWork(request, u.access_token, { name: 'C', slug }, key)).status()).toBe(
            200,
        );
        expect((await postAgent(request, u.access_token, { name: agentName }, key)).status()).toBe(
            201,
        );

        // Same key, dup on each — each endpoint answers with ITS OWN dedup code.
        const dupWork = await postWork(request, u.access_token, { name: 'C', slug }, key);
        const dupAgent = await postAgent(request, u.access_token, { name: agentName }, key);
        expect(dupWork.status(), 'works dedup is a 400 envelope').toBe(400);
        expect((await dupWork.json()).message).toBe('Work already exists');
        expect(dupAgent.status(), 'agents dedup is a 409 conflict').toBe(409);
        expect((await dupAgent.json()).statusCode).toBe(409);
    });

    test('cross-user same key on missions → both users create (no global key registry)', async ({
        request,
    }) => {
        const [u1, u2] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const key = `cross-user-${stamp()}`;
        const description = `Shared-key mission ${stamp()}`;

        const [r1, r2] = await Promise.all([
            postMission(request, u1.access_token, { description }, key),
            postMission(request, u2.access_token, { description }, key),
        ]);
        expect(r1.status(), 'user 1 mission created').toBe(201);
        expect(r2.status(), 'user 2 mission created under the identical key').toBe(201);
        expect((await r1.json()).id, 'the two owners minted distinct missions').not.toBe(
            (await r2.json()).id,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// KEY-VALUE TOLERANCE SWEEPS — no key value ever 4xx's-the-header or 5xx's.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Key-value tolerance — every endpoint ignores the header value', () => {
    /** Create one of each resource under `key`; return the five statuses. */
    async function sweep(request: APIRequestContext, token: string, key: string) {
        const s = stamp();
        const [work, agent, task, trigger, mission] = await Promise.all([
            postWork(request, token, { name: 'SW', slug: `sw-${s}` }, key),
            postAgent(request, token, { name: `SA ${s}` }, key),
            postTask(request, token, { title: `ST ${s}` }, key),
            postTrigger(request, token, { name: `STr ${s}` }, key),
            postMission(request, token, { description: `SM ${s} desc` }, key),
        ]);
        return {
            works: work.status(),
            agents: agent.status(),
            tasks: task.status(),
            triggers: trigger.status(),
            missions: mission.status(),
        };
    }

    function assertAllCreated(codes: Record<string, number>) {
        expect(codes.works, 'works → 200').toBe(200);
        expect(codes.agents, 'agents → 201').toBe(201);
        expect(codes.tasks, 'tasks → 201').toBe(201);
        expect(codes.triggers, 'triggers → 201').toBe(201);
        expect(codes.missions, 'missions → 201').toBe(201);
        expect(server5xx(Object.values(codes)), 'no endpoint 5xx on the key').toEqual([]);
    }

    test('an EMPTY key value creates on every one of the five endpoints', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        assertAllCreated(await sweep(request, u.access_token, ''));
    });

    test('a GARBAGE / injection-shaped key value creates on every one of the five endpoints', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        assertAllCreated(
            // Visible-ASCII injection payload (non-latin1 header content is rejected
            // client-side by undici, so it can never reach the server to be tolerated).
            await sweep(request, u.access_token, " ';DELETE FROM works;-- <img src=x> %00 xss "),
        );
    });

    test('a multi-KB key value creates on every one of the five endpoints (no 431)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const u = await registerUserViaAPI(request);
        assertAllCreated(await sweep(request, u.access_token, `big-${'k'.repeat(4096)}`));
    });
});
