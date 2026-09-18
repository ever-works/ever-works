/**
 * APW-13 T16 — Activity for template fork and PR events (ACC-REG-07).
 *
 * ACC-REG-07's recorded verdict is *Partial — no e2e asserts deploy, domain, PR,
 * merge or template-fork events*. Those events are emitted by the fork, deploy
 * and pull-request paths, so the event rows themselves need three things: the
 * GitHub connection surface — **landed by T63** as surface (b) of plan §8.8,
 * `connectCustomerGitHub` in `helpers/github-connection.ts` — a create route that
 * accepts the fork fields (**landed by APW-01 T5**), and a service layer that
 * acts on them (still missing; T24/T25 own it).
 *
 * ── Why the fixme'd half is still fixme'd, re-measured 2026-09-18 after T5:
 *
 * The DTO half is done: `POST /api/works` with `kind: "app"`,
 * `repositoryMode: "fork"` and `targetOwner` now answers **`200`** and creates a
 * Work with `kind: "app"` — probed on the lane's own API, so the
 * `400 property repositoryMode should not exist` this file used to record is
 * gone. What has not changed is that nothing *acts* on the mode:
 * `packages/agent/src/services/work-lifecycle.service.ts:311-364` branches only
 * on `isRepositoryWorkKind`, so an `app` create takes the generated-site path and
 * no fork request is ever made — the fake GitHub's call log stays **empty**
 * (measured: 0 calls, 0 of them forks). No fork means no `app.fork.*` row, which
 * is why the marker moves to the service layer rather than being removed. When
 * T24/T25 wire it, each acting account must be attached with
 * `connectCustomerGitHub(request, token)` before its first create, as T14's
 * connected half now does.
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
    // an upstream estate. Two of the three blockers have landed: T63's GitHub
    // connection surface (surface (b) of plan §8.8), and the create contract,
    // which APW-01 T5 completed — the same `POST /api/works` body now answers
    // `200` and creates the Work instead of the ValidationPipe's
    // `400 property repositoryMode should not exist` this file used to record.
    // What is left is the service layer: `work-lifecycle.service.ts:311-364`
    // branches only on `isRepositoryWorkKind`, so nothing forks and no
    // `app.fork.*` row can appear. The assertions below are unchanged and the
    // marker now names the blocker that is actually left (T24/T25).
    test.fixme(
        'APW-13 T16: the fork event needs a service that acts on repositoryMode — the create ' +
            'is accepted since APW-01 T5 but nothing forks yet (T24/T25 own that wiring)',
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
