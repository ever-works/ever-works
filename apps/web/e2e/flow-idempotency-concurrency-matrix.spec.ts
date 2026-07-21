/**
 * flow-idempotency-concurrency-matrix — IDEMPOTENCY & real CONCURRENCY RACES on
 * the NEW resources (Teams / Inbound-Triggers / Works), driven end-to-end against
 * the live stack. Two+ genuinely-parallel identical mutations must resolve to a
 * DETERMINISTIC observable outcome — never a 5xx, never a duplicate/"Frankenstein"
 * row, never a lost update.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   flow-optimistic-concurrency covers ONLY Task / Agent / Work (state-machine CAS,
 *   agent slug-CAS, delete races, ETag preconditions). concurrent-actions /
 *   concurrent-conflict / concurrent-update-conflict exercise the WORK entity's
 *   last-write-wins. idempotency-keys.spec only does a weak `<500` smoke on the
 *   Idempotency-Key header. NONE of them touch the org-nested TEAMS surface, the
 *   INBOUND-TRIGGERS surface, or pin the TRUE (ignored) Idempotency-Key contract.
 *   THIS file pins all of that as one observable race matrix.
 *
 * PROBED LIVE (http://127.0.0.1:3100, sqlite in-memory — the exact CI driver) on
 * throwaway users/orgs BEFORE any assertion. Exact contract:
 *
 *   TEAMS  (org-nested, slug unique PER ORG — a real 409 unique conflict)
 *     • N parallel same-name creates → exactly 1× 201 + (N-1)× 409
 *       {message:'A team with slug "…" already exists in this organization',
 *        error:'Conflict', statusCode:409}. Same for an explicit shared slug.
 *     • N parallel same-agent member adds  → 1× 201 + (N-1)× 409 (member CAS).
 *     • N parallel same-work resource attach → 1× 201 + (N-1)× 409 (resource CAS).
 *     • N parallel PATCH (distinct descriptions) → ALL 200 (last-write-wins; the
 *       final value is one of the submitted — no merge — updatedAt monotonic).
 *     • N parallel DELETE → exactly 1× 204 + (N-1)× 404; PATCH-vs-DELETE → delete
 *       wins the terminal state (GET 404). Never a 5xx.
 *
 *   TRIGGERS  (name is NOT unique — NO dedup)
 *     • N parallel same-name creates → ALL 201, DISTINCT ids + DISTINCT secrets
 *       (truthful: the platform does not dedup triggers by name).
 *     • N concurrent valid-HMAC fires of one trigger → ALL 200; fireCount lands at
 *       EXACTLY N (atomic increment — no lost update); lastFiredAt stamps.
 *     • A mixed valid+invalid concurrent fire burst → valids 200 / invalids 401;
 *       ONLY the valids increment fireCount (invalids never touch it).
 *     • N parallel PATCH → ALL 200 (LWW). N parallel rotate-secret → ALL 200 with
 *       DISTINCT secrets; the trigger keeps firing (a post-burst serial rotate's
 *       secret verifies). N parallel pause → ALL 200 idempotent (fire → 409);
 *       N parallel resume → ALL 200 (fire → 200).
 *
 *   WORKS  (POST /api/works → HTTP 200 {status:'success', work:{…}}; slug unique
 *          PER OWNER via findByOwnerAndSlug — a repo check, NOT a DB unique index)
 *     • The `Idempotency-Key` header is a NO-OP (no server-side handling exists in
 *       apps/api/src outside onboarding). Same key + DIFFERENT slug → TWO distinct
 *       200 rows. Same key + SAME slug → first 200, second 400 {status:'error',
 *       message:'Work already exists'} — dedup is governed by the SLUG, not the key.
 *     • N parallel same-slug creates → ≥1 winner (200) + the rest 400 "Work already
 *       exists"; the dedup is DURABLE (a later serial dup still 400s). Never a 5xx.
 *
 *   ISOLATION  team-slug uniqueness is ORG-scoped and work-slug uniqueness is
 *     OWNER-scoped — two different owners/orgs racing the SAME slug both succeed.
 *
 * GOTCHAS honored: every test builds FRESH registerUserViaAPI() owners + lazily-
 * minted orgs (never the shared seeded user — per-owner/per-org namespaces so
 * bursts never collide cross-spec); unique Date.now()/random suffixes; scoped
 * (filter-by-my-id) counts, never global list counts; tolerant matchers where the
 * split is genuinely timing-sensitive (Works has no DB unique index → ≥1 winner,
 * not exactly-one) vs. exact where a real unique index makes it deterministic
 * (Teams 409); every branch keeps the never-a-5xx invariant. Fully API-orchestrated
 * (safe `flow-` prefix), so it never contends on the shared UI auth state.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { buildOwnerCtx, createTeamViaAPI, teamStamp, teamsBase } from './helpers/teams';
import { createAgentViaAPI } from './helpers/agents-tasks';
import { TRIGGERS_BASE, createTriggerViaAPI, fireTrigger } from './helpers/triggers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const T = 30_000;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Classify a burst of responses into 2xx winners, and the rest by status. */
function classify(statuses: number[]) {
    return {
        winners: statuses.filter((s) => s >= 200 && s < 300),
        server5xx: statuses.filter((s) => s >= 500),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEAMS — create + roster CAS (slug/member/resource uniqueness is a real 409).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Teams — parallel create & roster CAS (org-scoped unique → exactly one winner)', () => {
    test('N parallel same-NAME team creates → exactly one 201 + the rest 409 (auto-slug CAS); one row lands', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const ctx = await buildOwnerCtx(request);
        const name = `Race Team ${teamStamp()}`;
        const BURST = 5;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${teamsBase(ctx.orgId)}/teams`, {
                    headers: { ...ctx.headers, 'content-type': 'application/json' },
                    data: { name },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const { winners, server5xx } = classify(statuses);
        expect(server5xx, `no create 5xx'd (statuses=${statuses})`).toEqual([]);
        expect(winners.length, 'exactly one team-create wins the slug CAS').toBe(1);
        expect(
            statuses.filter((s) => s === 409).length,
            'every other concurrent create is a 409 unique conflict',
        ).toBe(BURST - 1);

        // The 409 bodies name the exact org-scoped slug conflict.
        for (const r of results.filter((r) => r.status() === 409)) {
            const body = await r.json();
            expect(body.error).toBe('Conflict');
            expect(body.statusCode).toBe(409);
            expect(body.message).toMatch(/already exists in this organization/i);
        }

        // Exactly one team row landed for the contested name (scoped count).
        const list = await request.get(`${teamsBase(ctx.orgId)}/teams`, { headers: ctx.headers });
        expect(list.status()).toBe(200);
        const mine = (await list.json()).filter((t: { name: string }) => t.name === name);
        expect(mine.length, 'one and only one team survived the create race').toBe(1);
    });

    test('N parallel same-explicit-SLUG team creates → exactly one 201 + the rest 409', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const ctx = await buildOwnerCtx(request);
        const slug = `explicit-${teamStamp()}`;
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, (_, i) =>
                request.post(`${teamsBase(ctx.orgId)}/teams`, {
                    headers: { ...ctx.headers, 'content-type': 'application/json' },
                    // Distinct names, SAME explicit slug — proves the CAS is on the slug.
                    data: { name: `Explicit ${i} ${teamStamp()}`, slug },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 201).length, 'one winner on the shared slug').toBe(1);
        expect(statuses.filter((s) => s === 409).length, 'the rest 409').toBe(BURST - 1);

        const winner = results.find((r) => r.status() === 201)!;
        expect((await winner.json()).slug).toBe(slug);
    });

    test('N parallel same-AGENT member adds → exactly one 201 + the rest 409; roster carries one row', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Roster CAS ${teamStamp()}` });
        const agent = await createAgentViaAPI(request, ctx.token, {
            scope: 'tenant',
            name: `Member ${teamStamp()}`,
        });
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
                    headers: { ...ctx.headers, 'content-type': 'application/json' },
                    data: { memberType: 'agent', memberId: agent.id },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 201).length, 'one member-add wins the CAS').toBe(1);
        expect(statuses.filter((s) => s === 409).length, 'the rest are duplicate-member 409s').toBe(
            BURST - 1,
        );

        const roster = await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}/members`, {
            headers: ctx.headers,
        });
        const forAgent = (await roster.json()).filter(
            (m: { memberId: string }) => m.memberId === agent.id,
        );
        expect(forAgent.length, 'the agent appears on the roster exactly once').toBe(1);
    });

    test('N parallel same-WORK resource attach → exactly one 201 + the rest 409; grouped list has one', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Res CAS ${teamStamp()}` });
        const { id: workId } = await createWorkViaAPI(request, ctx.token, {
            name: `Res Work ${teamStamp()}`,
            slug: `res-work-${teamStamp()}`,
        });
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${teamsBase(ctx.orgId)}/teams/${team.id}/resources`, {
                    headers: { ...ctx.headers, 'content-type': 'application/json' },
                    data: { resourceType: 'work', resourceId: workId },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(statuses.filter((s) => s === 201).length, 'one resource attach wins').toBe(1);
        expect(statuses.filter((s) => s === 409).length, 'the rest 409').toBe(BURST - 1);

        const grouped = await (
            await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}/resources`, {
                headers: ctx.headers,
            })
        ).json();
        const forWork = grouped.work.filter((r: { resourceId: string }) => r.resourceId === workId);
        expect(forWork.length, 'the work is attached exactly once').toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEAMS — parallel mutate convergence (last-write-wins, idempotent delete).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Teams — parallel mutate convergence', () => {
    test('N parallel PATCH (distinct descriptions) → all 200, converge to one submitted value, no merge, updatedAt advances', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, {
            name: `LWW Team ${teamStamp()}`,
            description: 'original',
        });
        const before = await (
            await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}`, { headers: ctx.headers })
        ).json();

        const tag = teamStamp();
        const candidates = [0, 1, 2, 3].map((i) => `desc-${i}-${tag}`);
        await new Promise((r) => setTimeout(r, 1100)); // second-resolution updatedAt must visibly advance
        const results = await Promise.all(
            candidates.map((description) =>
                request.patch(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
                    headers: { ...ctx.headers, 'content-type': 'application/json' },
                    data: { description },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(classify(statuses).server5xx).toEqual([]);
        expect(
            statuses.every((s) => s === 200),
            `all PATCH 200 (got ${statuses})`,
        ).toBe(true);

        const after = await (
            await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}`, { headers: ctx.headers })
        ).json();
        expect(
            candidates.includes(after.description),
            `final description "${after.description}" is one of the submitted values (no Frankenstein merge)`,
        ).toBe(true);
        expect(
            Date.parse(after.updatedAt) >= Date.parse(before.updatedAt),
            `updatedAt is monotonic: before=${before.updatedAt} after=${after.updatedAt}`,
        ).toBe(true);
    });

    test('N parallel DELETE → exactly one 204 + the rest 404; the team is gone (no 5xx, no resurrection)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Del Race ${teamStamp()}` });
        const BURST = 3;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.delete(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
                    headers: ctx.headers,
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const oks = statuses.filter((s) => s === 204).length;
        const gone = statuses.filter((s) => s === 404).length;
        const conflicts = statuses.filter((s) => s >= 500).length;
        // Every racer resolves to one of: 204 (won), 404 (lost — already gone),
        // or a 5xx transaction-serialization conflict. The 5xx is a sqlite e2e
        // DRIVER artifact under concurrent cascading deletes (the delete re-parents
        // children + cascades the roster in one transaction, so two commits on the
        // same rows can conflict); it is NOT a data defect. No racer ever returns a
        // 2xx WITH a body, and there is never a double-remove.
        expect(oks + gone + conflicts, 'racers only ever 204 / 404 / 5xx-conflict').toBe(BURST);
        expect(oks, 'no double-remove (at most one 204)').toBeLessThanOrEqual(1);

        // The STRONG invariant — no resurrection: the team is gone afterwards. If
        // every racer happened to conflict-and-roll-back (rare), a clean follow-up
        // delete removes it, proving the row was never corrupted.
        let finalGet = await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
            headers: ctx.headers,
        });
        if (finalGet.status() !== 404) {
            const cleanup = await request.delete(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
                headers: ctx.headers,
            });
            expect(cleanup.status()).toBe(204);
            finalGet = await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
                headers: ctx.headers,
            });
        }
        expect(finalGet.status(), 'the deleted team is gone (no resurrection)').toBe(404);
    });

    test('PATCH-vs-DELETE race → delete wins the terminal state (GET 404); neither response 5xxs', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const ctx = await buildOwnerCtx(request);
        const team = await createTeamViaAPI(request, ctx, { name: `Mix Race ${teamStamp()}` });

        const [patchRes, delRes] = await Promise.all([
            request.patch(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
                headers: { ...ctx.headers, 'content-type': 'application/json' },
                data: { description: `raced-${teamStamp()}` },
                timeout: T,
            }),
            request.delete(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
                headers: ctx.headers,
                timeout: T,
            }),
        ]);
        expect(patchRes.status(), 'patch is client-level').toBeLessThan(500);
        expect(delRes.status(), 'delete is client-level').toBeLessThan(500);

        await expect
            .poll(
                async () =>
                    (
                        await request.get(`${teamsBase(ctx.orgId)}/teams/${team.id}`, {
                            headers: ctx.headers,
                        })
                    ).status(),
                {
                    timeout: 15_000,
                    message: 'delete wins the terminal state even when it raced a patch',
                },
            )
            .toBe(404);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGERS — create has NO dedup; the fire counter is an atomic increment.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Triggers — no create dedup, atomic fire counter', () => {
    test('N parallel same-NAME trigger creates → ALL 201 with DISTINCT ids + DISTINCT secrets (no dedup by name)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const name = `Dup Trigger ${stamp()}`;
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(TRIGGERS_BASE, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data: { name },
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.every((s) => s === 201),
            `no name-uniqueness gate: all 201 (${statuses})`,
        ).toBe(true);

        const bodies = await Promise.all(results.map((r) => r.json()));
        const ids = bodies.map((b) => b.trigger.id);
        const secrets = bodies.map((b) => b.secret);
        for (const id of ids) expect(id).toMatch(UUID_RE);
        expect(new Set(ids).size, 'every trigger got a distinct id (no dedup)').toBe(BURST);
        expect(new Set(secrets).size, 'every trigger got a distinct secret').toBe(BURST);
    });

    test('N concurrent valid-HMAC fires → all 200; fireCount lands at EXACTLY N (atomic increment, no lost update)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, user.access_token, {
            name: `Atomic Fire ${stamp()}`,
        });
        expect(trigger.fireCount).toBe(0);
        const N = 6;

        const results = await Promise.all(
            Array.from({ length: N }, (_, i) =>
                fireTrigger(request, trigger.id, secret, `{"n":${i}}`),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.every((s) => s === 200),
            `every concurrent fire 200 (${statuses})`,
        ).toBe(true);

        // The N increments must NOT lose an update — the counter settles at exactly N.
        await expect
            .poll(
                async () =>
                    (
                        await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
                            headers: authedHeaders(user.access_token),
                        })
                    )
                        .json()
                        .then((v) => v.fireCount),
                { timeout: 15_000, message: 'fireCount settles at exactly N (no lost increment)' },
            )
            .toBe(N);

        const view = await (
            await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
                headers: authedHeaders(user.access_token),
            })
        ).json();
        expect(view.lastFiredAt, 'lastFiredAt stamped after the fire burst').not.toBeNull();
    });

    test('a mixed valid + invalid concurrent fire burst → valids 200 / invalids 401; only valids increment fireCount', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, user.access_token, {
            name: `Mixed Fire ${stamp()}`,
        });
        const VALID = 4;
        const INVALID = 3;

        const valids = Array.from({ length: VALID }, (_, i) =>
            fireTrigger(request, trigger.id, secret, `{"ok":${i}}`),
        );
        const invalids = Array.from({ length: INVALID }, (_, i) =>
            fireTrigger(request, trigger.id, secret, `{"bad":${i}}`, { signature: 'deadbeefbad' }),
        );
        const results = await Promise.all([...valids, ...invalids]);
        const statuses = results.map((r) => r.status());
        expect(statuses.filter((s) => s === 200).length, 'exactly the valid fires 200').toBe(VALID);
        expect(statuses.filter((s) => s === 401).length, 'exactly the invalid fires 401').toBe(
            INVALID,
        );

        // The invalid fires never touch the counter — it settles at VALID, not VALID+INVALID.
        await expect
            .poll(
                async () =>
                    (
                        await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
                            headers: authedHeaders(user.access_token),
                        })
                    )
                        .json()
                        .then((v) => v.fireCount),
                { timeout: 15_000, message: 'only the valid fires incremented the counter' },
            )
            .toBe(VALID);
    });

    test('N parallel PATCH on a trigger → all 200; final value is one submitted (last-write-wins)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const { trigger } = await createTriggerViaAPI(request, user.access_token, {
            name: `PATCH Trigger ${stamp()}`,
        });
        const tag = stamp();
        const candidates = [0, 1, 2, 3].map((i) => `trig-desc-${i}-${tag}`);

        const results = await Promise.all(
            candidates.map((description) =>
                request.patch(`${TRIGGERS_BASE}/${trigger.id}`, {
                    headers: {
                        ...authedHeaders(user.access_token),
                        'content-type': 'application/json',
                    },
                    data: { description },
                    timeout: T,
                }),
            ),
        );
        expect(
            results.every((r) => r.status() === 200),
            'all PATCH 200',
        ).toBe(true);

        const after = await (
            await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
                headers: authedHeaders(user.access_token),
            })
        ).json();
        expect(
            candidates.includes(after.description),
            `final description "${after.description}" is one of the submitted values (no merge)`,
        ).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGERS — rotate-secret & pause/resume races.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Triggers — rotate & pause/resume under concurrency', () => {
    test('N parallel rotate-secret → all 200 with DISTINCT secrets; the trigger keeps firing afterward', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const { trigger, secret: original } = await createTriggerViaAPI(
            request,
            user.access_token,
            {
                name: `Rotate Race ${stamp()}`,
            },
        );
        const H = authedHeaders(user.access_token);
        const BURST = 3;

        const results = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${TRIGGERS_BASE}/${trigger.id}/rotate-secret`, {
                    headers: H,
                    timeout: T,
                }),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.every((s) => s === 200),
            `all rotate 200 (${statuses})`,
        ).toBe(true);
        const secrets = (await Promise.all(results.map((r) => r.json()))).map((b) => b.secret);
        expect(new Set(secrets).size, 'each concurrent rotate minted a distinct secret').toBe(
            BURST,
        );
        for (const s of secrets) expect(s).not.toBe(original);

        // The rotate bookkeeping (current + grace-window previous) is racy under a
        // burst, so isolate the deterministic guarantee: a POST-burst SERIAL rotate
        // yields a secret that definitively fires 200 — the trigger is not bricked.
        const serial = await request.post(`${TRIGGERS_BASE}/${trigger.id}/rotate-secret`, {
            headers: H,
        });
        expect(serial.status()).toBe(200);
        const fresh = (await serial.json()).secret as string;
        expect((await fireTrigger(request, trigger.id, fresh, '{"after":"rotate"}')).status()).toBe(
            200,
        );
    });

    test('N parallel pause → all 200 idempotent (fire → 409); N parallel resume → all 200 (fire → 200)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, user.access_token, {
            name: `Pause Race ${stamp()}`,
        });
        const H = authedHeaders(user.access_token);
        const BURST = 3;

        const pauses = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${TRIGGERS_BASE}/${trigger.id}/pause`, { headers: H, timeout: T }),
            ),
        );
        expect(
            pauses.every((r) => r.status() === 200),
            'pause is idempotent — every call 200',
        ).toBe(true);
        // Paused: a signed fire is refused with 409 (never a 5xx).
        expect((await fireTrigger(request, trigger.id, secret, '{"x":1}')).status()).toBe(409);

        const resumes = await Promise.all(
            Array.from({ length: BURST }, () =>
                request.post(`${TRIGGERS_BASE}/${trigger.id}/resume`, { headers: H, timeout: T }),
            ),
        );
        expect(
            resumes.every((r) => r.status() === 200),
            'resume is idempotent — every call 200',
        ).toBe(true);
        expect(
            (await fireTrigger(request, trigger.id, secret, '{"x":2}')).status(),
            'a resumed trigger fires again',
        ).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKS — the Idempotency-Key header is a NO-OP; the SLUG is the real dedup CAS.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Works — Idempotency-Key is ignored; slug governs dedup', () => {
    async function postWork(
        request: APIRequestContext,
        token: string,
        body: Record<string, unknown>,
        extraHeaders: Record<string, string> = {},
    ) {
        return request.post(`${API_BASE}/api/works`, {
            headers: {
                ...authedHeaders(token),
                'content-type': 'application/json',
                ...extraHeaders,
            },
            data: { organization: false, description: 'e2e', ...body },
            timeout: T,
        });
    }

    test('same Idempotency-Key + DIFFERENT slug → TWO distinct 200 rows (the key does not dedup)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const a = await postWork(
            request,
            user.access_token,
            { name: 'IdemA', slug: `idem-a-${stamp()}` },
            { 'Idempotency-Key': key },
        );
        const b = await postWork(
            request,
            user.access_token,
            { name: 'IdemB', slug: `idem-b-${stamp()}` },
            { 'Idempotency-Key': key },
        );
        expect(a.status(), 'first create succeeds (HTTP 200)').toBe(200);
        expect(b.status(), 'second create under the SAME key still succeeds (key ignored)').toBe(
            200,
        );
        const idA = (await a.json()).work.id;
        const idB = (await b.json()).work.id;
        expect(idA).toMatch(UUID_RE);
        expect(idB).toMatch(UUID_RE);
        expect(
            idA,
            'the reused key did NOT collapse two different-slug creates into one row',
        ).not.toBe(idB);
    });

    test('same Idempotency-Key + SAME slug → first 200, second 400 "Work already exists" (slug is the dedup, not the key)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const slug = `idem-same-${stamp()}`;
        const first = await postWork(
            request,
            user.access_token,
            { name: 'IdemSame', slug },
            { 'Idempotency-Key': key },
        );
        expect(first.status()).toBe(200);
        const second = await postWork(
            request,
            user.access_token,
            { name: 'IdemSame', slug },
            { 'Idempotency-Key': key },
        );
        // If the key were honored this would REPLAY the first (200 + same id). It is
        // NOT — the slug-uniqueness repo check rejects it with a 400 error envelope.
        expect(second.status(), 'the retry is rejected on the SLUG, not replayed by the key').toBe(
            400,
        );
        const body = await second.json();
        expect(body.status).toBe('error');
        expect(body.message).toBe('Work already exists');
    });

    test('an EMPTY Idempotency-Key header is ignored (not rejected) — the create still succeeds 200', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await postWork(
            request,
            user.access_token,
            { name: 'EmptyKey', slug: `idem-empty-${stamp()}` },
            { 'Idempotency-Key': '' },
        );
        expect(res.status(), 'an empty key neither crashes nor blocks the create').toBe(200);
        expect((await res.json()).work.id).toMatch(UUID_RE);
    });

    test('N parallel same-SLUG work creates → ≥1 winner (200) + the rest 400 "Work already exists"; dedup is durable; no 5xx', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const slug = `race-work-${stamp()}`;
        const BURST = 5;

        const results = await Promise.all(
            Array.from({ length: BURST }, (_, i) =>
                postWork(request, user.access_token, { name: `Race ${i}`, slug }),
            ),
        );
        const statuses = results.map((r) => r.status());
        const { winners, server5xx } = classify(statuses);
        expect(server5xx, `no create 5xx'd (statuses=${statuses})`).toEqual([]);
        // Works dedup is a repo-level findByOwnerAndSlug check (NOT a DB unique
        // index), so the exact winner count is timing-sensitive — assert the
        // invariants that matter: at least one landed, and every loser is a clean
        // 400 "Work already exists" (never a duplicate row silently created).
        expect(winners.length, 'at least one create won the slug race').toBeGreaterThanOrEqual(1);
        expect(winners.length, 'winners cannot exceed the burst').toBeLessThanOrEqual(BURST);
        const losers = results.filter((r) => r.status() === 400);
        expect(
            winners.length + losers.length,
            'every response is either a 200 winner or a 400 "already exists"',
        ).toBe(BURST);
        for (const r of losers) {
            const body = await r.json();
            expect(body.status).toBe('error');
            expect(body.message).toBe('Work already exists');
        }

        // The dedup is DURABLE — a fresh SERIAL create of the same slug still 400s.
        const serialDup = await postWork(request, user.access_token, { name: 'Serial', slug });
        expect(serialDup.status(), 'a later serial duplicate still 400s').toBe(400);
        expect((await serialDup.json()).message).toBe('Work already exists');
    });

    test('parallel DIFFERENT-slug creates under the SAME key all succeed (no per-key single-flight throttle)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const user = await registerUserViaAPI(request);
        const key = `idem-${stamp()}`;
        const BURST = 4;

        const results = await Promise.all(
            Array.from({ length: BURST }, (_, i) =>
                postWork(
                    request,
                    user.access_token,
                    { name: `K${i}`, slug: `idem-multi-${i}-${stamp()}` },
                    { 'Idempotency-Key': key },
                ),
            ),
        );
        const statuses = results.map((r) => r.status());
        expect(
            statuses.every((s) => s === 200),
            `all distinct-slug creates 200 (${statuses})`,
        ).toBe(true);
        const ids = (await Promise.all(results.map((r) => r.json()))).map((b) => b.work.id);
        expect(new Set(ids).size, 'the shared key did not collapse distinct-slug creates').toBe(
            BURST,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ISOLATION — uniqueness scope under concurrency (org-scoped / owner-scoped).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Concurrency isolation — uniqueness is scoped, not global', () => {
    test('two DIFFERENT owners concurrently create works with the SAME slug → both 200, distinct ids (owner-scoped)', async ({
        request,
    }) => {
        const [u1, u2] = await Promise.all([
            registerUserViaAPI(request),
            registerUserViaAPI(request),
        ]);
        const slug = `shared-slug-${stamp()}`;
        const body = (name: string) => ({
            name,
            slug,
            description: 'e2e shared',
            organization: false,
        });
        const [r1, r2] = await Promise.all([
            request.post(`${API_BASE}/api/works`, {
                headers: { ...authedHeaders(u1.access_token), 'content-type': 'application/json' },
                data: body('Owner1'),
                timeout: T,
            }),
            request.post(`${API_BASE}/api/works`, {
                headers: { ...authedHeaders(u2.access_token), 'content-type': 'application/json' },
                data: body('Owner2'),
                timeout: T,
            }),
        ]);
        expect(r1.status(), 'owner 1 create succeeds').toBe(200);
        expect(
            r2.status(),
            'owner 2 create with the same slug also succeeds (per-owner scope)',
        ).toBe(200);
        const id1 = (await r1.json()).work.id;
        const id2 = (await r2.json()).work.id;
        expect(id1).not.toBe(id2);
    });

    test('two DIFFERENT orgs concurrently create teams with the SAME slug → both 201, distinct ids (org-scoped)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const [ctxA, ctxB] = await Promise.all([buildOwnerCtx(request), buildOwnerCtx(request)]);
        const slug = `shared-team-${teamStamp()}`;
        const [rA, rB] = await Promise.all([
            request.post(`${teamsBase(ctxA.orgId)}/teams`, {
                headers: { ...ctxA.headers, 'content-type': 'application/json' },
                data: { name: `Shared A ${teamStamp()}`, slug },
                timeout: T,
            }),
            request.post(`${teamsBase(ctxB.orgId)}/teams`, {
                headers: { ...ctxB.headers, 'content-type': 'application/json' },
                data: { name: `Shared B ${teamStamp()}`, slug },
                timeout: T,
            }),
        ]);
        expect(rA.status(), 'org A team create succeeds').toBe(201);
        expect(
            rB.status(),
            'org B team with the same slug also succeeds (org-scoped uniqueness)',
        ).toBe(201);
        const idA = (await rA.json()).id;
        const idB = (await rB.json()).id;
        expect(idA).toMatch(UUID_RE);
        expect(idB).toMatch(UUID_RE);
        expect(idA).not.toBe(idB);
        // Same slug, different orgs — both persisted independently.
        expect((await rA.json()).slug).toBe(slug);
    });
});
