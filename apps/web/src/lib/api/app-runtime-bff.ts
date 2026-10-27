import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';

/**
 * Lane aw-ops (APW-06 T36) — the shared half of the App runtime BFF routes under
 * `app/api/works/[id]/app-*` (status poll, refresh, logs, job run, smoke, history).
 *
 * Every route there is a thin forward built with `bffProxy`, so the workspace scope travels by
 * default (Next's middleware excludes `/api`, so a route that forgot it would run in the personal
 * scope and answer an empty 404 — the "BFF route drops workspace scope" class). Two rules hold
 * for all of them and live here once:
 *
 *  - **Ids and names are checked before anything leaves the web tier**, and a request body is
 *    rebuilt field by field from an allow-list — the browser cannot smuggle a field upstream.
 *  - **The platform's status passes through unchanged.** 202, 409 (`deploy_in_progress`,
 *    `job_active`), 422 (`job_confirmation_required`), 429 (`refresh_too_soon`, with its wait) and
 *    404 each carry a named code the Deploy tab renders; flattening them would erase it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A component or job name as the App spec declares one (the API applies the same rule). */
const RUNTIME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

export function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value);
}

export function isRuntimeName(value: unknown): value is string {
    return typeof value === 'string' && RUNTIME_NAME.test(value);
}

export function invalidIdResponse(): Response {
    return NextResponse.json(
        { status: 'error', code: 'invalid_id', message: 'Invalid id' },
        { status: 400 },
    );
}

/** `${API_URL}/works/<id><path>` — `path` starts with `/` and is built from checked parts only. */
export function appRuntimeApiUrl(workId: string, path: string): string {
    return `${API_URL}/works/${encodeURIComponent(workId)}${path}`;
}

/** Forward one call and pass the platform's status, body and `Retry-After` through untouched. */
export async function forwardAppRuntimeCall(
    url: string,
    init: { method: 'GET' | 'POST'; headers: Headers; body?: Record<string, unknown> },
): Promise<Response> {
    init.headers.set('Accept', 'application/json');
    if (init.body) init.headers.set('Content-Type', 'application/json');
    let upstream: Response;
    try {
        upstream = await fetch(url, {
            method: init.method,
            headers: init.headers,
            cache: 'no-store',
            ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        });
    } catch {
        // A transport fault never leaks the platform URL or the error text to the browser.
        return NextResponse.json(
            {
                status: 'error',
                code: 'upstream_unavailable',
                message: 'The platform could not be reached.',
            },
            { status: 502 },
        );
    }
    const text = await upstream.text().catch(() => '');
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    };
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter && /^\d{1,5}$/.test(retryAfter)) headers['Retry-After'] = retryAfter;
    return new Response(upstream.status === 204 ? null : text, {
        status: upstream.status,
        headers,
    });
}

/** Read a JSON body without throwing; anything unreadable is an empty object. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
    try {
        const parsed = (await request.json()) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/** `POST app-logs`'s body, rebuilt from the five fields the platform accepts. */
export function sanitizeLogsBody(raw: Record<string, unknown>): {
    component?: string;
    job?: string;
    deploymentId?: string;
    previous?: boolean;
    lines?: number;
} {
    const body: {
        component?: string;
        job?: string;
        deploymentId?: string;
        previous?: boolean;
        lines?: number;
    } = {};
    if (isRuntimeName(raw.component)) body.component = raw.component;
    if (isRuntimeName(raw.job)) body.job = raw.job;
    if (isUuid(raw.deploymentId)) body.deploymentId = raw.deploymentId;
    if (typeof raw.previous === 'boolean') body.previous = raw.previous;
    if (typeof raw.lines === 'number' && Number.isFinite(raw.lines)) {
        body.lines = Math.min(500, Math.max(1, Math.floor(raw.lines)));
    }
    return body;
}
