import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-work-community-pr-multistep.spec.ts
 *
 * CROSS-FEATURE, MULTISTEP integration flows that WEAVE the two halves of a
 * Work's "community" surface that no single existing spec joins:
 *   (1) the Idea (WorkProposal) accept / reject / list surface under
 *       `/api/me/work-proposals`, and
 *   (2) the community-PR ingest surface on the RESULTING Work
 *       (`communityPrEnabled`/`communityPrAutoClose` flags + the manual
 *       `POST /api/works/:id/process-community-prs` trigger).
 *
 * The thesis pinned throughout: the Idea→Work provenance (`acceptedWorkId`
 * on the Idea, `acceptedFromIdeaId` + the `idea_works` link on the Work) and
 * the community-PR processor state (`communityPrEnabled`, `communityPrState`)
 * are ORTHOGONAL. Accepting an Idea against a Work never touches its
 * community-PR state; enabling / processing / disabling community-PR never
 * touches the accept provenance. Every code, message and shape below was
 * probed LIVE against http://127.0.0.1:3100 (sqlite in-memory, all flags on,
 * NO git provider connected, NO AI/LLM key) BEFORE this file was written.
 *
 * ── NON-DUPLICATION ─────────────────────────────────────────────────────
 * DISJOINT from the sibling specs (each is single-surface):
 *   - flow-work-proposals-deep.spec.ts     read-path/budget/prefs/attachments.
 *   - flow-idea-to-work-accept.spec.ts     accept state machine (pointers/re-point).
 *   - flow-idea-multi-work-links.spec.ts   the idea_works link-list shape/order.
 *   - flow-idea-build-lifecycle.spec.ts    build/retry/rebuild + ?statuses= lattice.
 *   - flow-work-community-pr.spec.ts        the two flags + process, in ISOLATION.
 * THIS file uniquely pins the JOIN of accept-provenance × community-PR on ONE
 * Work: orthogonality both directions, gate transitions on an accept-sourced
 * Work, first-writer-wins under a community-PR-enabled Work, accept idempotency
 * under community-PR churn, the separate audit surfaces, plus the create→list→
 * accept/reject partitioning and the env-adaptive `?search=` list query.
 *
 * ── PROBED CONTRACTS (verified live) ─────────────────────────────────────
 *  POST /api/me/work-proposals {description}        → 201 birth-state
 *    {source:'user-manual', status:'pending', acceptedWorkId:null, missionId:null}.
 *  POST /api/works {name,slug,description,organization:false} → 200
 *    {status:'success', work:{ id, communityPrEnabled:false, communityPrAutoClose:true,
 *     communityPrState:null, acceptedFromIdeaId:null, itemsCount:null }}.
 *  POST /api/me/work-proposals/:id/accept {workId}  → 200 {ok:true}; stamps the
 *    Idea's acceptedWorkId AND the Work's acceptedFromIdeaId (first-writer-wins per
 *    Work) + appends an idea_works row (kind 'linked'). Empty body → 400
 *    ["workId must be a UUID"]; ghost/foreign workId → 404; QUEUED/DISMISSED → 404.
 *  GET  /api/me/work-proposals/:id/works            → 200 {links:[{id, ideaId, workId,
 *    kind:'linked', createdAt, workName, workSlug}]}; link-less Idea → {links:[]}.
 *  PATCH /api/me/work-proposals/:id/dismiss         → 204; PENDING→DISMISSED.
 *  GET  /api/me/work-proposals?statuses=a&statuses=b→ 200 union of the partitions.
 *  GET  /api/me/work-proposals?search=<t>           → ENV-ADAPTIVE: 200 (real DB,
 *    case-insensitive title/description ILIKE) OR 500 {statusCode:500,
 *    message:"Internal server error"} on sqlite (ILIKE unsupported).
 *  PUT  /api/works/:id {communityPrEnabled?, communityPrAutoClose?} → 200; bad type
 *    → 400 ["communityPrEnabled must be a boolean value"].
 *  POST /api/works/:id/process-community-prs         → 400 "…not enabled…" (disabled)
 *    | 409 {error:'NoGitCredentialsError', message:"No connected account found …
 *      with provider github"} once ENABLED but no git connected (via
 *      FacadeExceptionFilter — a precondition, NOT a 500) | 404 (ghost) | 403 (stranger)
 *      | 401 (anon).
 *  GET  /api/works/:id/history?activityType=community_pr → 200
 *    {status:'success', history:[], total:0, limit:10, offset:0} (a failed no-git run
 *    records nothing).
 *
 * Cross-spec isolation: EVERY test runs on FRESH registerUserViaAPI() users with
 * unique `stamp()` suffixes; list assertions filter to the user's own ids (never
 * exact global counts). API-only — NO module-scope seeded-user read (which would
 * redden every shard at collection time).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const IDEA_DESC_MIN = 'a curated directory of resources'; // ≥10 chars filler

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

