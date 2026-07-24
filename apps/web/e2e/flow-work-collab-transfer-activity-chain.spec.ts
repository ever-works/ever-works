import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Work collaboration chain — member actions emit ATTRIBUTED activity, and the
 * two activity views diverge (deep, multi-step, cross-feature).
 *
 * THEME: owner builds a roster → each member acts at their tier → those actions
 * are recorded as activity → authority is transferred (promote/demote) and
 * revoked (remove) → we verify the activity feed, the membership, and the
 * permissions ACROSS the whole chain, from BOTH activity vantage points.
 *
 * ── WHY THIS IS A NEW CHAIN (non-duplication) ───────────────────────────────
 * The member/RBAC + activity surfaces already have heavy coverage, but each
 * sibling drills a different seam and NONE of them join member-management to the
 * activity pipeline or contrast the two activity views:
 *   - flow-work-members-rbac-deep / flow-work-member-removal: the members
 *     controller CRUD + RBAC gates + IDOR — but never assert that PUT-role /
 *     DELETE / invite EMIT activity rows, nor who they're attributed to.
 *   - flow-work-collab-activity: activity feed ordering / CSV export /
 *     immutability — but ONLY for a single owner actor doing work_created /
 *     work_updated. It never exercises member_* activity, multi-actor
 *     attribution, or the feed-vs-log duality.
 *   - flow-work-transfer-ownership: the owner-claim repo-handoff ceremony —
 *     a different "transfer" (git repo, not in-app authority).
 * This file pins the STILL-UNCOVERED seam: member management is itself an
 * activity source, every actor's action is attributed to THEM, and the per-Work
 * feed and the per-user log are two genuinely different projections of it.
 *
 * ── PROBED CONTRACT (verified live @ 127.0.0.1:3100, sqlite in-memory CI driver,
 *    all flags ON, before any assertion was written) ─────────────────────────
 *
 *   Activity EMISSION (every row scoped to workId, attributed to the ACTOR):
 *     - POST   /works/:id/members         → `member_invited`   action 'member.invited'
 *         summary "Invited <email> as <role> to <workName>", actor = inviter
 *         (written asynchronously via a MemberInvitedEvent listener → POLL).
 *     - PUT    /works/:id/members/:mid     → `member_role_changed` action
 *         'member.role_changed', summary "Changed member role to <role>",
 *         details { memberId, role }, actor = the manager/owner who changed it.
 *     - DELETE /works/:id/members/:mid     → `member_removed`  action
 *         'member.removed', summary "Removed member from work",
 *         details { memberId }, actor = the remover.
 *     - PATCH  /works/:id                  → `work_updated` action 'work.updated'
 *         summary "Updated work settings", actor = the editor/owner who patched.
 *     (member_role_changed / member_removed are fire-and-forget `.log().catch()`
 *      in the controller; member_invited is event-driven → ALL activity-presence
 *      assertions POLL to absorb the async write.)
 *
 *   TWO VIEWS OF THE SAME ROWS — the crux of this suite:
 *     GET /api/works/:id/activity-feed  (per-WORK projection)
 *       · gated by CURRENT membership (WorkOwnershipService.ensureAccess): any
 *         member OR the creator → 200; a stranger → 403; no-auth → 401; malformed
 *         id → 400; unknown-but-valid uuid → 404.
 *       · surfaces EVERY actor's row (owner + editor + manager), deliberately
 *         bypassing the per-user filter.
 *       · HIDES the actor — PlatformActivityLogEntry = { id, source, type,
 *         category, timestamp, summary, status, details }; NO userId.
 *       · APPEND-ONLY: a removed member's rows survive in the owner's feed.
 *       · payload { entries, nextCursor, serverTime[, degraded] }; limit 1-200
 *         (0 / 201+ → 400); category ∈ FEED_CATEGORIES ('bogus' → 400).
 *       · CATEGORY QUIRK (pinned): member_* rows render category:'settings' under
 *         category=all, but category=settings FILTERS THEM OUT (the settings
 *         allow-list has work_created/work_updated but NOT member_*), so a
 *         settings-filtered feed returns only the work_* rows.
 *     GET /api/activity-log?workId=:id  (per-USER projection)
 *       · self-scoped by the caller's userId AND workId → each actor sees ONLY
 *         their OWN rows for the work (owner: create + invites; manager:
 *         role-change + remove; editor: update). NOT membership-gated: a
 *         non-member gets 200 { activities:[], total:0 }, and a REMOVED member
 *         still reads their own historical rows (the audit trail follows the
 *         USER, not the membership).
 *
 *   AUTHORITY transfer within the roster (in-app, distinct from owner-claim):
 *     - promote viewer→manager ⇒ the promoted member can now manage members
 *       (PUT-role) where a viewer got 403; demote manager→viewer ⇒ they lose it.
 *     - an editor may PATCH content (work_updated) but NOT change a role (403).
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * Every test builds FRESH registerUserViaAPI() actors + a FRESH work (never the
 * shared seeded user). Unique suffixes via a per-test counter. Fully
 * API-orchestrated (safe `flow-` prefix). List assertions use toContain /
 * not.toContain on ids/types — never global counts. Async activity writes are
 * awaited via expect.poll, not fixed sleeps.
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let seq = 0;
function uniq(tag: string): string {
    seq += 1;
    return `${tag}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

type AssignableRole = 'viewer' | 'editor' | 'manager';

interface MemberRow {
    id: string;
    userId: string;
    email: string;
    role: string;
}

interface ActivityRow {
    id: string;
    userId: string;
    workId: string | null;
    actionType: string;
    action: string;
    status: string;
    summary: string;
    details?: Record<string, unknown> | null;
    createdAt: string;
}

interface FeedEntry {
    id: string;
    source: string;
    type: string;
    category: string;
    timestamp: string;
    summary: string;
    status?: string;
    details?: Record<string, unknown> | null;
}

interface FeedResponse {
    entries: FeedEntry[];
    nextCursor?: string | null;
    serverTime: string;
}

/** Owner/manager invites (= synchronously adds) an already-registered user. */
async function invite(
    request: APIRequestContext,
    callerToken: string,
    workId: string,
    email: string,
    role: AssignableRole,
): Promise<MemberRow> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/members`, {
        headers: authedHeaders(callerToken),
        data: { email, role },
    });
    expect(res.status(), `invite ${email} as ${role} → ${await res.text().catch(() => '')}`).toBe(
        201,
    );
    return (await res.json()).member as MemberRow;
}

