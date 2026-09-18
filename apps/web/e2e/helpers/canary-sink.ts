/**
 * Canary-sink reader for the App Works acceptance harness (APW-13 T11,
 * `docs/specs/features/app-works/APW-13-golden-paths/tasks.md:163`).
 *
 * The sink is the tiny HTTPS service under test control that records every
 * request the injection fixture makes (plan §5.3, `plan.md:341-360`). Its read
 * surface is fixed by that section, so this reader is written against a
 * contract rather than a guess:
 *
 *   - `GET /requests?since=<ISO 8601>&limit=<1…500>` →
 *     `200 { requests: Array<{ method, path, headers, body, receivedAt, remoteAddress }>,
 *     truncated: boolean }`, with `authorization` removed **before storage**.
 *   - `GET /healthz` → `200 ok`.
 *   - A missing or wrong bearer read token on `/requests` → `401`, `403` on a
 *     wrong token.
 *
 * Two properties this module holds beyond the wire contract:
 *
 *   1. **`authorization` is never returned.** The sink strips it before
 *      storage; the reader strips it again on the way out, case-insensitively,
 *      so a sink regression cannot leak a bearer token into an assertion, a
 *      failure dump or an evidence artefact.
 *   2. **A truncated page is followed, and a refusal is not a mystery.** When a
 *      page says `truncated: true` the reader advances `since` to the newest
 *      `receivedAt` it saw and reads on (plan §5.3, `plan.md:357`). A `401`/`403`
 *      surfaces as {@link CanarySinkRefusal} — an error that *carries its HTTP
 *      status* — never as a statusless throw a lane would have to guess at.
 *
 * Base URL and read token are parameters with environment defaults:
 * `APW_E2E_CANARY_SINK_URL` and `APW_E2E_CANARY_SINK_READ_TOKEN` (ACCEPTANCE
 * ACCEPTANCE.md:133).
 */

/** One recorded request, as the sink's read API returns it. */
export interface SinkRequest {
    method: string;
    path: string;
    /** Header names lower-cased by the sink; `authorization` is absent. */
    headers: Record<string, string>;
    /** Up to 16 KiB; longer bodies carry `bodyTruncated`. */
    body: string;
    /** ISO 8601 — the paging cursor. */
    receivedAt: string;
    remoteAddress?: string;
    bodyTruncated?: boolean;
}

export interface CanarySinkOptions {
    /** Base URL of the sink; defaults to `APW_E2E_CANARY_SINK_URL`. */
    baseUrl?: string;
    /** Bearer read token; defaults to `APW_E2E_CANARY_SINK_READ_TOKEN`. */
    token?: string;
    /** Page size, clamped to the contract's `1…500`; default 200. */
    limit?: number;
    /** Guard against a sink that keeps claiming `truncated`; default 50. */
    maxPages?: number;
    /** Injectable `fetch` (unit specs stub it); defaults to the global. */
    fetchImpl?: typeof fetch;
}

export interface AssertNoLeakOptions extends CanarySinkOptions {
    /** Search these already-read rows instead of reading the sink. */
    requests?: SinkRequest[];
    /** Window start; defaults to the epoch, i.e. the whole store. */
    since?: string;
}

export interface LeakReport {
    /** The known values that were searched for (empty ones dropped). */
    values: string[];
    /** How many recorded requests were searched. */
    scanned: number;
    /** How many sink pages were read (0 when `requests` was supplied). */
    pages: number;
}

/** A refusal from the sink's read API — always carries the HTTP status. */
export class CanarySinkRefusal extends Error {
    readonly status: number;
    readonly body: string;

    constructor(status: number, body: string) {
        super(
            `canary-sink: the read API refused this token (HTTP ${status}) — check ` +
                `APW_E2E_CANARY_SINK_READ_TOKEN${body ? `; sink said: ${body}` : ''}`,
        );
        this.name = 'CanarySinkRefusal';
        this.status = status;
        this.body = body;
    }
}

/** A recorded request carried one of the known values. */
export class CanaryLeakError extends Error {
    readonly values: string[];
    readonly requests: Array<{ method: string; path: string; receivedAt: string }>;

    constructor(
        values: string[],
        requests: Array<{ method: string; path: string; receivedAt: string }>,
    ) {
        super(
            `canary-sink: ${values.length} known secret value(s) reached the sink — ` +
                `${values.map((value) => JSON.stringify(value)).join(', ')} in ` +
                `${requests.map((request) => `${request.method} ${request.path}`).join(', ')}`,
        );
        this.name = 'CanaryLeakError';
        this.values = values;
        this.requests = requests;
    }
}

/** The window start a one-argument `assertNoLeak(values)` searches from. */
export const SINK_EPOCH = '1970-01-01T00:00:00.000Z';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DEFAULT_MAX_PAGES = 50;

function resolveBaseUrl(baseUrl?: string): string {
    const value = (baseUrl ?? process.env.APW_E2E_CANARY_SINK_URL ?? '').trim();
    if (!value) {
        throw new Error(
            'canary-sink: no base URL — pass `baseUrl` or set APW_E2E_CANARY_SINK_URL.',
        );
    }
    return value.replace(/\/+$/, '');
}

function resolveToken(token?: string): string {
    const value = (token ?? process.env.APW_E2E_CANARY_SINK_READ_TOKEN ?? '').trim();
    if (!value) {
        throw new Error(
            'canary-sink: no read token — pass `token` or set ' + 'APW_E2E_CANARY_SINK_READ_TOKEN.',
        );
    }
    return value;
}

