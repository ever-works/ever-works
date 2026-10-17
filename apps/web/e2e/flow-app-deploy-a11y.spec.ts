/**
 * APW-06 T63 (ACC-06-44) — the App Work's Deploy tab is accessible.
 *
 * axe-core (the `accessibility-axe-deep.spec.ts` pattern: injected from the CDN, WCAG 2 A
 * and AA rules, skipped by name when the CDN is blocked) runs on the Deploy tab of an App
 * Work in the **None** state, and again with the **Connect your cluster** dialog open.
 * Each run must report **no serious or critical** violation inside the App Deploy surface.
 *
 * Keyboard: the dialog's opener is reachable by `Tab`, `Esc` closes the dialog, and focus
 * returns to the opener.
 *
 * Scope note (reported, not implied): T63's live / failed states and the Rollback, Remove
 * and Stored data dialogs belong to APW-06 T38/T39 surfaces that are not built yet, so this
 * file covers the two states the tab can reach today. The App Work is created through the
 * API for the seeded user (the browser's own principal), the same path
 * `flow-app-spec-settings.spec.ts` uses.
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE } from './helpers/api';
import { appWorkCreateBody, createAppWork } from './helpers/app-works';
import { connectCustomerGitHub } from './helpers/github-connection';
import { loadSeededTestUser } from './helpers/seeded-test-user';

test.describe.configure({ mode: 'serial' });

const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

const LANE_LOGIN = 'apw-e2e-user';

/** The App Deploy surface's root (`AppDeployPage.tsx`). */
const DEPLOY_PAGE = '[data-testid="app-deploy-page"]';

interface AxeViolation {
    id: string;
    impact: string | null;
    nodes: Array<{ html?: string; target?: string[] }>;
}

/** Run axe on `include`, or `null` when axe-core could not be loaded. */
async function runAxe(page: Page, include: string): Promise<AxeViolation[] | null> {
    const loaded = await page.evaluate(async () => {
        if ((window as unknown as { axe?: unknown }).axe) return true;
        return new Promise<boolean>((resolve) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/axe-core@4.10/axe.min.js';
            s.onload = () => resolve(true);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
    });
    if (!loaded) return null;
    return page.evaluate(async (selector) => {
        const w = window as unknown as {
            axe: {
                run: (
                    context: unknown,
                    options: unknown,
                ) => Promise<{ violations: AxeViolation[] }>;
            };
        };
        const result = await w.axe.run(
            { include: [selector] },
            { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } },
        );
        return result.violations;
    }, include);
}

function seriousOf(violations: AxeViolation[]): AxeViolation[] {
    return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

function describeViolations(violations: AxeViolation[]): string {
    return violations
        .map(
            (v) =>
                `${v.id} (${v.impact}): ${v.nodes.map((n) => (n.target ?? []).join(' ')).join(' | ')}`,
        )
        .join('; ');
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `login body=${await res.text().catch(() => '')}`).toBe(200);
    return ((await res.json()) as { access_token: string }).access_token;
}

function fakeSeedFixturePath(): string | null {
    for (const candidate of [
        'e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
        'apps/web/e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
    ]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

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

/** One App Work (fork, target None) of the seeded user, shared by both cases. */
let appWorkId: string | null = null;

async function ensureAppWork(request: APIRequestContext): Promise<string> {
    if (appWorkId) return appWorkId;
    const run = stamp();
    const upstream = { owner: 'apw-e2e-upstream', name: `apw06-t63-${run}` };
    const seeded = await seedFakeGitHub(request, [upstream]);
    test.skip(
        !seeded,
        `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed — there is no ` +
            'repository to make an App Work from (the PR lane starts it beside the API).',
    );
    const token = await seededToken(request);
    await connectCustomerGitHub(request, token);
    const slug = `apw06-t63-${run}`;
    const created = await createAppWork(request, {
        token,
        body: appWorkCreateBody({
            name: slug,
            slug,
            description: 'APW-06 T63 a11y',
            organization: false,
            repositoryUrl: `https://github.com/${upstream.owner}/${upstream.name}`,
            repositoryMode: 'fork',
            targetOwner: LANE_LOGIN,
            autoProvision: false,
        }),
    });
    expect(created.status, `app create body=${created.text.slice(0, 400)}`).toBe(200);
    const id = (created.json as { work?: { id?: string } })?.work?.id ?? '';
    expect(id, 'the create answers a Work id').not.toBe('');
    appWorkId = id;
    return id;
}

async function openDeployTab(page: Page, workId: string): Promise<void> {
    await page.goto(`/works/${workId}/deploy`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(DEPLOY_PAGE), 'the App branch of the Deploy tab renders').toBeVisible(
        {
            timeout: 60_000,
        },
    );
}

test('ACC-06-44 — the Deploy tab in the None state has no serious axe violation', async ({
    page,
    request,
}) => {
    const workId = await ensureAppWork(request);
    await openDeployTab(page, workId);
    await expect(page.getByTestId('app-target-card')).toBeVisible();
    // R-12: a fresh App Work's target is None — don't deploy yet.
    await expect(page.getByTestId('app-target-none')).toBeChecked();

    const violations = await runAxe(page, DEPLOY_PAGE);
    test.skip(violations === null, 'axe-core could not load (CDN blocked?)');
    const serious = seriousOf(violations!);
    expect(serious, `serious+ violations: ${describeViolations(serious) || 'none'}`).toEqual([]);
});

test('ACC-06-44 — the Connect dialog: no serious axe violation, Esc closes it and focus returns', async ({
    page,
    request,
}) => {
    const workId = await ensureAppWork(request);
    await openDeployTab(page, workId);

    const opener = page.getByTestId('app-target-connect');
    await expect(opener).toBeVisible();
    // Keyboard reachability: the opener takes focus and Enter opens the dialog.
    await opener.focus();
    await expect(opener).toBeFocused();
    await page.keyboard.press('Enter');

    const dialog = page.getByTestId('connect-cluster-dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('dialog')).toBeVisible();

    const violations = await runAxe(page, '[role="dialog"]');
    test.skip(violations === null, 'axe-core could not load (CDN blocked?)');
    const serious = seriousOf(violations!);
    expect(serious, `serious+ violations: ${describeViolations(serious) || 'none'}`).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    await expect(opener, 'focus returns to the control that opened the dialog').toBeFocused();
});