/** PATCH the work content (emits work_updated attributed to the caller). */
async function patchWork(
    request: APIRequestContext,
    token: string,
    workId: string,
    data: Record<string, unknown>,
): Promise<number> {
    const res = await request.patch(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
        data,
    });
    return res.status();
}

async function putRole(
    request: APIRequestContext,
    token: string,
    workId: string,
    memberId: string,
    role: AssignableRole,
): Promise<number> {
    const res = await request.put(`${API_BASE}/api/works/${workId}/members/${memberId}`, {
        headers: authedHeaders(token),
        data: { role },
    });
    return res.status();
}

async function removeMember(
    request: APIRequestContext,
    token: string,
    workId: string,
    memberId: string,
): Promise<number> {
    const res = await request.delete(`${API_BASE}/api/works/${workId}/members/${memberId}`, {
        headers: authedHeaders(token),
    });
    return res.status();
}

async function getFeedRaw(request: APIRequestContext, token: string, workId: string, query = '') {
    return request.get(`${API_BASE}/api/works/${workId}/activity-feed${query}`, {
        headers: authedHeaders(token),
    });
}

async function getFeed(
    request: APIRequestContext,
    token: string,
    workId: string,
    query = '',
): Promise<FeedResponse> {
    const res = await getFeedRaw(request, token, workId, query);
    expect(res.status(), `feed ${query} → ${await res.text().catch(() => '')}`).toBe(200);
    const body = (await res.json()) as FeedResponse;
    expect(Array.isArray(body.entries)).toBe(true);
    expect(typeof body.serverTime).toBe('string');
    return body;
}

/** Platform-activity-log entries only (drops generation-history / directory). */
function platformEntries(feed: FeedResponse): FeedEntry[] {
    return feed.entries.filter((e) => e.source === 'platform-activity-log');
}

async function listLog(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ activities: ActivityRow[]; total: number; status: number }> {
    const res = await request.get(`${API_BASE}/api/activity-log${query}`, {
        headers: authedHeaders(token),
    });
    if (!res.ok()) return { activities: [], total: 0, status: res.status() };
    const body = await res.json();
    return { activities: body.activities ?? [], total: body.total ?? 0, status: res.status() };
}

/** Poll the per-Work feed until every requested actionType is present. */
async function pollFeedHasTypes(
    request: APIRequestContext,
    token: string,
    workId: string,
    types: string[],
    timeout = 20_000,
): Promise<void> {
    await expect
        .poll(
            async () => {
                const feed = await getFeed(request, token, workId);
                const present = new Set(platformEntries(feed).map((e) => e.type));
                return types.every((t) => present.has(t));
            },
            { timeout, message: `feed should surface ${types.join(', ')}` },
        )
        .toBe(true);
}

/** Poll a user's workId-scoped log until it contains a row matching predicate. */
async function pollLogHasRow(
    request: APIRequestContext,
    token: string,
    workId: string,
    predicate: (r: ActivityRow) => boolean,
    timeout = 20_000,
): Promise<ActivityRow> {
    let found: ActivityRow | undefined;
    await expect
        .poll(
            async () => {
                const { activities } = await listLog(request, token, `?workId=${workId}`);
                found = activities.find(predicate);
                return Boolean(found);
            },
            { timeout, message: 'activity-log row should appear' },
        )
        .toBe(true);
    return found!;
}

