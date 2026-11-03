import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, loginViaAPI } from './api';
import { loadSeededTestUser } from './seeded-test-user';

/**
 * APW-08 T29 — the fixture plumbing the evolve-loop e2e specs share
 * (`app-works-evolve-chat`, `app-works-delivery-chips`, `app-works-guard-refusals`).
 *
 * Seeding is API-first and navigation is direct (the house pattern for data-backed pages):
 *
 *   - the App Work is written by APW-11's non-production seed route
 *     (`POST /api/e2e/app-launcher/seed`, `kind: 'app'`) — no repository, no cluster;
 *   - its Tasks are created through the real `POST /api/tasks`;
 *   - the columns only the worker writes — the delivery chain's state, the deciding Deployment,
 *     and the change guard's refusal on the Task's branch — are written by APW-08 T29's
 *     non-production seed route `POST /api/e2e/app-works/task-seed`
 *     (`apps/api/src/tasks/e2e-task-seed.controller.ts`), which runs the REAL `AppChangeGuard`
 *     for a `guard` body. Both seed routes open on the same gate:
 *     `NODE_ENV !== 'production'` and `E2E_APP_LAUNCHER_SEED=true` (set by the PR lane).
 *
 * A seed route that answers `404` is a stack fact (the gate is closed), so every helper fails
 * with a message that names the variable instead of a bare status.
 */

export const APP_WORK_SEED_PATH = '/api/e2e/app-launcher/seed';
export const TASK_SEED_PATH = '/api/e2e/app-works/task-seed';

const GATE_HINT =
    'this lane needs NODE_ENV !== "production" and E2E_APP_LAUNCHER_SEED=true on the API ' +
    '(the variable that opens both e2e seed routes)';

export function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A bearer for the setup project's TEST_USER — the same person the browser is signed in as. */
export async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const { access_token } = await loginViaAPI(request, {
        email: seeded.email,
        password: seeded.password,
    });
    expect(access_token, 'seeded login returns a bearer token').toBeTruthy();
    return access_token;
}

export interface SeededAppWork {
    workId: string;
    slug: string;
    name: string;
}

/** One App Work (`kind: 'app'`) owned by the signed-in person, never deployed. */
export async function seedAppWork(
    request: APIRequestContext,
    token: string,
    name = `Evolve e2e ${uniq()}`,
): Promise<SeededAppWork> {
    const res = await request.post(`${API_BASE}${APP_WORK_SEED_PATH}`, {
        headers: authedHeaders(token),
        data: { kind: 'app', name, deployments: [] },
    });
    const body = await res.text();
    expect(
        res.status(),
        `POST ${APP_WORK_SEED_PATH} answered ${res.status()} — ${GATE_HINT}. Body: ${body}`,
    ).toBe(201);
    const json = JSON.parse(body) as { workId: string; slug: string; name: string };
    return { workId: json.workId, slug: json.slug, name: json.name };
}

export interface CreatedTask {
    id: string;
    slug: string;
    title: string;
    status: string;
}

/** A Task on the Work through the real create route. */
export async function createWorkTask(
    request: APIRequestContext,
    token: string,
    workId: string,
    body: Record<string, unknown> = {},
): Promise<CreatedTask> {
    const title = (body.title as string | undefined) ?? `evolve-e2e ${uniq()}`;
    const res = await request.post(`${API_BASE}/api/tasks`, {
        headers: authedHeaders(token),
        data: { ...body, title, workId },
    });
    const text = await res.text();
    expect(res.status(), `POST /api/tasks body=${text}`).toBe(201);
    const json = JSON.parse(text) as CreatedTask;
    return { id: json.id, slug: json.slug, title: json.title ?? title, status: json.status };
}

/** The Task's current row. */
export async function readTask(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(`${API_BASE}/api/tasks/${id}`, { headers: authedHeaders(token) });
    expect(res.status(), `GET /api/tasks/${id}`).toBe(200);
    return (await res.json()) as Record<string, unknown>;
}

/**
 * Move a Task through the real state machine (`POST /api/tasks/:id/transition`, `mode: 'sync'`:
 * the shortest legal path, every hop gated, no agent run started).
 */
export async function transitionTask(
    request: APIRequestContext,
    token: string,
    id: string,
    status: string,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/tasks/${id}/transition`, {
        headers: authedHeaders(token),
        data: { to: status, mode: 'sync' },
    });
    const text = await res.text();
    expect(res.ok(), `POST /api/tasks/${id}/transition → ${status}: ${res.status()} ${text}`).toBe(
        true,
    );
}

export type DeliveryStateName =
    | 'merged'
    | 'building'
    | 'build_failed'
    | 'built'
    | 'deploying'
    | 'deploy_failed'
    | 'live'
    | 'closed_without_deploy';

export interface TaskSeedBody {
    taskId: string;
    delivery?: {
        state: DeliveryStateName;
        mergeCommitSha?: string;
        prNumber?: number;
        deployment?: {
            state: 'READY' | 'ERROR' | 'ROLLED_BACK' | 'BUILDING';
            website?: string;
            commitSha?: string;
            rollbackFailed?: boolean;
            withWarnings?: boolean;
        };
    };
    guard?: {
        protectedPaths?: string[];
        sizeGuidance?: number;
        /** APW08-G22 — `agents.maxPullRequestChangedFiles`; the seed defaults it to 50. */
        fileGuidance?: number;
        files: Array<{
            path: string;
            previousPath?: string;
            status?: 'added' | 'modified' | 'removed' | 'renamed';
            additions?: number;
            deletions?: number;
        }>;
        totalFiles?: number;
    };
    /**
     * APW-08 T52 — one finished Fleet run of the Task's own Agent (the Task needs one: `422
     * noAgent`) carrying the containment its node reported (no node named), so the Cost
     * section's containment notice renders.
     */
    run?: {
        containment: {
            executionPath: 'hardened' | 'ordinary';
            isolatedHome: boolean;
            downgrades?: Array<{ control: string; reason: string }>;
        };
    };
}

export interface TaskSeedResult {
    taskId: string;
    workId: string;
    deliveryState: string | null;
    mergeCommitSha: string | null;
    deliveryDeploymentId: string | null;
    prNumber: number | null;
    runId: string | null;
    guard: {
        allowed: boolean;
        code: string | null;
        message: string | null;
        paths: string[];
        changedLines: number;
        note: string | null;
        branchGuardRefusal: string | null;
    } | null;
}

/** Write the worker-only delivery / change-guard columns of one App Work Task. */
export async function seedTaskState(
    request: APIRequestContext,
    token: string,
    body: TaskSeedBody,
): Promise<TaskSeedResult> {
    const res = await request.post(`${API_BASE}${TASK_SEED_PATH}`, {
        headers: authedHeaders(token),
        data: body,
    });
    const text = await res.text();
    expect(
        res.status(),
        `POST ${TASK_SEED_PATH} answered ${res.status()} — ${GATE_HINT}. Body: ${text}`,
    ).toBe(201);
    return JSON.parse(text) as TaskSeedResult;
}

/** A 40-hex commit id, unique per call (the merge commit is unique per Work). */
export function fakeSha(): string {
    let out = '';
    while (out.length < 40) out += Math.random().toString(16).slice(2);
    return out.slice(0, 40);
}

/**
 * Land on a dashboard page, recovering from the dev server's occasional cold auth redirect
 * (the stored session is applied on a second navigation), and wait for hydration.
 */
export async function gotoDashboard(page: Page, path: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        if (!/\/login(\?|$)/.test(page.url())) break;
        await page.waitForTimeout(1_500);
    }
    await expect(page).not.toHaveURL(/\/login/);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
}
