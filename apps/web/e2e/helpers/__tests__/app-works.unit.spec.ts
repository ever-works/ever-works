/**
 * Unit spec for the App Works API wrappers (APW-13 T6, `tasks.md:114-120`).
 *
 * What this spec pins, and why each half matters:
 *
 *   - **Never throws on a status.** Every row of {@link CONTRACTS_S4_ROUTES} is
 *     driven through its wrapper against a stubbed `APIRequestContext` at `2xx`,
 *     `4xx` and `5xx`, and each call must come back as `{ status, text, json }`
 *     with the raw answer — the property a lane needs in order to assert a
 *     documented refusal (`400 app_works_disabled`, `409 create_in_progress`,
 *     `422 followUpLimit`, …) rather than pattern-match a thrown error.
 *   - **Coverage is derived, not hand-copied.** The table itself is the source of
 *     truth: every row must name an exported wrapper, the wrapper must issue the
 *     row's method to the row's path, and the row's path must be reachable — so
 *     adding a route to CONTRACTS §4 without a wrapper reddens this spec.
 *   - **Unshipped routes are documented as such.** T6's "Done when" reads
 *     "wrappers for unshipped routes are exported and documented as such", so the
 *     helper's own source is scanned: every row flagged `shipped: false` must have
 *     its wrapper's doc comment marked **Unshipped / contract-only**.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { APIRequestContext, APIResponse } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import * as appWorks from '../app-works';
import {
    CONTRACTS_S4_ROUTES,
    appSourceInspectBody,
    appWorkCreateBody,
    type ContractsRouteRow,
    type RawApiResult,
} from '../app-works';

interface StubCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    data: unknown;
}

/** One stubbed response: the status a wrapper must pass through untouched. */
interface StubReply {
    status: number;
    body?: string;
}

/** Install a stubbed `APIRequestContext` that records what the wrapper asked for. */
function stubRequest(reply: StubReply): { request: APIRequestContext; calls: StubCall[] } {
    const calls: StubCall[] = [];
    const request = {
        fetch: async (url: string, options: Record<string, unknown> = {}) => {
            calls.push({
                url,
                method: String(options.method ?? 'GET'),
                headers: (options.headers ?? {}) as Record<string, string>,
                data: options.data,
            });
            return {
                status: () => reply.status,
                ok: () => reply.status >= 200 && reply.status < 300,
                text: async () => reply.body ?? '',
            } as unknown as APIResponse;
        },
    } as unknown as APIRequestContext;
    return { request, calls };
}

/** A context whose transport always fails, for the "never throws" half. */
function failingRequest(error: Error): { request: APIRequestContext; reads: () => number } {
    let reads = 0;
    const request = {
        fetch: async () => {
            reads += 1;
            throw error;
        },
    } as unknown as APIRequestContext;
    return { request, reads: () => reads };
}

/** The uniform runtime shape every wrapper has: `(request, input)`. */
type GenericWrapper = (
    request: APIRequestContext,
    input: Record<string, unknown>,
) => Promise<RawApiResult>;

/** Resolve one exported wrapper by the name a route row names. */
function wrapperFor(name: string): GenericWrapper {
    const candidate = (appWorks as unknown as Record<string, unknown>)[name];
    expect(typeof candidate, `${name} is exported as a function`).toBe('function');
    return candidate as GenericWrapper;
}

/** Values for every placeholder the route table uses, so paths can be compared. */
const PARAM_SAMPLES: Record<string, string> = {
    id: 'work-1',
    buildId: 'build-1',
    name: 'tick',
    prId: '7',
    taskId: 'task-1',
    provisioningId: 'prov-1',
    kind: 'postgres',
    requestId: 'req-1',
    catalogId: 'app-fixture-hello',
    agentId: 'agent-1',
    approvalId: 'approval-1',
};

/** One input object that satisfies every wrapper in the table. */
const SAMPLE_INPUT: Record<string, unknown> = {
    token: 'unit-token',
    baseUrl: 'http://unit.test',
    workId: PARAM_SAMPLES.id,
    buildId: PARAM_SAMPLES.buildId,
    name: PARAM_SAMPLES.name,
    prId: 7,
    taskId: PARAM_SAMPLES.taskId,
    provisioningId: PARAM_SAMPLES.provisioningId,
    kind: PARAM_SAMPLES.kind,
    requestId: PARAM_SAMPLES.requestId,
    catalogId: PARAM_SAMPLES.catalogId,
    agentId: PARAM_SAMPLES.agentId,
    approvalId: PARAM_SAMPLES.approvalId,
    subPath: 'events',
    query: {},
    body: { unit: true },
};