// ── A. Member actions emit ATTRIBUTED activity rows ─────────────────────────
test.describe('Collaboration chain — member actions emit attributed activity', () => {
    test('owner invites emit member_invited rows attributed to the owner, one per invite', async ({
        request,
    }) => {
        const tag = uniq('invite-emit');
        const owner = await registerUserViaAPI(request);
        const m1 = await registerUserViaAPI(request);
        const m2 = await registerUserViaAPI(request);
        const workName = `Invite Emit ${tag}`;
        const work = await createWorkViaAPI(request, owner.access_token, { name: workName });

        await invite(request, owner.access_token, work.id, m1.email, 'editor');
        await invite(request, owner.access_token, work.id, m2.email, 'viewer');

        // The owner's self-scoped log gains exactly the create + the two invites.
        await pollLogHasRow(
            request,
            owner.access_token,
            work.id,
            (r) => r.actionType === 'member_invited' && r.summary.includes(m2.email),
        );
        const { activities } = await listLog(request, owner.access_token, `?workId=${work.id}`);
        const invites = activities.filter((r) => r.actionType === 'member_invited');
        expect(invites.length, 'two invite rows').toBe(2);
        for (const r of invites) {
            expect(r.action).toBe('member.invited');
            expect(r.userId, 'invite attributed to the owner').toBe(owner.user.id);
            expect(r.workId).toBe(work.id);
            expect(r.summary).toContain(workName);
        }
        // Summary encodes the invitee email + the granted role.
        const editorInvite = invites.find((r) => r.summary.includes(m1.email))!;
        expect(editorInvite.summary).toMatch(/as editor to/i);
        const viewerInvite = invites.find((r) => r.summary.includes(m2.email))!;
        expect(viewerInvite.summary).toMatch(/as viewer to/i);
    });

    test('a manager role-change emits member_role_changed attributed to the MANAGER, not the owner', async ({
        request,
    }) => {
        const tag = uniq('role-emit');
        const owner = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const target = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `RoleEmit ${tag}`,
        });

        await invite(request, owner.access_token, work.id, manager.email, 'manager');
        const targetRow = await invite(
            request,
            owner.access_token,
            work.id,
            target.email,
            'editor',
        );

        // The MANAGER (not the owner) demotes the editor to viewer.
        expect(await putRole(request, manager.access_token, work.id, targetRow.id, 'viewer')).toBe(
            200,
        );

        // The row lands in the MANAGER's self-scoped log, attributed to them.
        const row = await pollLogHasRow(
            request,
            manager.access_token,
            work.id,
            (r) => r.actionType === 'member_role_changed',
        );
        expect(row.action).toBe('member.role_changed');
        expect(row.userId, 'attributed to the manager who acted').toBe(manager.user.id);
        expect(row.status).toBe('completed');
        expect(row.summary).toBe('Changed member role to viewer');
        expect(row.details).toMatchObject({ memberId: targetRow.id, role: 'viewer' });

        // The OWNER's self-scoped log does NOT carry the manager's action — the
        // per-user projection is genuinely partitioned by actor.
        const ownerLog = await listLog(request, owner.access_token, `?workId=${work.id}`);
        expect(
            ownerLog.activities.some((r) => r.actionType === 'member_role_changed'),
            "owner's own log excludes the manager's role change",
        ).toBe(false);
    });

    test('a manager removal emits member_removed attributed to the remover with the member id', async ({
        request,
    }) => {
        const tag = uniq('remove-emit');
        const owner = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const target = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `RemoveEmit ${tag}`,
        });

        await invite(request, owner.access_token, work.id, manager.email, 'manager');
        const targetRow = await invite(
            request,
            owner.access_token,
            work.id,
            target.email,
            'viewer',
        );

        expect(await removeMember(request, manager.access_token, work.id, targetRow.id)).toBe(200);

        const row = await pollLogHasRow(
            request,
            manager.access_token,
            work.id,
            (r) => r.actionType === 'member_removed',
        );
        expect(row.action).toBe('member.removed');
        expect(row.userId, 'attributed to the remover').toBe(manager.user.id);
        expect(row.summary).toBe('Removed member from work');
        expect(row.details).toMatchObject({ memberId: targetRow.id });
    });

    test('an editor content edit emits work_updated attributed to the EDITOR, not the creator', async ({
        request,
    }) => {
        const tag = uniq('edit-attr');
        const owner = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `EditAttr ${tag}`,
        });
        await invite(request, owner.access_token, work.id, editor.email, 'editor');

        // The editor mutates content → the work_updated row is theirs.
        expect(
            await patchWork(request, editor.access_token, work.id, { description: 'by editor' }),
        ).toBe(200);

        const row = await pollLogHasRow(
            request,
            editor.access_token,
            work.id,
            (r) => r.actionType === 'work_updated',
        );
        expect(row.action).toBe('work.updated');
        expect(row.userId, 'work_updated attributed to the acting editor').toBe(editor.user.id);
        expect(row.workId).toBe(work.id);

        // The creator's own log carries the create, but NOT the editor's update.
        const ownerLog = await listLog(request, owner.access_token, `?workId=${work.id}`);
        expect(ownerLog.activities.some((r) => r.actionType === 'work_created')).toBe(true);
        expect(
            ownerLog.activities.some((r) => r.actionType === 'work_updated'),
            "creator's log excludes the editor's edit",
        ).toBe(false);
    });
});