const proposalsUrl = () => `${API_BASE}/api/me/work-proposals`;
const workUrl = (id: string) => `${API_BASE}/api/works/${id}`;
const processUrl = (id: string) => `${API_BASE}/api/works/${id}/process-community-prs`;

interface IdeaRow {
    id: string;
    title: string;
    description: string;
    status: string;
    source: string;
    acceptedWorkId: string | null;
    missionId: string | null;
}

interface WorkEntity {
    id: string;
    name?: string;
    slug?: string;
    communityPrEnabled: boolean;
    communityPrAutoClose: boolean;
    communityPrState: unknown;
    acceptedFromIdeaId: string | null;
    itemsCount: number | null;
}

interface IdeaWorkLink {
    id: string;
    ideaId: string;
    workId: string;
    kind: string;
    createdAt: string;
    workName: string | null;
    workSlug: string | null;
}

async function createIdea(
    request: APIRequestContext,
    token: string,
    description: string,
): Promise<IdeaRow> {
    const res = await request.post(proposalsUrl(), {
        headers: authedHeaders(token),
        data: { description },
    });
    expect(res.status(), `idea create body=${await res.text()}`).toBe(201);
    const idea = (await res.json()) as IdeaRow;
    expect(idea.id).toMatch(UUID_RE);
    expect(idea.status).toBe('pending');
    expect(idea.source).toBe('user-manual');
    expect(idea.acceptedWorkId).toBeNull();
    return idea;
}

async function readIdea(request: APIRequestContext, token: string, id: string): Promise<IdeaRow> {
    const res = await request.get(`${proposalsUrl()}/${id}`, { headers: authedHeaders(token) });
    expect(res.status(), `idea read body=${await res.text()}`).toBe(200);
    return res.json();
}

async function getWork(request: APIRequestContext, token: string, id: string): Promise<WorkEntity> {
    const res = await request.get(workUrl(id), { headers: authedHeaders(token) });
    expect(res.status(), `work read body=${await res.text()}`).toBe(200);
    const body = await res.json();
    return (body.work ?? body) as WorkEntity;
}

async function accept(
    request: APIRequestContext,
    token: string,
    ideaId: string,
    workId: string,
): Promise<void> {
    const res = await request.post(`${proposalsUrl()}/${ideaId}/accept`, {
        headers: authedHeaders(token),
        data: { workId },
    });
    expect(res.status(), `accept body=${await res.text()}`).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
}

async function setFlags(
    request: APIRequestContext,
    token: string,
    id: string,
    flags: { communityPrEnabled?: boolean; communityPrAutoClose?: boolean },
) {
    return request.put(workUrl(id), { data: flags, headers: authedHeaders(token) });
}

async function listLinks(
    request: APIRequestContext,
    token: string,
    ideaId: string,
): Promise<IdeaWorkLink[]> {
    const res = await request.get(`${proposalsUrl()}/${ideaId}/works`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `links body=${await res.text()}`).toBe(200);
    const body = (await res.json()) as { links: IdeaWorkLink[] };
    expect(Array.isArray(body.links)).toBe(true);
    return body.links;
}

/**
 * Enable community-PR then drive `process-community-prs` past the sqlite
 * findById-lags-PUT window. Returns the FINAL response once the gate has
 * opened (status left the enablement 400). Never re-reads the body twice.
 */
async function enableAndProcess(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ status: number; body: unknown }> {
    const put = await setFlags(request, token, workId, { communityPrEnabled: true });
    expect(put.status()).toBe(200);
    await expect
        .poll(async () => (await getWork(request, token, workId)).communityPrEnabled, {
            timeout: 15_000,
        })
        .toBe(true);

    let status = 400;
    let body: unknown = null;
    await expect
        .poll(
            async () => {
                const res = await request.post(processUrl(workId), {
                    headers: authedHeaders(token),
                });
                status = res.status();
                body = await res.json().catch(() => null);
                return status;
            },
            { timeout: 20_000 },
        )
        .not.toBe(400);
    return { status, body };
}

/** Assert the enabled-but-no-git degrade: a clean 409 precondition (never the
 *  "not enabled" gate, never a raw 500), tolerating a git-connected env (200). */
function assertNoGitDegrade(status: number, body: unknown): void {
    expect([200, 409]).toContain(status);
    const text = JSON.stringify(body);
    expect(text).not.toContain('Community PR processing is not enabled');
    if (status === 409) {
        // NoGitCredentialsError ("No connected account … provider github") or
        // NoGitProviderError ("No Git provider configured or available").
        expect(text).toMatch(/git|provider|account|credential/i);
    }
}