/** The path a row's wrapper must request, with its placeholders filled in. */
function expectedPath(row: ContractsRouteRow): string {
    if (row.wildcard) return row.path.replace('*', 'events');
    return row.path.replace(/:(\w+)/g, (_match, param: string) => {
        const sample = PARAM_SAMPLES[param];
        expect(sample, `the spec has a sample for the :${param} placeholder`).toBeDefined();
        return sample;
    });
}

/** Walk up from the cwd to `apps/web/e2e`, so the spec runs from anywhere. */
function resolveHelperSource(): string {
    const relative = 'helpers/app-works.ts';
    let dir = process.cwd();
    for (;;) {
        for (const candidate of [resolve(dir, 'e2e'), resolve(dir, 'apps/web/e2e')]) {
            if (existsSync(resolve(candidate, 'helpers'))) return resolve(candidate, relative);
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(`could not locate apps/web/e2e/${relative} from ${process.cwd()}`);
}

const STATUS_BODY = JSON.stringify({ status: 'stub', detail: 'raw body' });

describe('app-works: every CONTRACTS §4 route has an exported wrapper (T6)', () => {
    it('exposes the nine wrappers plan §8.2 names by name', () => {
        const required = [
            'inspectAppSource',
            'createAppWork',
            'getUpstream',
            'syncUpstream',
            'listBuilds',
            'getAppStatus',
            'getAppEnvNames',
            'proposeUpstreamPr',
            'getMyApps',
        ];
        const missing = required.filter(
            (name) => typeof (appWorks as unknown as Record<string, unknown>)[name] !== 'function',
        );
        expect(missing, 'no wrapper named by plan §8.2 may be missing').toEqual([]);
    });

    it('gives every route row its own exported wrapper and its own id', () => {
        const ids = CONTRACTS_S4_ROUTES.map((row) => row.id);
        expect(new Set(ids).size, 'route row ids are unique').toBe(ids.length);
        const wrappers = CONTRACTS_S4_ROUTES.map((row) => row.wrapper);
        expect(new Set(wrappers).size, 'each route row names its own wrapper').toBe(
            wrappers.length,
        );
        const without = CONTRACTS_S4_ROUTES.filter(
            (row) =>
                typeof (appWorks as unknown as Record<string, unknown>)[row.wrapper] !== 'function',
        ).map((row) => `${row.id}:${row.wrapper}`);
        expect(without, 'no route row may lack an exported wrapper').toEqual([]);
        expect(
            CONTRACTS_S4_ROUTES.every((row) => row.path.startsWith('/api/')),
            'every row is an /api route',
        ).toBe(true);
    });

    it('marks the routes of the unshipped epics as unshipped', () => {
        const byOwner = new Map<string, boolean[]>();
        for (const row of CONTRACTS_S4_ROUTES) {
            byOwner.set(row.owner, [...(byOwner.get(row.owner) ?? []), row.shipped]);
        }
        // Wave 2 epics ship nothing yet: every route of APW-10 and APW-12 is
        // contract-only, which is what the "Unshipped / contract-only" doc
        // comments on their wrappers say.
        for (const owner of ['APW-10', 'APW-12']) {
            const flags = byOwner.get(owner) ?? [];
            expect(flags.length, `${owner} has rows`).toBeGreaterThan(0);
            expect(
                flags.every((shipped) => !shipped),
                `${owner} rows are unshipped`,
            ).toBe(true);
        }
    });

    it('documents every unshipped wrapper as unshipped/contract-only', () => {
        const source = readFileSync(resolveHelperSource(), 'utf8');
        expect(source).toContain('Unshipped / contract-only');
        const undocumented = CONTRACTS_S4_ROUTES.filter((row) => !row.shipped)
            .filter((row) => {
                const declaration = source.indexOf(`export function ${row.wrapper}`);
                expect(
                    declaration,
                    `${row.wrapper} is declared in the helper source`,
                ).toBeGreaterThan(-1);
                const doc = source.slice(Math.max(0, declaration - 1500), declaration);
                return !doc.includes('Unshipped / contract-only');
            })
            .map((row) => `${row.id}:${row.wrapper}`);
        expect(undocumented, 'each unshipped route is documented as unshipped').toEqual([]);
    });
});

describe('app-works: wrappers return the raw status and body and never throw (T6)', () => {
    it.each([200, 201, 204, 400, 409, 500, 503])(
        'passes a %i through as { status, ok, text, json } for every route row',
        async (status) => {
            for (const row of CONTRACTS_S4_ROUTES) {
                const { request, calls } = stubRequest({ status, body: STATUS_BODY });
                const result = await wrapperFor(row.wrapper)(request, { ...SAMPLE_INPUT });
                const where = `${row.id} ${row.wrapper} → ${row.method} ${row.path}`;

                expect(result.status, where).toBe(status);
                expect(result.ok, where).toBe(status >= 200 && status < 300);
                expect(result.text, where).toBe(STATUS_BODY);
                expect(result.json, where).toEqual({ status: 'stub', detail: 'raw body' });

                expect(calls.length, `${where}: exactly one request`).toBe(1);
                expect(calls[0].method, where).toBe(row.method);
                const [path] = calls[0].url.split('?');
                expect(path, where).toBe(`http://unit.test${expectedPath(row)}`);
            }
        },
    );

    it('reports a transport failure as status 0 instead of throwing', async () => {
        const stub = failingRequest(new Error('connect ECONNREFUSED 127.0.0.1:3100'));
        const result = await appWorks.getAppStatus(stub.request, {
            token: 'unit-token',
            baseUrl: 'http://unit.test',
            workId: 'work-1',
        });
        expect(stub.reads()).toBe(1);
        expect(result.status).toBe(0);
        expect(result.ok).toBe(false);
        expect(result.json).toBeNull();
        expect(result.networkError).toContain('ECONNREFUSED');
    });

    it('returns an empty body as text "" and json null, without throwing', async () => {
        const { request } = stubRequest({ status: 204, body: '' });
        const result = await appWorks.getMyApps(request, { token: 'unit-token' });
        expect(result.status).toBe(204);
        expect(result.text).toBe('');
        expect(result.json).toBeNull();
    });

    it('tolerates a non-JSON body (a 502 HTML page) without throwing', async () => {
        const { request } = stubRequest({ status: 502, body: '<html>bad gateway</html>' });
        const result = await appWorks.listBuilds(request, {
            token: 'unit-token',
            workId: 'work-1',
        });
        expect(result.status).toBe(502);
        expect(result.json).toBeNull();
        expect(result.text).toContain('bad gateway');
    });
});

describe('app-works: request shaping', () => {
    it('sends the app-kind create body with kind: "app" forced', async () => {
        const { request, calls } = stubRequest({ status: 200, body: '{}' });
        await appWorks.createAppWork(request, {
            token: 'unit-token',
            baseUrl: 'http://unit.test',
            body: appWorkCreateBody({
                repositoryUrl: 'https://github.com/ever-works/app-fixture-hello',
                repositoryMode: 'fork',
                targetOwner: 'ever-works-e2e',
                name: 'fixture',
            }),
        });
        expect(calls[0].method).toBe('POST');
        expect(calls[0].url).toBe('http://unit.test/api/works');
        expect(calls[0].data).toEqual({
            kind: 'app',
            repositoryUrl: 'https://github.com/ever-works/app-fixture-hello',
            repositoryMode: 'fork',
            targetOwner: 'ever-works-e2e',
            name: 'fixture',
        });
    });

    it('sends the app-source inspect body as given', async () => {
        const { request, calls } = stubRequest({ status: 200, body: '{}' });
        await appWorks.inspectAppSource(request, {
            token: 'unit-token',
            body: appSourceInspectBody({
                repositoryUrl: 'https://github.com/calcom/cal.diy',
                blueprintId: 'cal-diy',
            }),
        });
        expect(calls[0].data).toEqual({
            repositoryUrl: 'https://github.com/calcom/cal.diy',
            blueprintId: 'cal-diy',
        });
    });

    it('carries the bearer token, and no auth header when none is given', async () => {
        const withToken = stubRequest({ status: 200, body: '{}' });
        await appWorks.getUpstream(withToken.request, { token: 'unit-token', workId: 'work-1' });
        expect(withToken.calls[0].headers.Authorization).toBe('Bearer unit-token');

        const anonymous = stubRequest({ status: 200, body: '{}' });
        await appWorks.getAppSpecSchema(anonymous.request);
        expect(anonymous.calls[0].headers.Authorization).toBeUndefined();
    });

    it('drops undefined query values and keeps the defined ones', async () => {
        const { request, calls } = stubRequest({ status: 200, body: '{}' });
        await appWorks.getMyApps(request, {
            token: 'unit-token',
            baseUrl: 'http://unit.test',
            query: { limit: 25, cursor: undefined },
        });
        expect(calls[0].url).toBe('http://unit.test/api/me/apps?limit=25');
    });

    it('refuses a wildcard sub-path that would escape its prefix', () => {
        const { request } = stubRequest({ status: 200, body: '{}' });
        expect(() => appWorks.adminAppsTier(request, { subPath: '../../works' })).toThrow(
            /sub-path must be a relative path under the prefix/,
        );
        expect(() => appWorks.everIdRoute(request, { subPath: 'https://evil.test/x' })).toThrow(
            /sub-path must be a relative path under the prefix/,
        );
    });
});
