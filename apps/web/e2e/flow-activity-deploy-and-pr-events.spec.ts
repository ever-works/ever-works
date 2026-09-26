/**
 * APW-13 T16 — Activity for template fork and PR events (ACC-REG-07).
 *
 * ACC-REG-07's recorded verdict is *Partial — no e2e asserts deploy, domain, PR,
 * merge or template-fork events*. Those events are emitted by the fork, deploy
 * and pull-request paths, so the event rows themselves need a forked Work, a
 * finished readiness run, a deploy and an upstream estate. The first of those
 * exists now; the others are either not driven by this lane or not yet measured
 * on it.
 *
 * ── Why the fixme'd half is still fixme'd (refreshed 2026-09-25):
 *
 * The fork is no longer what it waits for. The GitHub connection surface landed
 * with T63 (`connectCustomerGitHub`, surface (b) of plan §8.8), the create
 * contract with APW-01 T5, and the service that acts on it with APW-01 T12 + T13
 * (`5b838cb97`): an `app` create goes to `AppWorkCreateService`, which forks with
 * the caller's connection (asserted on the fake by
 * `flow-template-fork-success.spec.ts`). The record this header used to carry —
 * "nothing acts on the mode, the fake's call log stays empty" — described the
 * tree before that commit. What the case reads is three Activity rows the fork
 * alone does not produce: `app.fork.ready` (APW-02's readiness run must finish
 * on the lane — not measured), `app.deploy.succeeded` (a completed App deploy)
 * and `app.upstream_pr.opened` (an upstream pull request). The marker below
 * names them, and says what its body must change when it is lifted.
 *
 * ── The half that runs, and why it is the load-bearing half:
 *
 * "Every App Works step lands in Activity with NAMES only" is a statement about
 * the READ surface every one of those events lands on. This spec drives that
 * surface for real against a Work the platform itself just created:
 *
 *   • `GET /api/activity-log?workId=<id>` answers `200` and returns the Work's
 *     rows, each carrying the step's NAME — `actionType`, `action`, `status`,
 *     `summary` — which is exactly the shape an App Works step (`app.build.*`,
 *     `app.deploy.*`, `app.upstream_pr.*`, a template fork, a PR event) must
 *     appear in;
 *   • the row carries no payload blob: `details` / `metadata` are `null` for the
 *     create row, i.e. the feed is a name trail rather than a payload dump;
 *   • the surface is owner-scoped: `401` unauthenticated, and a stranger's
 *     `workId` filter returns none of the owner's rows.
 *
 * Verified live against http://127.0.0.1:3100 (2026-09-18): a fresh Work create
 * yields exactly one row — `actionType: "work_created"`, `action:
 * "work.created"`, `status: "completed"`, `details: null`, `metadata: null` —
 * and the route answers 401 unauthenticated.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const WORKS_URL = `${API_BASE}/api/works`;
const ACTIVITY_URL = `${API_BASE}/api/activity-log`;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface WorkRow {
    id: string;
    kind?: string;
    slug?: string;
}

interface ActivityRow {
    id?: string;
    workId?: string | null;
    actionType?: string | null;
    action?: string | null;
    status?: string | null;
    summary?: string | null;
    details?: unknown;
    metadata?: unknown;
}

interface ActivityPage {
    activities?: ActivityRow[];
    data?: ActivityRow[];
    total?: number;
}

/** Create a plain Work — the one event the platform emits without a Git connection. */
async function createPlainWork(request: APIRequestContext, token: string): Promise<WorkRow> {
    const res = await request.post(WORKS_URL, {
        headers: authedHeaders(token),
        data: {
            name: `apw13-t16 ${stamp()}`,
            slug: `apw13-t16-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
            description: 'APW-13 T16 activity events',
            organization: false,
            kind: 'website',
        },
    });
    const text = await res.text();
    expect(res.status(), `create body=${text.slice(0, 300)}`).toBe(200);
    const body = JSON.parse(text) as { work?: WorkRow };
    expect(body.work?.id, 'the create answers a Work id').toBeTruthy();
    return body.work as WorkRow;
}

/** Read the Activity page for one Work (or the whole feed). */
async function readActivity(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<{ status: number; rows: ActivityRow[] }> {
    const res = await request.get(`${ACTIVITY_URL}${query}`, {
        headers: authedHeaders(token),
    });
    const text = await res.text();
    expect(res.status(), `activity read body=${text.slice(0, 300)}`).toBe(200);
    const body = JSON.parse(text) as ActivityPage;
    return { status: res.status(), rows: body.activities ?? body.data ?? [] };
}

test.describe('Activity — the read surface every App Works step lands on', () => {
    test('a Work step lands as a NAME row: actionType, action, status, summary — and no payload', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const work = await createPlainWork(request, user.access_token);

        const { rows } = await readActivity(
            request,
            user.access_token,
            `?workId=${work.id}&limit=25`,
        );

        expect(rows.length, 'the create appended an Activity row for the Work').toBeGreaterThan(0);
        const createRow = rows.find((row) => row.action === 'work.created');
        expect(
            createRow,
            `a step is named by its action; rows=${JSON.stringify(rows.map((r) => r.action))}`,
        ).toBeTruthy();
        expect(createRow?.actionType, 'the row carries the coarse action type').toBe(
            'work_created',
        );
        expect(createRow?.status, 'the row carries the step status').toBe('completed');
        expect(
            typeof createRow?.summary,
            'the row carries a human summary (the name shown in the feed)',
        ).toBe('string');
        expect(
            createRow?.details ?? null,
            'the feed is a name trail: the create row carries no payload blob',
        ).toBeNull();
        expect(
            createRow?.metadata ?? null,
            'the feed is a name trail: no metadata blob either',
        ).toBeNull();
        expect(
            rows.every((row) => row.workId === work.id),
            'workId filters to this Work',
        ).toBe(true);
    });

    test('the Activity feed is authenticated and owner-scoped', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createPlainWork(request, owner.access_token);

        const anonymous = await request.get(`${ACTIVITY_URL}?workId=${work.id}&limit=5`);
        expect(anonymous.status(), 'the feed is not public').toBe(401);

        const stranger = await registerUserViaAPI(request);
        const { rows } = await readActivity(
            request,
            stranger.access_token,
            `?workId=${work.id}&limit=25`,
        );
        expect(rows.length, "a stranger's workId filter returns none of the owner's rows").toBe(0);
    });
});

test.describe('Activity — template fork and PR events (T16)', () => {
    // The events ACC-REG-07 names — a template fork, a deploy, a domain, a PR, a
    // merge — are emitted by paths that need a forked Work and, for the PR half,
    // an upstream estate. The fork itself is no longer the blocker: since APW-01
    // T12 + T13 (`5b838cb97`) an `app` create goes to `AppWorkCreateService`,
    // which forks with the caller's connection — `flow-template-fork-success`
    // asserts the fork request on the fake, and `flow-app-work-fork-lifecycle`
    // the create's `preparing` answer. What this case still cannot see are the
    // three rows it reads:
    //   - `app.fork.ready` is written when APW-02's readiness run marks the fork
    //     ready (`app-upstream-state.service.ts`). The dispatcher is bound since
    //     C10 (`cf24c9e56`), but it hands the run only to a registered job
    //     runtime, and this lane has not been measured reaching `ready`;
    //   - `app.deploy.succeeded` needs a completed App deploy, and
    //     `app.upstream_pr.opened` an upstream pull request — neither of which
    //     this lane drives.
    // When the case is lifted, its body must follow the fork spec's post-T13
    // shape as well: attach the caller with `connectCustomerGitHub`, fork a
    // seeded upstream (the fixture's `ever-works/templates` already has an
    // `apw-e2e-user` fork, so it would be adopted, not forked), and use the
    // fixture's login `apw-e2e-user` — `apw13-e2e-user` below is not an account
    // the fake knows, and the create now refuses it with
    // `400 target_owner_unavailable`. The body is left as it was on purpose: the
    // marker is what changed.
    test.fixme(
        'APW-13 T16: forks happen since APW-01 T13, but the rows this case reads do not — ' +
            'app.fork.ready needs the readiness run to finish on the lane (unmeasured), and ' +
            'app.deploy.succeeded / app.upstream_pr.opened need a deploy and an upstream PR the ' +
            'lane does not drive',
        async ({ request }: { request: APIRequestContext }) => {
            const user = await registerUserViaAPI(request);

            // The fork, the deploy and the PR each append their OWN named row to
            // the same feed. The expected names are the App Works event
            // vocabulary of ACCEPTANCE §0.5 / CONTRACTS §12 (`app.fork.*`,
            // `app.deploy.*`, `app.upstream_pr.*`), read back through
            // `GET /api/activity-log?workId=<id>`:
            const created = await request.post(WORKS_URL, {
                headers: authedHeaders(user.access_token),
                data: {
                    name: `apw13-t16-fork ${stamp()}`,
                    slug: `apw13-t16-fork-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                    description: 'APW-13 T16 fork + PR events',
                    organization: false,
                    kind: 'app',
                    repositoryUrl: 'https://github.com/ever-works/templates',
                    repositoryMode: 'fork',
                    targetOwner: 'apw13-e2e-user',
                },
            });
            expect(
                created.status(),
                `fork create body=${(await created.text()).slice(0, 300)}`,
            ).toBe(200);

            const workId = ((await created.json()) as { work?: WorkRow }).work?.id ?? '';
            const { rows } = await readActivity(
                request,
                user.access_token,
                `?workId=${workId}&limit=100`,
            );
            const names = rows.map((row) => row.action ?? '');
            for (const expected of [
                'app.fork.ready',
                'app.deploy.succeeded',
                'app.upstream_pr.opened',
            ]) {
                expect(
                    names,
                    `${expected} must land in Activity with names only (no fork/PR payload)`,
                ).toContain(expected);
            }
        },
    );
});