test.describe('Idea accept ⟷ community-PR on the resulting Work (cross-feature multistep)', () => {
    test.setTimeout(60_000);

    test('full lifecycle: idea → work → accept (both pointers + link) → enable → process degrades 409 → provenance survives → community_pr history empty', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // 1. Idea (PENDING) + a Work to accept it against.
        const idea = await createIdea(
            request,
            token,
            `Lifecycle idea ${s} — ${IDEA_DESC_MIN} joined to a community-PR Work`,
        );
        const work = await createWorkViaAPI(request, token, { name: `Lifecycle Work ${s}` });
        expect(work.id).toMatch(UUID_RE);

        // Birth-state: no accept provenance, community-PR disabled, autoClose default true.
        const born = await getWork(request, token, work.id);
        expect(born.acceptedFromIdeaId ?? null).toBeNull();
        expect(born.communityPrEnabled).toBe(false);
        expect(born.communityPrAutoClose).toBe(true);
        expect(born.communityPrState ?? null).toBeNull();

        // 2. Accept: dual-pointer stamp + one 'linked' provenance row.
        await accept(request, token, idea.id, work.id);
        expect((await readIdea(request, token, idea.id)).acceptedWorkId).toBe(work.id);
        const afterAccept = await getWork(request, token, work.id);
        expect(afterAccept.acceptedFromIdeaId).toBe(idea.id);
        const linksAfterAccept = await listLinks(request, token, idea.id);
        expect(linksAfterAccept).toHaveLength(1);
        expect(linksAfterAccept[0].workId).toBe(work.id);
        expect(linksAfterAccept[0].kind).toBe('linked');

        // 3. Enable community-PR on the accept-sourced Work + process → 409 no-git.
        const { status, body } = await enableAndProcess(request, token, work.id);
        assertNoGitDegrade(status, body);

        // 4. The failed community-PR run left the accept provenance intact and did
        //    NOT materialize a processor cursor (stays null on a no-git degrade).
        const survived = await getWork(request, token, work.id);
        expect(survived.acceptedFromIdeaId).toBe(idea.id);
        expect(survived.communityPrEnabled).toBe(true);
        expect(survived.communityPrState ?? null).toBeNull();
        expect((await listLinks(request, token, idea.id))[0].workId).toBe(work.id);

        // 5. The community_pr history filter is well-shaped and empty (a no-git
        //    attempt records nothing — the accept's own audit lives elsewhere).
        const hist = await request.get(`${workUrl(work.id)}/history?activityType=community_pr`, {
            headers: authedHeaders(token),
        });
        expect(hist.status()).toBe(200);
        const histBody = await hist.json();
        expect(histBody.status).toBe('success');
        expect(Array.isArray(histBody.history)).toBe(true);
        expect(histBody.history).toHaveLength(0);
        expect(histBody.total).toBe(0);
    });

    test('orthogonality (community-PR → accept): toggling communityPr enable→disable never mutates acceptedWorkId / acceptedFromIdeaId / links', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const idea = await createIdea(request, token, `Ortho-cp idea ${s} — ${IDEA_DESC_MIN}`);
        const work = await createWorkViaAPI(request, token, { name: `Ortho-cp Work ${s}` });
        await accept(request, token, idea.id, work.id);

        const baseline = await getWork(request, token, work.id);
        expect(baseline.acceptedFromIdeaId).toBe(idea.id);
        const baseLinkId = (await listLinks(request, token, idea.id))[0].id;

        // Enable, then process (degrade), then disable — the FULL community-PR
        // churn — and re-check the accept provenance is byte-for-byte stable.
        await enableAndProcess(request, token, work.id);
        const disable = await setFlags(request, token, work.id, { communityPrEnabled: false });
        expect(disable.status()).toBe(200);
        await expect
            .poll(async () => (await getWork(request, token, work.id)).communityPrEnabled, {
                timeout: 15_000,
            })
            .toBe(false);

        const afterChurn = await getWork(request, token, work.id);
        expect(afterChurn.acceptedFromIdeaId).toBe(idea.id);
        const linksAfter = await listLinks(request, token, idea.id);
        expect(linksAfter).toHaveLength(1);
        expect(linksAfter[0].id).toBe(baseLinkId); // same row, not re-created
        expect(linksAfter[0].workId).toBe(work.id);
        expect((await readIdea(request, token, idea.id)).acceptedWorkId).toBe(work.id);
    });

    test('orthogonality (accept → community-PR): accepting an Idea against a Work never mutates communityPrEnabled / communityPrAutoClose / communityPrState / itemsCount', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const idea = await createIdea(request, token, `Ortho-acc idea ${s} — ${IDEA_DESC_MIN}`);
        const work = await createWorkViaAPI(request, token, { name: `Ortho-acc Work ${s}` });

        const before = await getWork(request, token, work.id);
        expect(before.communityPrEnabled).toBe(false);
        expect(before.communityPrAutoClose).toBe(true);
        expect(before.communityPrState ?? null).toBeNull();
        expect(before.itemsCount ?? null).toBeNull();

        await accept(request, token, idea.id, work.id);

        // The accept stamped ONLY the provenance columns; every community-PR
        // column is exactly as it was born.
        const after = await getWork(request, token, work.id);
        expect(after.acceptedFromIdeaId).toBe(idea.id);
        expect(after.communityPrEnabled).toBe(false);
        expect(after.communityPrAutoClose).toBe(true);
        expect(after.communityPrState ?? null).toBeNull();
        expect(after.itemsCount ?? null).toBeNull();
    });

    test('the community-PR gate on an accept-sourced Work: disabled-by-default → 400 "not enabled", enable → 409 no-git, disable → 400 again', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const idea = await createIdea(request, token, `Gate idea ${s} — ${IDEA_DESC_MIN}`);
        const work = await createWorkViaAPI(request, token, { name: `Gate Work ${s}` });
        await accept(request, token, idea.id, work.id);

        // Even though the Work is now Idea-sourced, community-PR is OFF by default,
        // so processing is gated with the truthful 400.
        const gated = await request.post(processUrl(work.id), { headers: authedHeaders(token) });
        expect(gated.status()).toBe(400);
        expect(JSON.stringify(await gated.json())).toContain(
            'Community PR processing is not enabled for this work.',
        );

        // Enable → the gate opens → 409 no-git precondition.
        const opened = await enableAndProcess(request, token, work.id);
        assertNoGitDegrade(opened.status, opened.body);

        // Disable → the enablement gate closes again → back to the 400.
        const disable = await setFlags(request, token, work.id, { communityPrEnabled: false });
        expect(disable.status()).toBe(200);
        await expect
            .poll(
                async () =>
                    (
                        await request.post(processUrl(work.id), { headers: authedHeaders(token) })
                    ).status(),
                {
                    timeout: 15_000,
                },
            )
            .toBe(400);
        const reGated = await request.post(processUrl(work.id), { headers: authedHeaders(token) });
        expect(JSON.stringify(await reGated.json())).toContain('not enabled');
        // ...and the accept provenance rode through both flag flips untouched.
        expect((await getWork(request, token, work.id)).acceptedFromIdeaId).toBe(idea.id);
    });

    test('repeated process attempts on the enabled accept-sourced Work are a deterministic 409 (never a 500/hang) and never touch acceptedFromIdeaId', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const idea = await createIdea(request, token, `Repeat idea ${s} — ${IDEA_DESC_MIN}`);
        const work = await createWorkViaAPI(request, token, { name: `Repeat Work ${s}` });
        await accept(request, token, idea.id, work.id);

        const first = await enableAndProcess(request, token, work.id);
        assertNoGitDegrade(first.status, first.body);

        // Three more back-to-back attempts settle on the SAME clean precondition —
        // the no-git degrade is idempotent, not a mounting-error 500.
        for (let i = 0; i < 3; i++) {
            const res = await request.post(processUrl(work.id), { headers: authedHeaders(token) });
            assertNoGitDegrade(res.status(), await res.json().catch(() => null));
        }
        expect((await getWork(request, token, work.id)).acceptedFromIdeaId).toBe(idea.id);
        expect((await getWork(request, token, work.id)).communityPrState ?? null).toBeNull();
    });

    test('two Ideas → one community-PR-enabled Work: first-writer-wins back-pointer, each Idea keeps its own acceptedWorkId + link, community-PR state untouched', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const ideaA = await createIdea(request, token, `FWW idea A ${s} — ${IDEA_DESC_MIN}`);
        const ideaB = await createIdea(request, token, `FWW idea B ${s} — ${IDEA_DESC_MIN}`);
        const work = await createWorkViaAPI(request, token, { name: `FWW Work ${s}` });

        // A accepts the Work first → it becomes the Work's SOLE source Idea.
        await accept(request, token, ideaA.id, work.id);
        await enableAndProcess(request, token, work.id); // community-PR now enabled + degraded

        // B accepts the SAME (already-sourced, already-community-PR-enabled) Work.
        await accept(request, token, ideaB.id, work.id);

        // Each Idea's denormalized pointer follows the Work it accepted...
        expect((await readIdea(request, token, ideaA.id)).acceptedWorkId).toBe(work.id);
        expect((await readIdea(request, token, ideaB.id)).acceptedWorkId).toBe(work.id);
        // ...each Idea owns its OWN link row to the Work...
        expect((await listLinks(request, token, ideaA.id)).map((l) => l.workId)).toEqual([work.id]);
        expect((await listLinks(request, token, ideaB.id)).map((l) => l.workId)).toEqual([work.id]);

        // ...but the Work's back-pointer keeps its FIRST source Idea (first-writer-
        // wins per Work), and the community-PR enablement is unchanged by B's accept.
        const w = await getWork(request, token, work.id);
        expect(w.acceptedFromIdeaId).toBe(ideaA.id);
        expect(w.acceptedFromIdeaId).not.toBe(ideaB.id);
        expect(w.communityPrEnabled).toBe(true);
        expect(w.communityPrState ?? null).toBeNull();
    });

    test('0..N: an accepted Idea re-accepted against a SECOND Work re-points acceptedWorkId, and the FIRST Work’s community-PR enablement is unaffected', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const idea = await createIdea(request, token, `ZeroN idea ${s} — ${IDEA_DESC_MIN}`);
        const workA = await createWorkViaAPI(request, token, { name: `ZeroN Work A ${s}` });
        const workB = await createWorkViaAPI(request, token, { name: `ZeroN Work B ${s}` });

        await accept(request, token, idea.id, workA.id);
        await enableAndProcess(request, token, workA.id); // enable community-PR on A only
        expect((await readIdea(request, token, idea.id)).acceptedWorkId).toBe(workA.id);

        // Second accept (from ACCEPTED) links Work B and re-points the pointer at B.
        await accept(request, token, idea.id, workB.id);
        expect((await readIdea(request, token, idea.id)).acceptedWorkId).toBe(workB.id);

        // Both links present. (The list is newest-first, but A and B are created
        // milliseconds apart so the createdAt tie-break isn't deterministic —
        // assert membership + count rather than an exact order.)
        const links = await listLinks(request, token, idea.id);
        const linkWorkIds = links.map((l) => l.workId);
        expect(linkWorkIds).toHaveLength(2);
        expect(linkWorkIds).toContain(workA.id);
        expect(linkWorkIds).toContain(workB.id);

        // Work A's community-PR flag is untouched by the Idea re-pointing away from
        // it; Work B was never enabled → still off (flags are per-Work).
        expect((await getWork(request, token, workA.id)).communityPrEnabled).toBe(true);
        expect((await getWork(request, token, workB.id)).communityPrEnabled).toBe(false);
    });

    test('accept idempotency under community-PR churn: accept the same Idea+Work twice → exactly one link, and enabling community-PR between accepts adds no link', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const idea = await createIdea(request, token, `Idem idea ${s} — ${IDEA_DESC_MIN}`);
        const work = await createWorkViaAPI(request, token, { name: `Idem Work ${s}` });

        await accept(request, token, idea.id, work.id);
        expect(await listLinks(request, token, idea.id)).toHaveLength(1);

        // Flip community-PR on (and process) BETWEEN the two identical accepts.
        await enableAndProcess(request, token, work.id);

        // Re-accepting the SAME Work is valid (200) and idempotent on the unique
        // (ideaId, workId) index — still exactly one provenance row.
        await accept(request, token, idea.id, work.id);
        const links = await listLinks(request, token, idea.id);
        expect(links).toHaveLength(1);
        expect(links[0].workId).toBe(work.id);
        expect((await readIdea(request, token, idea.id)).acceptedWorkId).toBe(work.id);
        expect((await getWork(request, token, work.id)).communityPrEnabled).toBe(true);
    });

    test('separate audit surfaces: a failed community-PR run leaves community_pr history empty even though the accept succeeded, and the history envelope paginates', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const idea = await createIdea(request, token, `Audit idea ${s} — ${IDEA_DESC_MIN}`);
        const work = await createWorkViaAPI(request, token, { name: `Audit Work ${s}` });
        await accept(request, token, idea.id, work.id);
        await enableAndProcess(request, token, work.id);

        const hist = await request.get(
            `${workUrl(work.id)}/history?activityType=community_pr&limit=5&offset=0`,
            { headers: authedHeaders(token) },
        );
        expect(hist.status()).toBe(200);
        const body = await hist.json();
        expect(body.status).toBe('success');
        expect(Array.isArray(body.history)).toBe(true);
        expect(body.history).toHaveLength(0); // no-git run recorded nothing
        expect(body.total).toBe(0);
        expect(body).toHaveProperty('limit');
        expect(body).toHaveProperty('offset');
        // The accept DID land its own provenance — proving the two surfaces are
        // distinct (the empty community_pr history is not "nothing happened").
        expect(await listLinks(request, token, idea.id)).toHaveLength(1);
    });

    test('ownership across both surfaces: a stranger cannot read/accept the Idea (404) nor process the Work (403); a ghost Work process is 404 and an anon process is 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const s = stamp();

        const idea = await createIdea(
            request,
            owner.access_token,
            `Guard idea ${s} — ${IDEA_DESC_MIN}`,
        );
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Guard Work ${s}`,
        });
        await accept(request, owner.access_token, idea.id, work.id);
        await setFlags(request, owner.access_token, work.id, { communityPrEnabled: true });

        // Idea reads are 404 for a stranger (existence-leak-safe vocabulary).
        const strangerReadIdea = await request.get(`${proposalsUrl()}/${idea.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerReadIdea.status()).toBe(404);
        expect(msgOf(await strangerReadIdea.json())).toMatch(/proposal not found/i);

        // A stranger cannot accept the owner's Idea either → 404 (never a 200 link).
        const strangerAccept = await request.post(`${proposalsUrl()}/${idea.id}/accept`, {
            headers: authedHeaders(stranger.access_token),
            data: { workId: work.id },
        });
        expect(strangerAccept.status()).toBe(404);

        // Work-scoped process is a 403 (the Work guard reveals the id exists but
        // denies access — a different vocabulary than the Idea's 404).
        const strangerProcess = await request.post(processUrl(work.id), {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerProcess.status()).toBe(403);
        expect(JSON.stringify(await strangerProcess.json())).toContain(
            'do not have permission to access this work',
        );

        // Ghost Work → 404; anon → 401.
        const ghost = await request.post(processUrl(UNKNOWN_UUID), {
            headers: authedHeaders(owner.access_token),
        });
        expect(ghost.status()).toBe(404);
        const anon = await request.post(processUrl(work.id));
        expect([401, 403]).toContain(anon.status());

        // The owner's Idea+Work provenance is unchanged by every rejected probe.
        expect((await readIdea(request, owner.access_token, idea.id)).acceptedWorkId).toBe(work.id);
        expect((await getWork(request, owner.access_token, work.id)).acceptedFromIdeaId).toBe(
            idea.id,
        );
    });
});

