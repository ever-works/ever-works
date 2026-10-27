'use client';

import { browserApiFetch } from './browser-api';
import type {
    AppDeploymentHistoryView,
    AppLogsReadView,
    AppLogsRequestInput,
    AppOpsAcceptedView,
    AppOpsResult,
    AppStatusView,
} from './app-runtime.types';

/**
 * Lane aw-ops (APW-06 T36) — the browser's client for the live App's operations. Every call goes
 * to a same-origin BFF route under `/api/works/:id/app-*` (built with `bffProxy`) through
 * {@link browserApiFetch}, which stamps the per-tab workspace selector — so the scope travels
 * whatever Organization the tab is on.
 *
 * Polls (the status every 3/30 s, a log request until it is ready) must be route handlers, not
 * server actions: Next queues an action behind the one already running. The writes use the same
 * routes so the Deploy tab has one transport and one error vocabulary.
 *
 * Nothing here throws: each call answers {@link AppOpsResult} with the platform's status and code,
 * and a transport fault is `status: 0`. Nothing is written to the browser's storage.
 */

async function call<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: Record<string, unknown> } = { method: 'GET' },
): Promise<AppOpsResult<T>> {
    let response: Response;
    try {
        response = await browserApiFetch(path, {
            method: init.method,
            cache: 'no-store',
            headers: {
                Accept: 'application/json',
                ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        });
    } catch {
        return { ok: false, status: 0, code: 'network_error' };
    }

    let payload: unknown = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (response.ok) return { ok: true, status: response.status, data: payload as T };

    const body = (payload ?? {}) as { code?: unknown; message?: unknown; retryAfterSeconds?: unknown };
    const header = Number(response.headers.get('retry-after'));
    const retry =
        typeof body.retryAfterSeconds === 'number'
            ? body.retryAfterSeconds
            : Number.isFinite(header) && header > 0
              ? header
              : undefined;
    return {
        ok: false,
        status: response.status,
        code: typeof body.code === 'string' ? body.code : undefined,
        message: typeof body.message === 'string' ? body.message : undefined,
        ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
    };
}

const base = (workId: string) => `/api/works/${encodeURIComponent(workId)}`;

export const appRuntimeOpsClient = {
    /** The status poll (`GET app-status`). */
    getStatus: (workId: string) => call<AppStatusView>(`${base(workId)}/app-status`),

    /** **Refresh** — once per 15 s per App Work (`429 refresh_too_soon` with the wait). */
    refreshStatus: (workId: string) =>
        call<AppOpsAcceptedView>(`${base(workId)}/app-status/refresh`, { method: 'POST' }),

    /** Ask for one component's or one job's log tail; read it back with {@link readLogs}. */
    requestLogs: (workId: string, input: AppLogsRequestInput) =>
        call<AppOpsAcceptedView>(`${base(workId)}/app-logs`, {
            method: 'POST',
            body: { ...input },
        }),

    /** `pending` → `ready` (redacted tail) | `failed` (code); 404 once expired. */
    readLogs: (workId: string, requestId: string) =>
        call<AppLogsReadView>(`${base(workId)}/app-logs/${encodeURIComponent(requestId)}`),

    /** **Run now** on a job — only after the member confirmed in the run dialog. */
    runJob: (workId: string, jobName: string) =>
        call<AppOpsAcceptedView>(`${base(workId)}/app-jobs/${encodeURIComponent(jobName)}/run`, {
            method: 'POST',
            body: { confirmFirstDeploy: true },
        }),

    /** **Run smoke checks** against the live Deployment. */
    runSmoke: (workId: string) => call<AppOpsAcceptedView>(`${base(workId)}/app-smoke`, { method: 'POST' }),

    /** The last 20 Deployments. */
    listDeployments: (workId: string) =>
        call<{ deployments: AppDeploymentHistoryView[] }>(`${base(workId)}/app-deployments`),
};