// ── B. Feed vs per-user log — the two-view duality ──────────────────────────
test.describe('Collaboration chain — feed (per-Work) vs log (per-user) duality', () => {
    test('the activity-feed surfaces EVERY actor’s row; the per-user log shows only your own', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const tag = uniq('duality');
        const owner = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Duality ${tag}`,
        });

        await invite(request, owner.access_token, work.id, manager.email, 'manager');
        const editorRow = await invite(
            request,
            owner.access_token,
            work.id,
            editor.email,
            'editor',
        );
        expect(
            await patchWork(request, editor.access_token, work.id, { description: 'e-edit' }),
        ).toBe(200);
        expect(await putRole(request, manager.access_token, work.id, editorRow.id, 'viewer')).toBe(
            200,
        );

        // The per-WORK feed collects all six platform rows across three actors.
        await pollFeedHasTypes(request, owner.access_token, work.id, [
            'work_created',
            'member_invited',
            'work_updated',
            'member_role_changed',
        ]);
        const feed = await getFeed(request, owner.access_token, work.id);
        const feedTypes = platformEntries(feed).map((e) => e.type);
        expect(feedTypes).toContain('work_created');
        expect(feedTypes).toContain('member_invited');
        expect(feedTypes).toContain('work_updated');
        expect(feedTypes).toContain('member_role_changed');

        // The three per-USER logs partition those same rows by actor — and their
        // union exactly reconstructs the feed's platform-log rows.
        const ownerLog = await listLog(request, owner.access_token, `?workId=${work.id}`);
        const managerLog = await listLog(request, manager.access_token, `?workId=${work.id}`);
        const editorLog = await listLog(request, editor.access_token, `?workId=${work.id}`);

        // owner = create + 2 invites; manager = 1 role-change; editor = 1 update.
        expect(ownerLog.activities.every((r) => r.userId === owner.user.id)).toBe(true);
        expect(managerLog.activities.every((r) => r.userId === manager.user.id)).toBe(true);
        expect(editorLog.activities.every((r) => r.userId === editor.user.id)).toBe(true);
        expect(managerLog.activities.map((r) => r.actionType)).toContain('member_role_changed');
        expect(editorLog.activities.map((r) => r.actionType)).toContain('work_updated');

        const union = ownerLog.total + managerLog.total + editorLog.total;
        expect(union, 'per-user partitions reconstruct the per-Work feed').toBe(
            platformEntries(feed).length,
        );
    });

    test('feed entries HIDE the actor (no userId) while the per-user log EXPOSES it', async ({
        request,
    }) => {
        const tag = uniq('actor-hidden');
        const owner = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `Hidden ${tag}` });
        await invite(request, owner.access_token, work.id, editor.email, 'editor');
        await patchWork(request, editor.access_token, work.id, { description: 'x' });

        await pollFeedHasTypes(request, owner.access_token, work.id, ['work_updated']);
        const feed = await getFeed(request, owner.access_token, work.id);
        for (const e of platformEntries(feed)) {
            // The feed projection is a strict allow-list — the actor never leaks.
            expect(e, 'feed entry hides userId').not.toHaveProperty('userId');
            expect(e).not.toHaveProperty('actorId');
            expect(e).not.toHaveProperty('userEmail');
            expect(e.id).toMatch(UUID_RE);
            expect(e.source).toBe('platform-activity-log');
            expect(typeof e.summary).toBe('string');
            expect(typeof e.timestamp).toBe('string');
        }
        // The per-user log, by contrast, always carries the actor id.
        const { activities } = await listLog(request, owner.access_token, `?workId=${work.id}`);
        expect(activities.length).toBeGreaterThan(0);
        for (const r of activities) expect(r.userId).toBe(owner.user.id);
    });

    test('a non-member gets an EMPTY per-user log (not 403) but is walled off the feed (403)', async ({
        request,
    }) => {
        const tag = uniq('nonmember-views');
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `NonMember ${tag}`,
        });
        await patchWork(request, owner.access_token, work.id, { description: 'seed' });

        // The per-user log is self-scoped, NOT membership-gated: a stranger simply
        // has zero rows for this work → 200 with an empty list (never 403).
        const strangerLog = await listLog(request, stranger.access_token, `?workId=${work.id}`);
        expect(strangerLog.status, 'log is self-scoped, not gated → 200').toBe(200);
        expect(strangerLog.total, 'stranger has no rows for this work').toBe(0);

        // The per-Work feed IS membership-gated → the same stranger is 403.
        const feedRes = await getFeedRaw(request, stranger.access_token, work.id);
        expect(feedRes.status(), 'stranger cannot read the per-Work feed').toBe(403);
        expect(String((await feedRes.json()).message)).toMatch(/do not have permission/i);
    });
});

// ── C. RBAC authority is transferable and revocable within the roster ───────
test.describe('Collaboration chain — authority transfer within the roster', () => {
    test('promote viewer→manager grants manage-members power the viewer did not have', async ({
        request,
    }) => {
        const tag = uniq('promote');
        const owner = await registerUserViaAPI(request);
        const promotee = await registerUserViaAPI(request);
        const bystander = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Promote ${tag}`,
        });

        const promoteeRow = await invite(
            request,
            owner.access_token,
            work.id,
            promotee.email,
            'viewer',
        );
        const bystanderRow = await invite(
            request,
            owner.access_token,
            work.id,
            bystander.email,
            'editor',
        );

        // As a VIEWER, the promotee cannot change a peer's role → 403.
        expect(
            await putRole(request, promotee.access_token, work.id, bystanderRow.id, 'viewer'),
            'viewer lacks manage-members',
        ).toBe(403);

        // Owner promotes them to MANAGER (the authority transfer).
        expect(await putRole(request, owner.access_token, work.id, promoteeRow.id, 'manager')).toBe(
            200,
        );

        // NOW the promotee CAN manage members — the same call that just 403'd now 200s.
        expect(
            await putRole(request, promotee.access_token, work.id, bystanderRow.id, 'viewer'),
            'promoted manager can manage members',
        ).toBe(200);

        // The promotion emitted its own member_role_changed row (owner-attributed).
        const row = await pollLogHasRow(
            request,
            owner.access_token,
            work.id,
            (r) =>
                r.actionType === 'member_role_changed' &&
                (r.details as { memberId?: string } | null)?.memberId === promoteeRow.id,
        );
        expect(row.summary).toBe('Changed member role to manager');
    });

    test('demote manager→viewer revokes manage-members power (authority is not permanent)', async ({
        request,
    }) => {
        const tag = uniq('demote');
        const owner = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const peer = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `Demote ${tag}` });

        const managerRow = await invite(
            request,
            owner.access_token,
            work.id,
            manager.email,
            'manager',
        );
        const peerRow = await invite(request, owner.access_token, work.id, peer.email, 'editor');

        // While a manager, they can change a peer role → 200.
        expect(await putRole(request, manager.access_token, work.id, peerRow.id, 'viewer')).toBe(
            200,
        );

        // Owner demotes the manager to viewer.
        expect(await putRole(request, owner.access_token, work.id, managerRow.id, 'viewer')).toBe(
            200,
        );

        // The demoted member has LOST the authority — the same peer change now 403s.
        expect(
            await putRole(request, manager.access_token, work.id, peerRow.id, 'editor'),
            'demoted viewer can no longer manage members',
        ).toBe(403);

        // The peer's role is whatever it was before the denied call (unchanged by 403).
        const feed = await getFeed(request, owner.access_token, work.id);
        expect(feed.entries.length).toBeGreaterThan(0);
    });

    test('an editor may PATCH content but NOT change a member role (the content/authority split)', async ({
        request,
    }) => {
        const tag = uniq('split');
        const owner = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const peer = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `Split ${tag}` });

        await invite(request, owner.access_token, work.id, editor.email, 'editor');
        const peerRow = await invite(request, owner.access_token, work.id, peer.email, 'viewer');

        // Content mutation is allowed for an editor → 200 (and emits work_updated).
        expect(
            await patchWork(request, editor.access_token, work.id, { description: 'edit ok' }),
        ).toBe(200);
        // Role management is NOT → 403 "required permission level".
        const roleAttempt = await request.put(
            `${API_BASE}/api/works/${work.id}/members/${peerRow.id}`,
            { headers: authedHeaders(editor.access_token), data: { role: 'editor' } },
        );
        expect(roleAttempt.status(), 'editor cannot manage roles').toBe(403);
        expect(String((await roleAttempt.json()).message)).toMatch(/required permission level/i);

        // Only the successful content edit surfaces in the editor's own log.
        const row = await pollLogHasRow(
            request,
            editor.access_token,
            work.id,
            (r) => r.actionType === 'work_updated',
        );
        expect(row.action).toBe('work.updated');
        const editorLog = await listLog(request, editor.access_token, `?workId=${work.id}`);
        expect(editorLog.activities.some((r) => r.actionType === 'member_role_changed')).toBe(
            false,
        );
    });
});