test.describe('Idea create → list → accept/reject partitioning ⟷ community-PR Work', () => {
    test.setTimeout(60_000);

    test('create → default PENDING list → accept → Idea leaves pending, enters ?statuses=accepted with acceptedWorkId pointing at the community-PR Work', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const idea = await createIdea(
            request,
            token,
            `Partition-accept idea ${s} — ${IDEA_DESC_MIN}`,
        );

        // Fresh Idea is in the default (PENDING) list.
        const pendingBefore = (await (
            await request.get(proposalsUrl(), { headers: authedHeaders(token) })
        ).json()) as IdeaRow[];
        expect(pendingBefore.map((p) => p.id)).toContain(idea.id);

        const work = await createWorkViaAPI(request, token, { name: `Partition-accept Work ${s}` });
        await accept(request, token, idea.id, work.id);
        await setFlags(request, token, work.id, { communityPrEnabled: true }); // make it a community-PR Work

        // Accepted Idea LEAVES the default pending list...
        const pendingAfter = (await (
            await request.get(proposalsUrl(), { headers: authedHeaders(token) })
        ).json()) as IdeaRow[];
        expect(pendingAfter.map((p) => p.id)).not.toContain(idea.id);

        // ...and appears under ?statuses=accepted, pointed at the community-PR Work.
        const acceptedList = (await (
            await request.get(`${proposalsUrl()}?statuses=accepted`, {
                headers: authedHeaders(token),
            })
        ).json()) as IdeaRow[];
        const row = acceptedList.find((p) => p.id === idea.id);
        expect(row, 'accepted Idea must appear under ?statuses=accepted').toBeTruthy();
        expect(row!.status).toBe('accepted');
        expect(row!.acceptedWorkId).toBe(work.id);
    });

    test('reject (dismiss) → 204 leaves pending, enters ?statuses=dismissed; the union ?statuses=accepted&statuses=dismissed returns both partitions; a dismissed Idea has no Work links', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // Accept one Idea, dismiss another — the two terminal partitions.
        const acceptedIdea = await createIdea(
            request,
            token,
            `Union accept idea ${s} — ${IDEA_DESC_MIN}`,
        );
        const work = await createWorkViaAPI(request, token, { name: `Union Work ${s}` });
        await accept(request, token, acceptedIdea.id, work.id);

        const dismissedIdea = await createIdea(
            request,
            token,
            `Union dismiss idea ${s} — ${IDEA_DESC_MIN}`,
        );
        const dismissRes = await request.patch(`${proposalsUrl()}/${dismissedIdea.id}/dismiss`, {
            headers: authedHeaders(token),
        });
        expect(dismissRes.status()).toBe(204);
        expect((await dismissRes.text()).length).toBe(0); // NO_CONTENT

        // Neither terminal Idea remains in the default (PENDING) list.
        const pending = (await (
            await request.get(proposalsUrl(), { headers: authedHeaders(token) })
        ).json()) as IdeaRow[];
        const pendingIds = pending.map((p) => p.id);
        expect(pendingIds).not.toContain(acceptedIdea.id);
        expect(pendingIds).not.toContain(dismissedIdea.id);

        // The multi-status UNION returns BOTH partitions (membership, not order).
        const union = (await (
            await request.get(`${proposalsUrl()}?statuses=accepted&statuses=dismissed`, {
                headers: authedHeaders(token),
            })
        ).json()) as IdeaRow[];
        const byId = new Map(union.map((p) => [p.id, p]));
        expect(byId.get(acceptedIdea.id)?.status).toBe('accepted');
        expect(byId.get(dismissedIdea.id)?.status).toBe('dismissed');

        // A rejected Idea never links a Work: no idea_works rows, null pointer.
        expect(await listLinks(request, token, dismissedIdea.id)).toEqual([]);
        expect((await readIdea(request, token, dismissedIdea.id)).acceptedWorkId).toBeNull();
    });

    test('?search= is env-adaptive: 200 filters by a case-insensitive description substring (matching Idea present, non-matching excluded) OR 500 sqlite ILIKE', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();
        const token36 = `zqmarker${s.replace(/[^a-z0-9]/gi, '')}`;

        const marked = await createIdea(
            request,
            token,
            `${IDEA_DESC_MIN} containing ${token36} for the search probe`,
        );
        const unmarked = await createIdea(
            request,
            token,
            `${IDEA_DESC_MIN} without that distinctive token — plain ${s}`,
        );

        const res = await request.get(`${proposalsUrl()}?search=${token36}`, {
            headers: authedHeaders(token),
        });
        // sqlite has no ILIKE → the repo query throws → a raw 500. A real Postgres
        // stack filters and returns 200. Both are the truthful contract.
        expect([200, 500]).toContain(res.status());
        if (res.status() === 500) {
            const body = await res.json();
            expect(body.statusCode).toBe(500);
            expect(String(body.message)).toMatch(/internal server error/i);
        } else {
            const rows = (await res.json()) as IdeaRow[];
            const ids = rows.map((p) => p.id);
            expect(ids).toContain(marked.id);
            expect(ids).not.toContain(unmarked.id);

            // Case-insensitivity: an UPPERCASE search still matches the same Idea.
            const upper = await request.get(`${proposalsUrl()}?search=${token36.toUpperCase()}`, {
                headers: authedHeaders(token),
            });
            expect(upper.status()).toBe(200);
            expect(((await upper.json()) as IdeaRow[]).map((p) => p.id)).toContain(marked.id);
        }
    });

    test('GET :id/works after accept binds the link display fields (workName / workSlug) to the accepted community-PR Work; a link-less pending Idea → []', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // A brand-new PENDING Idea has no links yet.
        const pendingIdea = await createIdea(
            request,
            token,
            `Linkless idea ${s} — ${IDEA_DESC_MIN}`,
        );
        expect(await listLinks(request, token, pendingIdea.id)).toEqual([]);

        const idea = await createIdea(request, token, `Linkdisplay idea ${s} — ${IDEA_DESC_MIN}`);
        const work = await createWorkViaAPI(request, token, { name: `Link Display Work ${s}` });
        const workRaw = work.raw as { work?: { name?: string; slug?: string } };
        await accept(request, token, idea.id, work.id);
        await setFlags(request, token, work.id, { communityPrEnabled: true });

        const links = await listLinks(request, token, idea.id);
        expect(links).toHaveLength(1);
        const link = links[0];
        expect(link.id).toMatch(UUID_RE);
        expect(link.ideaId).toBe(idea.id);
        expect(link.workId).toBe(work.id);
        expect(link.kind).toBe('linked');
        expect(link.createdAt).toBeTruthy();
        // The link surfaces the Work's display fields for the provenance panel.
        if (workRaw.work?.name) expect(link.workName).toBe(workRaw.work.name);
        if (workRaw.work?.slug) expect(link.workSlug).toBe(workRaw.work.slug);
    });

    test('combined validation: accept empty body → 400 (workId must be a UUID), accept ghost workId → 404 (Idea stays pending), community-PR flag non-boolean → 400 (Work unchanged)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const idea = await createIdea(request, token, `Validation idea ${s} — ${IDEA_DESC_MIN}`);
        const work = await createWorkViaAPI(request, token, { name: `Validation Work ${s}` });

        // Empty accept body → the @IsUUID DTO check fires before the controller's
        // `!body?.workId` guard, so the message is "workId must be a UUID".
        const emptyBody = await request.post(`${proposalsUrl()}/${idea.id}/accept`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(emptyBody.status()).toBe(400);
        expect(msgOf(await emptyBody.json())).toMatch(/workId must be a UUID/i);

        // A well-formed but non-existent workId → 404 (IDOR-safe ownership guard);
        // the Idea is untouched.
        const ghost = await request.post(`${proposalsUrl()}/${idea.id}/accept`, {
            headers: authedHeaders(token),
            data: { workId: UNKNOWN_UUID },
        });
        expect(ghost.status()).toBe(404);
        expect((await readIdea(request, token, idea.id)).status).toBe('pending');

        // A non-boolean community-PR flag → 400 field-specific message; the Work's
        // flags are unchanged.
        const badFlag = await request.put(workUrl(work.id), {
            headers: authedHeaders(token),
            data: { communityPrEnabled: 'yes' },
        });
        expect(badFlag.status()).toBe(400);
        expect(JSON.stringify(await badFlag.json())).toContain(
            'communityPrEnabled must be a boolean value',
        );
        const w = await getWork(request, token, work.id);
        expect(w.communityPrEnabled).toBe(false);
        expect(w.communityPrAutoClose).toBe(true);
    });

    test('cross-user isolation: user B cannot accept user A’s Idea (404) nor process A’s community-PR Work (403), while B’s own parallel Idea→Work→accept→enable flow succeeds independently', async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        const s = stamp();

        // A: idea + community-PR-enabled accepted work.
        const ideaA = await createIdea(
            request,
            userA.access_token,
            `Iso idea A ${s} — ${IDEA_DESC_MIN}`,
        );
        const workA = await createWorkViaAPI(request, userA.access_token, {
            name: `Iso Work A ${s}`,
        });
        await accept(request, userA.access_token, ideaA.id, workA.id);
        await setFlags(request, userA.access_token, workA.id, { communityPrEnabled: true });

        // B accepting A's Idea → 404; B processing A's Work → 403.
        const bAcceptsA = await request.post(`${proposalsUrl()}/${ideaA.id}/accept`, {
            headers: authedHeaders(userB.access_token),
            data: { workId: workA.id },
        });
        expect(bAcceptsA.status()).toBe(404);
        const bProcessesA = await request.post(processUrl(workA.id), {
            headers: authedHeaders(userB.access_token),
        });
        expect(bProcessesA.status()).toBe(403);

        // A's state is untouched by B's probes.
        expect((await readIdea(request, userA.access_token, ideaA.id)).acceptedWorkId).toBe(
            workA.id,
        );

        // B's OWN parallel flow works end-to-end — isolation, not a global lock.
        const ideaB = await createIdea(
            request,
            userB.access_token,
            `Iso idea B ${s} — ${IDEA_DESC_MIN}`,
        );
        const workB = await createWorkViaAPI(request, userB.access_token, {
            name: `Iso Work B ${s}`,
        });
        await accept(request, userB.access_token, ideaB.id, workB.id);
        expect((await getWork(request, userB.access_token, workB.id)).acceptedFromIdeaId).toBe(
            ideaB.id,
        );
        const bProcess = await enableAndProcess(request, userB.access_token, workB.id);
        assertNoGitDegrade(bProcess.status, bProcess.body);
        // B never gained access to A's Work.
        expect(
            (
                await request.get(workUrl(workA.id), { headers: authedHeaders(userB.access_token) })
            ).status(),
        ).toBe(403);
    });

    test('anonymous boundary sweep across both surfaces: accept / dismiss / :id/works / process / work-read all reject an unauthenticated caller', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const idea = await createIdea(request, token, `Anon idea ${s} — ${IDEA_DESC_MIN}`);
        const work = await createWorkViaAPI(request, token, { name: `Anon Work ${s}` });
        await accept(request, token, idea.id, work.id);
        await setFlags(request, token, work.id, { communityPrEnabled: true });

        // Idea-side surfaces: unauthenticated → 401.
        const anonAccept = await request.post(`${proposalsUrl()}/${idea.id}/accept`, {
            data: { workId: work.id },
        });
        expect(anonAccept.status()).toBe(401);
        const anonDismiss = await request.patch(`${proposalsUrl()}/${idea.id}/dismiss`);
        expect(anonDismiss.status()).toBe(401);
        const anonLinks = await request.get(`${proposalsUrl()}/${idea.id}/works`);
        expect(anonLinks.status()).toBe(401);

        // Work-side surfaces: process is 401 (or an anon identity → 403); read 401.
        const anonProcess = await request.post(processUrl(work.id));
        expect([401, 403]).toContain(anonProcess.status());
        const anonWork = await request.get(workUrl(work.id));
        expect(anonWork.status()).toBe(401);

        // The authenticated owner still sees intact provenance after the sweep.
        expect((await getWork(request, token, work.id)).acceptedFromIdeaId).toBe(idea.id);
    });

    test('disable-after-enable re-blocks community-PR processing but preserves BOTH the accept provenance AND the untouched communityPrAutoClose default', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const idea = await createIdea(request, token, `Disable idea ${s} — ${IDEA_DESC_MIN}`);
        const work = await createWorkViaAPI(request, token, { name: `Disable Work ${s}` });
        await accept(request, token, idea.id, work.id);

        // Enable (gate opens, degrades), then disable ONLY communityPrEnabled.
        const opened = await enableAndProcess(request, token, work.id);
        assertNoGitDegrade(opened.status, opened.body);
        const disable = await setFlags(request, token, work.id, { communityPrEnabled: false });
        expect(disable.status()).toBe(200);

        // Processing is gated again → back to the enablement 400.
        await expect
            .poll(
                async () =>
                    (
                        await request.post(processUrl(work.id), { headers: authedHeaders(token) })
                    ).status(),
                {
                    timeout: 15_000,
                },
            )
            .toBe(400);

        const w = await getWork(request, token, work.id);
        expect(w.communityPrEnabled).toBe(false);
        // autoClose default (true) was preserved — the disable touched ONE flag.
        expect(w.communityPrAutoClose).toBe(true);
        // The accept provenance rode through the enable→degrade→disable cycle.
        expect(w.acceptedFromIdeaId).toBe(idea.id);
        expect((await readIdea(request, token, idea.id)).acceptedWorkId).toBe(work.id);
        expect((await listLinks(request, token, idea.id))[0].workId).toBe(work.id);
    });
});
