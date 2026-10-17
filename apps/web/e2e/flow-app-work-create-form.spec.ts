/**
 * APW-01 T22 / T28 — create a **Link** and a **Fork** App Work THROUGH THE UI
 * (`/works/new?mode=manual&kind=app` → `AppWorkForm`) against the fake GitHub.
 *
 * T22's done-when asks for exactly this: "A Playwright lane creates a Link and a Fork App
 * Work through the UI against the fake GitHub." Its API twin is
 * `flow-app-work-create-from-url.spec.ts` (APW-13 T30), which owns every create answer and
 * the inspect body; this file owns the **form half** — the chip's form renders, **Check
 * repository** runs the preview, the mode cards default and explain themselves, the deploy
 * target defaults to **None — don't deploy yet** (R-12), and **submit** lands on the new
 * App Work's page.
 *
 * ## The principal
 *
 * The lane's browser session is the **seeded** user's (`playwright.config.ts` loads
 * `e2e/.auth/user.json`), so every repository this file pastes is read with the seeded
 * user's GitHub connection, attached through `connectCustomerGitHub` with the seeded
 * user's own bearer token — the browser and the API are the same principal, the pattern
 * `flow-app-spec-settings.spec.ts` established.
 *
 * ## What "through the fake" is asserted with
 *
 * The fake's call log (`/_control/calls`) is shared by every worker, so each audit filters
 * on this run's **unique repository path**, the same rule the sibling specs follow:
 *   - Fork: exactly one `POST /repos/<upstream>/forks`;
 *   - the invalid-URL case: no call at all for the run's path (the form refuses before
 *     inspect — the inspect is a Next server action, so the browser never shows its
 *     `/works/app-source/inspect` request; the fake is where "nothing was read" shows).
 *
 * Copy asserted below is the shipped English (`messages/en.json`,
 * `dashboard.workCreation.app.*`), which is spec §6.2–§6.3 verbatim.
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE } from './helpers/api';
import { rawApi } from './helpers/app-works';
import { connectCustomerGitHub } from './helpers/github-connection';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * One case at a time: every create in this file runs on the one API process and the one
 * in-memory SQLite the shard shares, and a fork create slows sharply under parallel load
 * (measured by `flow-app-work-create-from-url.spec.ts`). In CI the shard already runs one
 * worker, where this is a no-op.
 */
test.describe.configure({ mode: 'serial' });

/** The fake GitHub's control API (plan §8.3). */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** The fake identity every account this lane attaches presents (`github-connection.ts`). */
const LANE_LOGIN = 'apw-e2e-user';

/** An owner the run account cannot write to — the fork case's upstream. */
const UPSTREAM_OWNER = 'apw-e2e-upstream';

/** The form's entry, exactly as `/new`'s App chip routes to it (`use-new-prompt.ts`). */
const APP_FORM_PATH = '/works/new?mode=manual&kind=app';

/** A Work page address, as `ROUTES.DASHBOARD_WORK(id)` builds it (locale prefix optional). */
const WORK_PAGE_URL =
    /\/works\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/;

/** Shipped copy (`messages/en.json` → `dashboard.workCreation.app`). */
const COPY = {
    noPushAccess: "You can't push to this repository.",
    invalidUrl: 'Enter a GitHub repository URL like https://github.com/owner/repo',
    linkSubmit: 'Link and create App Work',
    forkSubmit: 'Fork and create App Work',
} as const;

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function repoUrl(repo: { owner: string; name: string }): string {
    return `https://github.com/${repo.owner}/${repo.name}`;
}

// ---------------------------------------------------------------------------
// The seeded principal and the fake
// ---------------------------------------------------------------------------

/** The seeded user's bearer token — the same principal as the browser's storageState. */
async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `login body=${await res.text().catch(() => '')}`).toBe(200);
    return ((await res.json()) as { access_token: string }).access_token;
}