function resolveLimit(limit?: number): number {
    const value = Number.isFinite(limit) ? Math.floor(limit as number) : DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, value));
}

function asString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/**
 * `authorization` (any casing) is dropped here as well as at the sink, so the
 * reader's own return value can never carry a bearer token.
 */
export function stripAuthorization(
    headers: Record<string, string> | undefined,
): Record<string, string> {
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
        if (name.trim().toLowerCase() === 'authorization') continue;
        kept[name] = asString(value);
    }
    return kept;
}

function toSinkRequest(row: unknown): SinkRequest {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
        method: asString(record.method).toUpperCase(),
        path: asString(record.path),
        headers: stripAuthorization(record.headers as Record<string, string> | undefined),
        body: asString(record.body),
        receivedAt: asString(record.receivedAt),
        ...(record.remoteAddress === undefined
            ? {}
            : { remoteAddress: asString(record.remoteAddress) }),
        ...(record.bodyTruncated === undefined
            ? {}
            : { bodyTruncated: record.bodyTruncated === true }),
    };
}

async function readPage(
    base: string,
    token: string,
    since: string,
    limit: number,
    fetchImpl: typeof fetch,
    page: number,
): Promise<{ requests: SinkRequest[]; truncated: boolean }> {
    const url = `${base}/requests?since=${encodeURIComponent(since)}&limit=${limit}`;
    const res = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
        throw new CanarySinkRefusal(res.status, text.slice(0, 200));
    }
    if (res.status !== 200) {
        throw new Error(
            `canary-sink: reading page ${page} failed with HTTP ${res.status}: ${text.slice(0, 200)}`,
        );
    }
    let body: { requests?: unknown[]; truncated?: unknown };
    try {
        body = JSON.parse(text) as { requests?: unknown[]; truncated?: unknown };
    } catch {
        throw new Error(`canary-sink: page ${page} did not return JSON: ${text.slice(0, 200)}`);
    }
    const rows = Array.isArray(body.requests) ? body.requests.map(toSinkRequest) : [];
    return { requests: rows, truncated: body.truncated === true };
}

async function readAll(
    since: string,
    options: CanarySinkOptions,
): Promise<{ requests: SinkRequest[]; pages: number }> {
    const base = resolveBaseUrl(options.baseUrl);
    const token = resolveToken(options.token);
    const limit = resolveLimit(options.limit);
    const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));
    const fetchImpl = options.fetchImpl ?? fetch;

    let cursor = since;
    let pages = 0;
    const collected: SinkRequest[] = [];
    const seen = new Set<string>();

    for (;;) {
        const page = await readPage(base, token, cursor, limit, fetchImpl, pages + 1);
        pages += 1;
        for (const row of page.requests) {
            // `since` is inclusive at the sink, so a page boundary repeats one
            // row; a truly identical request cannot carry a different leak.
            const key = JSON.stringify(row);
            if (seen.has(key)) continue;
            seen.add(key);
            collected.push(row);
        }
        if (!page.truncated) break;

        const newest = page.requests.reduce(
            (max, row) => (row.receivedAt > max ? row.receivedAt : max),
            cursor,
        );
        if (newest <= cursor) {
            throw new Error(
                `canary-sink: page ${pages} says truncated but carried no newer ` +
                    `receivedAt than ${cursor}; cannot follow the window (plan §5.3).`,
            );
        }
        if (pages >= maxPages) {
            throw new Error(
                `canary-sink: page guard (${maxPages}) reached with more rows pending — ` +
                    'narrow the window with `since` rather than risking a missed leak.',
            );
        }
        cursor = newest;
    }

    collected.sort((a, b) =>
        a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0,
    );
    return { requests: collected, pages };
}

/**
 * Every request the sink recorded at or after `since`, every page of it
 * (plan §5.3 paging, `plan.md:357`). `authorization` is absent from every row.
 */
export async function listRequests(
    since: string,
    options: CanarySinkOptions = {},
): Promise<SinkRequest[]> {
    const { requests } = await readAll(since, options);
    return requests;
}

/**
 * Fail when any recorded request carries one of `values` — the honeytoken and
 * every known `APW_E2E_*` secret value (plan §5.3, `plan.md:345-346`).
 *
 * The search covers what the sink stores — method, path, headers and body — not
 * the body alone: a value planted in a query string is exactly the leak the
 * fixture is trying to provoke, and a body-only search would call it clean.
 * Empty and whitespace-only values are dropped (they would match everything).
 */
export async function assertNoLeak(
    values: readonly string[],
    options: AssertNoLeakOptions = {},
): Promise<LeakReport> {
    const wanted = Array.from(
        new Set(values.map((value) => String(value)).filter((value) => value.trim().length > 0)),
    );
    const { requests, pages } = options.requests
        ? { requests: options.requests, pages: 0 }
        : await readAll(options.since ?? SINK_EPOCH, options);

    const leaked = new Set<string>();
    const carriers: Array<{ method: string; path: string; receivedAt: string }> = [];
    for (const request of requests) {
        const haystack = [
            request.method,
            request.path,
            ...Object.entries(request.headers).flatMap(([name, value]) => [name, value]),
            request.body,
        ].join('\n');
        const hits = wanted.filter((value) => haystack.includes(value));
        if (hits.length === 0) continue;
        for (const hit of hits) leaked.add(hit);
        carriers.push({
            method: request.method,
            path: request.path,
            receivedAt: request.receivedAt,
        });
    }

    if (leaked.size > 0) {
        throw new CanaryLeakError(Array.from(leaked).sort(), carriers);
    }
    return { values: wanted, scanned: requests.length, pages };
}