// ── D. Activity-feed access, category + pagination contract ─────────────────
test.describe('Collaboration chain — feed access, category + pagination', () => {
    test('feed access matrix: creator + every member tier 200; stranger 403; no-auth 401', async ({
        request,
    }) => {
        const tag = uniq('access-matrix');
        const owner = await registerUserViaAPI(request);
        const viewer = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `AccessMatrix ${tag}`,
        });

        await invite(request, owner.access_token, work.id, viewer.email, 'viewer');
        await invite(request, owner.access_token, work.id, editor.email, 'editor');
        await invite(request, owner.access_token, work.id, manager.email, 'manager');

        // Any membership tier (and the creator) can read the feed — ensureAccess
        // passes for ANY member, no minimum role.
        for (const [who, tok] of [
            ['owner', owner.access_token],
            ['viewer', viewer.access_token],
            ['editor', editor.access_token],
            ['manager', manager.access_token],
        ] as const) {
            const res = await getFeedRaw(request, tok, work.id);
            expect(res.status(), `${who} reads feed`).toBe(200);
        }
        // A non-member is denied.
        expect((await getFeedRaw(request, stranger.access_token, work.id)).status()).toBe(403);
        // No auth at all → 401.
        expect((await request.get(`${API_BASE}/api/works/${work.id}/activity-feed`)).status()).toBe(
            401,
        );
    });

    test('category quirk: member_* rows render category:"settings" but are FILTERED OUT by category=settings', async ({
        request,
    }) => {
        const tag = uniq('cat-quirk');
        const owner = await registerUserViaAPI(request);
        const target = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `CatQuirk ${tag}`,
        });
        const targetRow = await invite(
            request,
            owner.access_token,
            work.id,
            target.email,
            'editor',
        );
        expect(await putRole(request, owner.access_token, work.id, targetRow.id, 'viewer')).toBe(
            200,
        );

        // Under category=all, the member_* rows carry category:'settings'.
        await pollFeedHasTypes(request, owner.access_token, work.id, [
            'member_invited',
            'member_role_changed',
        ]);
        const all = await getFeed(request, owner.access_token, work.id);
        const memberRows = platformEntries(all).filter((e) => e.type.startsWith('member_'));
        expect(memberRows.length, 'member_* rows present under all').toBeGreaterThanOrEqual(2);
        for (const e of memberRows) {
            expect(e.category, 'member_* rows render as settings').toBe('settings');
        }

        // BUT the settings FILTER allow-list omits member_* types, so a
        // settings-filtered feed returns ONLY the work_* rows — never member_*.
        const settings = await getFeed(request, owner.access_token, work.id, '?category=settings');
        const settingsTypes = platformEntries(settings).map((e) => e.type);
        expect(settingsTypes).toContain('work_created');
        expect(settingsTypes, 'member_invited filtered out of settings').not.toContain(
            'member_invited',
        );
        expect(settingsTypes, 'member_role_changed filtered out of settings').not.toContain(
            'member_role_changed',
        );
    });

    test('empty categories return no entries; a bogus category is a 400', async ({ request }) => {
        const tag = uniq('cat-empty');
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `CatEmpty ${tag}`,
        });
        await patchWork(request, owner.access_token, work.id, { description: 'seed' });

        // No generation / items on a fresh work → those chips are empty.
        for (const cat of ['items', 'generation', 'deployment', 'comparisons'] as const) {
            const feed = await getFeed(request, owner.access_token, work.id, `?category=${cat}`);
            expect(feed.entries.length, `category=${cat} is empty`).toBe(0);
        }
        // An unknown category value is rejected by the enum validator.
        const bogus = await getFeedRaw(request, owner.access_token, work.id, '?category=bogus');
        expect(bogus.status(), 'category=bogus → 400').toBe(400);
    });

    test('feed pagination: limit bounds enforced (0/201→400); a full page yields a cursor', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const tag = uniq('paginate');
        const owner = await registerUserViaAPI(request);
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Paginate ${tag}`,
        });
        await invite(request, owner.access_token, work.id, a.email, 'editor');
        await invite(request, owner.access_token, work.id, b.email, 'viewer');

        // Wait for a healthy multi-row history to exist.
        await pollFeedHasTypes(request, owner.access_token, work.id, [
            'work_created',
            'member_invited',
        ]);

        // limit bounds: 0 and 201 are rejected (valid range 1-200).
        expect((await getFeedRaw(request, owner.access_token, work.id, '?limit=0')).status()).toBe(
            400,
        );
        expect(
            (await getFeedRaw(request, owner.access_token, work.id, '?limit=201')).status(),
        ).toBe(400);

        // A page smaller than the row count is exactly `limit` long and yields a
        // nextCursor to page older; a large page returns everything with no cursor.
        const page = await getFeed(request, owner.access_token, work.id, '?limit=2');
        expect(page.entries.length).toBe(2);
        expect(page.nextCursor, 'a full page hands back a cursor').toBeTruthy();

        const full = await getFeed(request, owner.access_token, work.id, '?limit=200');
        expect(full.entries.length).toBeGreaterThanOrEqual(3);
        expect(full.nextCursor, 'a non-full page has no cursor').toBeFalsy();
        // The cursor is honoured: paging past the newest row drops it from the tail.
        const older = await getFeed(
            request,
            owner.access_token,
            work.id,
            `?limit=200&cursor=${encodeURIComponent(String(page.entries[1].timestamp))}`,
        );
        expect(older.entries.length).toBeLessThanOrEqual(full.entries.length);
    });

    test('feed id validation: malformed uuid 400, unknown-but-valid uuid 404, no-auth 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const H = authedHeaders(owner.access_token);
        // Malformed id trips ParseUUIDPipe before the ownership gate.
        expect(
            (
                await request.get(`${API_BASE}/api/works/not-a-uuid/activity-feed`, { headers: H })
            ).status(),
        ).toBe(400);
        // Well-formed but unknown id → the ownership gate 404s (work not found).
        expect(
            (
                await request.get(`${API_BASE}/api/works/${UNKNOWN_UUID}/activity-feed`, {
                    headers: H,
                })
            ).status(),
        ).toBe(404);
        // No auth at all → 401.
        expect(
            (await request.get(`${API_BASE}/api/works/${UNKNOWN_UUID}/activity-feed`)).status(),
        ).toBe(401);
    });
});

// ── E. Removal severs the feed but the audit trail persists ─────────────────
test.describe('Collaboration chain — removal severs the feed, audit trail persists', () => {
    test('a removed member loses feed access, yet their contributed rows survive in the owner feed', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        const tag = uniq('sever');
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `Sever ${tag}` });
        const row = await invite(request, owner.access_token, work.id, member.email, 'editor');

        // The member contributes a content edit while still a member.
        expect(
            await patchWork(request, member.access_token, work.id, { description: 'contrib' }),
        ).toBe(200);
        await pollFeedHasTypes(request, owner.access_token, work.id, ['work_updated']);
        // While a member they can read the feed.
        expect((await getFeedRaw(request, member.access_token, work.id)).status()).toBe(200);

        // Owner removes them.
        expect(await removeMember(request, owner.access_token, work.id, row.id)).toBe(200);

        // Feed access is severed synchronously (poll to absorb dev latency) → 403.
        await expect
            .poll(async () => (await getFeedRaw(request, member.access_token, work.id)).status(), {
                timeout: 20_000,
                message: 'ex-member feed access revoked',
            })
            .toBe(403);

        // BUT the owner's feed is append-only: the ex-member's work_updated row AND
        // the member_removed row both survive the removal.
        const feed = await getFeed(request, owner.access_token, work.id);
        const types = platformEntries(feed).map((e) => e.type);
        expect(types, 'contributed row survives removal').toContain('work_updated');
        await pollFeedHasTypes(request, owner.access_token, work.id, ['member_removed']);
    });

    test('the audit trail follows the USER: a removed member still reads their own historical rows', async ({
        request,
    }) => {
        const tag = uniq('trail-follows');
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, { name: `Trail ${tag}` });
        const row = await invite(request, owner.access_token, work.id, member.email, 'editor');
        expect(
            await patchWork(request, member.access_token, work.id, { description: 'mine' }),
        ).toBe(200);
        await pollLogHasRow(
            request,
            member.access_token,
            work.id,
            (r) => r.actionType === 'work_updated',
        );

        // Remove the member.
        expect(await removeMember(request, owner.access_token, work.id, row.id)).toBe(200);
        await expect
            .poll(async () => (await getFeedRaw(request, member.access_token, work.id)).status(), {
                timeout: 20_000,
            })
            .toBe(403);

        // The per-user log is self-scoped, not membership-gated: the ex-member can
        // STILL read their own historical work_updated row for the work → 200.
        const scoped = await listLog(request, member.access_token, `?workId=${work.id}`);
        expect(scoped.status, 'ex-member reads own workId-scoped log').toBe(200);
        expect(scoped.activities.some((r) => r.actionType === 'work_updated')).toBe(true);
        expect(scoped.activities.every((r) => r.userId === member.user.id)).toBe(true);

        // And their GLOBAL log retains signup + the edit regardless of membership.
        const global = await listLog(request, member.access_token);
        expect(global.activities.some((r) => r.actionType === 'work_updated')).toBe(true);
        expect(global.activities.some((r) => r.actionType === 'user_signup')).toBe(true);
    });
});

// ── F. Cross-work isolation of the collaboration chain ──────────────────────
test.describe('Collaboration chain — cross-work isolation', () => {
    test('two works by the same owner never cross-contaminate feeds or per-user logs', async ({
        request,
    }) => {
        const tag = uniq('cross-work');
        const owner = await registerUserViaAPI(request);
        const memberA = await registerUserViaAPI(request);
        const workA = await createWorkViaAPI(request, owner.access_token, { name: `XW-A ${tag}` });
        const workB = await createWorkViaAPI(request, owner.access_token, { name: `XW-B ${tag}` });

        // Only work A gets a member + an edit.
        await invite(request, owner.access_token, workA.id, memberA.email, 'editor');
        expect(
            await patchWork(request, memberA.access_token, workA.id, { description: 'a-edit' }),
        ).toBe(200);
        await pollFeedHasTypes(request, owner.access_token, workA.id, [
            'member_invited',
            'work_updated',
        ]);

        // Work B's feed carries only its own creation — none of A's rows leak in.
        const feedB = await getFeed(request, owner.access_token, workB.id);
        const typesB = platformEntries(feedB).map((e) => e.type);
        expect(typesB, 'B only has its own create').toContain('work_created');
        expect(typesB, 'A member_invited never leaks into B').not.toContain('member_invited');
        expect(typesB).not.toContain('work_updated');

        // The workId-scoped per-user log is likewise partitioned by work.
        const ownerB = await listLog(request, owner.access_token, `?workId=${workB.id}`);
        expect(ownerB.activities.every((r) => r.workId === workB.id)).toBe(true);
        expect(ownerB.activities.some((r) => r.actionType === 'member_invited')).toBe(false);
    });

    test('a member of work A cannot read work B’s feed, and A’s rows never reach B', async ({
        request,
    }) => {
        const tag = uniq('member-scope');
        const owner = await registerUserViaAPI(request);
        const member = await registerUserViaAPI(request);
        const workA = await createWorkViaAPI(request, owner.access_token, { name: `MS-A ${tag}` });
        const workB = await createWorkViaAPI(request, owner.access_token, { name: `MS-B ${tag}` });

        // The member joins ONLY work A.
        await invite(request, owner.access_token, workA.id, member.email, 'manager');

        // They can read A's feed…
        expect((await getFeedRaw(request, member.access_token, workA.id)).status()).toBe(200);
        // …but NOT B's — membership is per-Work, so B walls them off with 403.
        expect((await getFeedRaw(request, member.access_token, workB.id)).status()).toBe(403);

        // And the member's own workId=B log is empty (they never acted on B).
        const logB = await listLog(request, member.access_token, `?workId=${workB.id}`);
        expect(logB.status).toBe(200);
        expect(logB.total).toBe(0);
    });
});

// ── G. Capstone: the full multi-actor ordered chain ─────────────────────────
test.describe('Collaboration chain — capstone ordered multi-actor timeline', () => {
    test('a spaced create→invite→invite→edit→role-change→remove chain is newest-first with every actor', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const tag = uniq('capstone');
        const owner = await registerUserViaAPI(request);
        const manager = await registerUserViaAPI(request);
        const editor = await registerUserViaAPI(request);
        // Space each mutation into its own clock-second (activity_log stores
        // whole-second timestamps) so the DESC-ordered feed is deterministic.
        const gap = () => new Promise((r) => setTimeout(r, 1_200));

        const workName = `Capstone ${tag}`;
        const work = await createWorkViaAPI(request, owner.access_token, { name: workName });
        await gap();
        await invite(request, owner.access_token, work.id, manager.email, 'manager');
        await gap();
        const editorRow = await invite(
            request,
            owner.access_token,
            work.id,
            editor.email,
            'editor',
        );
        await gap();
        expect(
            await patchWork(request, editor.access_token, work.id, {
                description: 'capstone edit',
            }),
        ).toBe(200);
        await gap();
        expect(await putRole(request, manager.access_token, work.id, editorRow.id, 'viewer')).toBe(
            200,
        );
        await gap();
        expect(await removeMember(request, manager.access_token, work.id, editorRow.id)).toBe(200);

        // Wait until the async writes have all landed in the feed.
        await pollFeedHasTypes(request, owner.access_token, work.id, [
            'work_created',
            'member_invited',
            'work_updated',
            'member_role_changed',
            'member_removed',
        ]);

        const feed = await getFeed(request, owner.access_token, work.id, '?limit=200');
        const rows = platformEntries(feed);

        // Newest-first: the last action (remove) is the head; the first (create)
        // is the tail. Because we spaced each into its own second, timestamps are
        // strictly non-increasing across the whole list.
        expect(rows[0].type, 'newest entry is the removal').toBe('member_removed');
        expect(rows[rows.length - 1].type, 'oldest entry is the creation').toBe('work_created');
        expect(rows[rows.length - 1].summary).toContain(workName);

        const ts = rows.map((e) => new Date(e.timestamp).getTime());
        for (let i = 0; i < ts.length - 1; i++) {
            expect(ts[i], `feed newest-first at ${i}`).toBeGreaterThanOrEqual(ts[i + 1]);
        }

        // Every actor's action-type is represented in the single per-Work timeline.
        const types = rows.map((e) => e.type);
        for (const t of [
            'work_created',
            'member_invited',
            'work_updated',
            'member_role_changed',
            'member_removed',
        ]) {
            expect(types, `${t} present in the chain`).toContain(t);
        }

        // Cross-check the per-user partition: the manager owns exactly the
        // role-change + the removal; nothing the owner or editor did.
        const managerLog = await listLog(request, manager.access_token, `?workId=${work.id}`);
        const managerTypes = managerLog.activities.map((r) => r.actionType).sort();
        expect(managerTypes).toEqual(['member_removed', 'member_role_changed']);
        expect(managerLog.activities.every((r) => r.userId === manager.user.id)).toBe(true);
    });
});