/** The checked-in PR-lane catalog, from either launch directory. */
function fakeSeedFixturePath(): string | null {
    for (const candidate of [
        'e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
        'apps/web/e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
    ]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/** Seed the fixture plus this run's repositories. `false` ⇒ the fake is absent. */
async function seedFakeGitHub(
    request: APIRequestContext,
    extraRepositories: Array<Record<string, unknown>>,
): Promise<boolean> {
    const fixture = fakeSeedFixturePath();
    if (fixture === null) return false;
    try {
        const seed = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>;
        const res = await request.post(`${FAKE_GITHUB_URL}/_control/seed`, {
            data: {
                ...seed,
                repositories: [...((seed.repositories as unknown[]) ?? []), ...extraRepositories],
            },
        });
        return res.ok();
    } catch {
        return false;
    }
}

interface FakeCall {
    method?: string;
    path?: string;
    status?: number | null;
}

/** Every call the fake has served, or `null` when it is not reachable. */
async function fakeGitHubCalls(request: APIRequestContext): Promise<FakeCall[] | null> {
    try {
        const res = await request.get(`${FAKE_GITHUB_URL}/_control/calls`);
        if (!res.ok()) return null;
        const body = (await res.json()) as { calls?: FakeCall[] };
        return Array.isArray(body.calls) ? body.calls : null;
    } catch {
        return null;
    }
}

/** Seed, connect, and say why the case cannot run when the fake is absent. */
async function prepare(
    request: APIRequestContext,
    repositories: Array<Record<string, unknown>>,
): Promise<string> {
    const seeded = await seedFakeGitHub(request, repositories);
    test.skip(
        !seeded,
        `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed — without it there ` +
            'is no repository to paste (the PR lane starts it beside the API).',
    );
    const token = await seededToken(request);
    await connectCustomerGitHub(request, token);
    return token;
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/** Open the App form and wait until it is interactive. */
async function openAppForm(page: Page): Promise<void> {
    await page.goto(APP_FORM_PATH, { waitUntil: 'domcontentloaded' });
    await expect(
        page.getByTestId('app-work-form'),
        'the App form renders for `kind=app` (EVER_WORKS_APP_WORKS_ENABLED is on in this lane)',
    ).toBeVisible({ timeout: 60_000 });
}

/** Paste a URL and run **Check repository**; resolves once the preview card is on screen. */
async function checkRepository(page: Page, url: string): Promise<void> {
    await page.getByTestId('app-work-url').fill(url);
    const check = page.getByTestId('app-work-check');
    await expect(check).toBeEnabled();
    await check.click();
    await expect(
        page.getByTestId('app-work-preview'),
        `the preview for ${url} (an inspect refusal would show app-work-inspect-error instead)`,
    ).toBeVisible({ timeout: 60_000 });
}

/** Give the Work a run-unique slug, submit, and return the new Work's id from the URL. */
async function submitWithSlug(page: Page, slug: string, submitLabel: string): Promise<string> {
    const slugField = page.getByTestId('app-work-slug');
    await slugField.fill(slug);
    const submit = page.getByTestId('app-work-submit');
    await expect(submit).toContainText(submitLabel);
    await expect(submit).toBeEnabled();
    await submit.click();
    await page.waitForURL(WORK_PAGE_URL, { timeout: 90_000 });
    const match = WORK_PAGE_URL.exec(page.url());
    expect(match, `landed on a Work page (url=${page.url()})`).not.toBeNull();
    return match![1];
}

/** Read the App Work and its upstream state back with the seeded token. */
async function readBack(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ kind?: string; slug?: string; relation?: string }> {
    const work = await rawApi<{ work?: { kind?: string; slug?: string } }>(
        request,
        'GET',
        `/api/works/${workId}`,
        { token },
    );
    expect(work.status, `GET /api/works/${workId} body=${work.text.slice(0, 300)}`).toBe(200);
    const upstream = await rawApi<{ relation?: string }>(
        request,
        'GET',
        `/api/works/${workId}/upstream`,
        { token },
    );
    expect(
        upstream.status,
        `GET /api/works/${workId}/upstream body=${upstream.text.slice(0, 300)}`,
    ).toBe(200);
    return {
        kind: work.json?.work?.kind,
        slug: work.json?.work?.slug,
        relation: upstream.json?.relation,
    };
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

test('Link — a repository the account can push to is linked through the form', async ({
    page,
    request,
}) => {
    const run = stamp();
    const own = {
        owner: LANE_LOGIN,
        name: `apw01-t22-link-${run}`,
        defaultBranch: 'main',
        permissions: [{ login: LANE_LOGIN, push: true, admin: true }],
    };
    const token = await prepare(request, [own]);

    await openAppForm(page);
    await checkRepository(page, repoUrl(own));

    // FR-17: Link is the default for a pushable repository that is not a fork.
    await expect(page.getByTestId('app-work-mode-link')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('app-work-mode-link')).not.toHaveAttribute(
        'aria-disabled',
        'true',
    );
    // A linked App Work needs no target owner.
    await expect(page.getByTestId('app-work-owner')).toHaveCount(0);
    // R-12: "None — don't deploy yet" is the default target.
    await expect(page.getByTestId('app-work-deploy-none')).toBeChecked();

    const slug = `apw01-t22-link-${run}`.slice(0, 60);
    const workId = await submitWithSlug(page, slug, COPY.linkSubmit);

    const back = await readBack(request, token, workId);
    expect(back.kind, 'the created Work is an App Work').toBe('app');
    expect(back.slug, 'with the slug typed into the form').toBe(slug);
    expect(back.relation, 'linked, as chosen').toBe('link');
});

test('Fork — a repository the account cannot push to is forked into its own account', async ({
    page,
    request,
}) => {
    const run = stamp();
    const upstream = {
        owner: UPSTREAM_OWNER,
        name: `apw01-t22-fork-${run}`,
        defaultBranch: 'main',
    };
    const token = await prepare(request, [upstream]);
    const callsBefore = (await fakeGitHubCalls(request)) ?? [];

    await openAppForm(page);
    await checkRepository(page, repoUrl(upstream));

    // FR-18: Fork is the default when the account cannot push; Link is disabled WITH its
    // reason as text (spec §6.3, ACC-01-07).
    await expect(page.getByTestId('app-work-mode-fork')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('app-work-mode-link')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('app-work-mode-link-reason')).toHaveText(COPY.noPushAccess);
    // FR-9: the caller's own account is offered first.
    await expect(page.getByTestId('app-work-owner')).toHaveValue(LANE_LOGIN);
    await expect(page.getByTestId('app-work-deploy-none')).toBeChecked();

    const slug = `apw01-t22-fork-${run}`.slice(0, 60);
    const workId = await submitWithSlug(page, slug, COPY.forkSubmit);

    const back = await readBack(request, token, workId);
    expect(back.kind, 'the created Work is an App Work').toBe('app');
    expect(back.slug).toBe(slug);
    expect(back.relation, 'forked, as chosen').toBe('fork');

    const added = ((await fakeGitHubCalls(request)) ?? []).slice(callsBefore.length);
    const forkRequests = added.filter(
        (call) =>
            (call.method ?? '').toUpperCase() === 'POST' &&
            call.path === `/repos/${upstream.owner}/${upstream.name}/forks`,
    );
    expect(
        forkRequests.length,
        `exactly one fork request reached the fake (requests=${JSON.stringify(
            forkRequests.map((c) => `${c.method} ${c.path} -> ${c.status}`),
        )})`,
    ).toBe(1);
});

test('an invalid URL is refused in the form — Check stays disabled and nothing is read', async ({
    page,
    request,
}) => {
    const run = stamp();
    const marker = `apw01-t22-invalid-${run}`;
    await prepare(request, []);
    const callsBefore = (await fakeGitHubCalls(request)) ?? [];

    await openAppForm(page);
    // Not a GitHub repository URL: a GitLab host with this run's unique path.
    await page.getByTestId('app-work-url').fill(`https://gitlab.com/${LANE_LOGIN}/${marker}`);

    await expect(page.getByText(COPY.invalidUrl).first()).toBeVisible();
    await expect(page.getByTestId('app-work-check')).toBeDisabled();
    // Enter does not inspect either (spec §6.6: "only when the URL parses").
    await page.getByTestId('app-work-url').press('Enter');
    await expect(page.getByTestId('app-work-preview')).toHaveCount(0);
    await expect(page.getByTestId('app-work-submit')).toBeDisabled();

    const added = ((await fakeGitHubCalls(request)) ?? []).slice(callsBefore.length);
    expect(
        added.filter((call) => (call.path ?? '').includes(marker)),
        'the form sent nothing to GitHub for a URL it refused',
    ).toEqual([]);
});
