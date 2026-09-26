import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './api';

/**
 * App Works API wrappers — the raw-status surface the live lanes build on.
 *
 * Three rules this module exists to enforce, taken from APW-13 task T6 and plan
 * §8.2 (`docs/specs/features/app-works/APW-13-golden-paths/plan.md:494-506`):
 *
 * 1. **Never throw on an HTTP status.** A wrapper returns
 *    `{ status, ok, text, json }` for `2xx`, `4xx` and `5xx` alike, so a spec can
 *    assert the exact refusal a route documents (`400 app_works_disabled`,
 *    `409 create_in_progress`, `422 followUpLimit`, `429` …) instead of
 *    pattern-matching a thrown Playwright error. `APIRequestContext.fetch`
 *    already returns a response object for every status code (it does not throw
 *    on `!ok`); the only rejection left is a transport failure, which is
 *    reported as `status: 0` plus `networkError` rather than thrown.
 * 2. **Every route in CONTRACTS §4 is reachable through exactly one wrapper.**
 *    {@link CONTRACTS_S4_ROUTES} is the table
 *    (`docs/specs/features/app-works/CONTRACTS.md:383-479`) and
 *    `__tests__/app-works.unit.spec.ts` derives its coverage assertions from it
 *    rather than from a hand-copied list — a route row without an exported
 *    wrapper fails the unit spec.
 * 3. **Unshipped routes are still wrapped, and are documented as such.** The
 *    harness is P0: it ships before the epics it drives (plan §12). A wrapper
 *    for a route whose handler does not exist yet is exported anyway and its
 *    doc comment opens with **Unshipped / contract-only**, so a lane that calls
 *    it fails as the documented `404` rather than as an ad-hoc URL typo. The
 *    `shipped` flag on its {@link ContractsRouteRow} carries the same fact
 *    machine-readably; it is `false` for a route with no handler in
 *    `apps/api/src` at the time this table was written (verified 2026-09-17 by
 *    grepping the controller route strings), and for the routes CONTRACTS §4
 *    lists under "Routes named only in epic plans" (`CONTRACTS.md:469-475`).
 *
 * Adding a route: append one row to {@link CONTRACTS_S4_ROUTES} **and** the
 * wrapper it names, in the same change — the unit spec fails otherwise.
 */

/** The five verbs the App Works route table uses. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The raw result every wrapper returns. Never a thrown status. */
export interface RawApiResult<T = unknown> {
    /** The HTTP status, or `0` when the request never reached the API. */
    status: number;
    /** `true` for `2xx` only. */
    ok: boolean;
    /** The response body as text (empty string for a `204`). */
    text: string;
    /** The parsed body, or `null` when it is empty or not JSON. */
    json: T | null;
    /** Set only when the request itself failed (DNS, refused connection, timeout). */
    networkError?: string;
}

/** Query parameters; `undefined` entries are dropped rather than sent as `undefined`. */
export type QueryInput = Record<string, string | number | boolean | undefined>;

/** Everything a wrapper accepts besides the route-specific fields. */
export interface WrapperOptions {
    /** Bearer token. Omitted for the public routes (catalog, launcher, schema). */
    token?: string;
    /** Extra headers merged over the auth header. */
    headers?: Record<string, string>;
    /** Overrides {@link API_BASE} — the unit spec points this at a stub. */
    baseUrl?: string;
    /** Query parameters. */
    query?: QueryInput;
}

/** A wrapper input that is scoped to one App Work. */
export interface WorkScopedInput extends WrapperOptions {
    workId: string;
}

/** A wrapper input that also carries a body. */
export interface BodyInput<T> {
    body?: T;
}

/** Encode one path segment. */
function seg(value: string): string {
    return encodeURIComponent(value);
}

/** Append the query, if any, to a resolved URL. */
function withQuery(url: string, query: QueryInput | undefined): string {
    if (!query) return url;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `${url}?${qs}` : url;
}

/**
 * Issue one request and normalise the answer into {@link RawApiResult}.
 *
 * This is the single code path behind every wrapper: one method argument, one
 * raw status out, no throwing on a status code, no throwing on a transport
 * failure.
 */
export async function rawApi<T = unknown>(
    request: APIRequestContext,
    method: HttpMethod,
    path: string,
    options: WrapperOptions & BodyInput<unknown> = {},
): Promise<RawApiResult<T>> {
    const base = (options.baseUrl ?? API_BASE).replace(/\/+$/, '');
    const url = withQuery(`${base}${path}`, options.query);
    const headers: Record<string, string> = {
        ...(options.token ? authedHeaders(options.token) : {}),
        ...(options.headers ?? {}),
    };

    let response;
    try {
        response = await request.fetch(url, {
            method,
            headers,
            data: options.body as never,
        });
    } catch (error) {
        return {
            status: 0,
            ok: false,
            text: '',
            json: null,
            networkError: error instanceof Error ? error.message : String(error),
        };
    }

    const text = await response.text();
    let json: T | null = null;
    if (text.length > 0) {
        try {
            json = JSON.parse(text) as T;
        } catch {
            json = null;
        }
    }
    const status = response.status();
    return { status, ok: status >= 200 && status < 300, text, json };
}

/**
 * Join a caller-supplied sub-path onto a route prefix.
 *
 * Used by the two wildcard families in the CONTRACTS §4 table
 * (`/api/admin/apps-tier/*`, `/api/auth/ever-id/*`). A sub-path that would
 * escape its prefix is a programming error in the harness, not an HTTP answer,
 * so it throws instead of silently requesting another route.
 */
function subPathUrl(prefix: string, subPath: string): string {
    const cleaned = subPath.replace(/^\/+/, '').trim();
    if (!cleaned || cleaned.includes('..') || /^[a-z]+:\/\//i.test(cleaned)) {
        throw new Error(`${prefix} wrapper: sub-path must be a relative path under the prefix`);
    }
    return `${prefix}${cleaned}`;
}

/** One file-upload/documented row of the CONTRACTS §4 App Works route table. */
export interface ContractsRouteRow {
    /** Stable row id, `<EPIC>-<n>`, for failure messages. */
    id: string;
    /** The epic that owns the route. */
    owner: string;
    method: HttpMethod;
    /**
     * The path template exactly as CONTRACTS §4 writes it, `:param`
     * placeholders included. `:id` is the App Work id — the wrapper field for
     * it is `workId`. A template ending in `*` is a wildcard family: its
     * wrapper takes a caller-supplied `subPath`.
     */
    path: string;
    /** The exported wrapper that reaches this row. */
    wrapper: string;
    /**
     * `false` ⇒ **unshipped / contract-only**: no handler for this route exists
     * in `apps/api/src` yet, so a live call answers `404`. The wrapper is
     * exported (and documented as unshipped) so the contract is pinned before
     * the epic lands.
     */
    shipped: boolean;
    /** `true` for the wildcard families. */
    wildcard?: boolean;
    /** Anything non-obvious about the row (existing route + new branch, plan-only). */
    note?: string;
}

/**
 * The CONTRACTS §4 App Works route list, one row per route, each naming the
 * wrapper that reaches it. `__tests__/app-works.unit.spec.ts` derives its
 * coverage and path assertions from this table.
 */
export const CONTRACTS_S4_ROUTES: readonly ContractsRouteRow[] = [
    // ---- APW-01 — App Work kind, create from any repository URL ----
    {
        id: '01-1',
        owner: 'APW-01',
        method: 'POST',
        path: '/api/works',
        wrapper: 'createAppWork',
        shipped: false,
        note: 'the route exists; the `kind: app` branch does not — the DTO refuses `app` today',
    },
    {
        id: '01-2',
        owner: 'APW-01',
        method: 'POST',
        path: '/api/works/app-source/inspect',
        wrapper: 'inspectAppSource',
        shipped: false,
    },
    {
        id: '01-3',
        owner: 'APW-01',
        method: 'POST',
        path: '/api/works/:id/delete',
        wrapper: 'deleteWorkViaAPI',
        shipped: true,
        note: 'existing route; `delete_stored_data` for kind `app` is the APW-01 addition',
    },
    // ---- APW-02 — fork lifecycle ----
    {
        id: '02-1',
        owner: 'APW-02',
        method: 'GET',
        path: '/api/works/:id/upstream',
        wrapper: 'getUpstream',
        shipped: false,
    },
    {
        id: '02-2',
        owner: 'APW-02',
        method: 'POST',
        path: '/api/works/:id/upstream/sync',
        wrapper: 'syncUpstream',
        shipped: false,
    },
    {
        id: '02-3',
        owner: 'APW-02',
        method: 'POST',
        path: '/api/works/:id/upstream/readiness/retry',
        wrapper: 'retryUpstreamReadiness',
        shipped: false,
    },
    // ---- APW-03 — App spec and catalog ----
    {
        id: '03-1',
        owner: 'APW-03',
        method: 'GET',
        path: '/api/apps-catalog',
        wrapper: 'listAppsCatalog',
        shipped: false,
    },
    {
        id: '03-2',
        owner: 'APW-03',
        method: 'GET',
        path: '/api/apps-catalog/:catalogId',
        wrapper: 'getAppsCatalogEntry',
        shipped: false,
    },
    {
        id: '03-3',
        owner: 'APW-03',
        method: 'GET',
        path: '/api/apps-catalog/licenses',
        wrapper: 'listAppCatalogLicenses',
        shipped: false,
    },
    {
        id: '03-4',
        owner: 'APW-03',
        method: 'GET',
        path: '/api/schema/app-spec.schema.json',
        wrapper: 'getAppSpecSchema',
        shipped: true,
    },
    {
        id: '03-5',
        owner: 'APW-03',
        method: 'GET',
        path: '/api/works/:id/app-spec',
        wrapper: 'getAppSpec',
        shipped: false,
    },
    {
        id: '03-6',
        owner: 'APW-03',
        method: 'POST',
        path: '/api/works/:id/app-spec/validate',
        wrapper: 'validateAppSpec',
        shipped: false,
    },
    {
        id: '03-7',
        owner: 'APW-03',
        method: 'POST',
        path: '/api/works/:id/app-spec/blueprint',
        wrapper: 'applyAppSpecBlueprint',
        shipped: false,
    },
    {
        id: '03-8',
        owner: 'APW-03',
        method: 'POST',
        path: '/api/works/:id/app-spec/blueprint/upgrade',
        wrapper: 'upgradeAppSpecBlueprint',
        shipped: false,
    },
    {
        id: '03-9',
        owner: 'APW-03',
        method: 'POST',
        path: '/api/works/:id/app-spec/blueprint/dismiss',
        wrapper: 'dismissAppSpecBlueprint',
        shipped: false,
    },
    {
        id: '03-10',
        owner: 'APW-03',
        method: 'POST',
        path: '/api/works/:id/app-license/attest',
        wrapper: 'attestAppLicense',
        shipped: false,
    },
    // ---- APW-04 — App Provisioner ----
    {
        id: '04-1',
        owner: 'APW-04',
        method: 'POST',
        path: '/api/works/:id/provision',
        wrapper: 'provisionAppWork',
        shipped: false,
    },
    {
        id: '04-2',
        owner: 'APW-04',
        method: 'GET',
        path: '/api/works/:id/provisioning',
        wrapper: 'getProvisioning',
        shipped: false,
    },
    {
        id: '04-3',
        owner: 'APW-04',
        method: 'POST',
        path: '/api/works/:id/provision/cancel',
        wrapper: 'cancelProvision',
        shipped: false,
    },
    {
        id: '04-4',
        owner: 'APW-04',
        method: 'POST',
        path: '/api/works/:id/provisioning/:provisioningId/blueprint-suggestion',
        wrapper: 'suggestProvisioningBlueprint',
        shipped: false,
    },
    {
        id: '04-5',
        owner: 'APW-04',
        method: 'GET',
        path: '/api/admin/app-blueprint-suggestions',
        wrapper: 'listAdminBlueprintSuggestions',
        shipped: false,
    },
    {
        id: '04-6',
        owner: 'APW-04',
        method: 'GET',
        path: '/api/admin/app-blueprint-suggestions/:provisioningId/bundle',
        wrapper: 'getAdminBlueprintSuggestionBundle',
        shipped: false,
    },
    // ---- APW-05 — Builds ----
    {
        id: '05-1',
        owner: 'APW-05',
        method: 'GET',
        path: '/api/works/:id/builds',
        wrapper: 'listBuilds',
        shipped: false,
    },
    {
        id: '05-2',
        owner: 'APW-05',
        method: 'GET',
        path: '/api/works/:id/builds/:buildId',
        wrapper: 'getBuild',
        shipped: false,
    },
    {
        id: '05-3',
        owner: 'APW-05',
        method: 'POST',
        path: '/api/works/:id/builds',
        wrapper: 'startBuild',
        shipped: false,
    },
    {
        id: '05-4',
        owner: 'APW-05',
        method: 'POST',
        path: '/api/works/:id/builds/:buildId/cancel',
        wrapper: 'cancelBuild',
        shipped: false,
    },
    {
        id: '05-5',
        owner: 'APW-05',
        method: 'PUT',
        path: '/api/works/:id/builds/pull-token',
        wrapper: 'putBuildsPullToken',
        shipped: false,
        note: 'CONTRACTS §4 "named only in epic plans" (CONTRACTS.md:472) — no literal row yet',
    },
    // ---- APW-06 — App runtime ----
    {
        id: '06-1',
        owner: 'APW-06',
        method: 'POST',
        path: '/api/deploy/works/:id',
        wrapper: 'deployAppWork',
        shipped: false,
        note: 'existing deploy route; APW-06 adds the kind-`app` branch',
    },
    {
        id: '06-2',
        owner: 'APW-06',
        method: 'GET',
        path: '/api/works/:id/app-status',
        wrapper: 'getAppStatus',
        shipped: false,
    },
    {
        id: '06-3',
        owner: 'APW-06',
        method: 'POST',
        path: '/api/works/:id/app-jobs/:name/run',
        wrapper: 'runAppJob',
        shipped: false,
    },
    {
        id: '06-4',
        owner: 'APW-06',
        method: 'POST',
        path: '/api/works/:id/app-status/refresh',
        wrapper: 'refreshAppStatus',
        shipped: false,
    },
    {
        id: '06-5',
        owner: 'APW-06',
        method: 'POST',
        path: '/api/works/:id/app-smoke',
        wrapper: 'runAppSmoke',
        shipped: false,
    },
    {
        id: '06-6',
        owner: 'APW-06',
        method: 'POST',
        path: '/api/works/:id/app-rollback',
        wrapper: 'rollbackApp',
        shipped: false,
    },
    {
        id: '06-7',
        owner: 'APW-06',
        method: 'POST',
        path: '/api/works/:id/app-lifecycle',
        wrapper: 'setAppLifecycle',
        shipped: false,
    },
    {
        id: '06-8',
        owner: 'APW-06',
        method: 'POST',
        path: '/api/works/:id/app-logs',
        wrapper: 'requestAppLogs',
        shipped: false,
    },
    {
        id: '06-9',
        owner: 'APW-06',
        method: 'GET',
        path: '/api/works/:id/app-logs/:requestId',
        wrapper: 'getAppLogs',
        shipped: false,
    },
    {
        id: '06-10',
        owner: 'APW-06',
        method: 'GET',
        path: '/api/works/:id/app-target',
        wrapper: 'getAppTarget',
        shipped: false,
    },
    {
        id: '06-11',
        owner: 'APW-06',
        method: 'PUT',
        path: '/api/works/:id/app-target',
        wrapper: 'putAppTarget',
        shipped: false,
    },
    {
        id: '06-12',
        owner: 'APW-06',
        method: 'POST',
        path: '/api/works/:id/app-target/check',
        wrapper: 'checkAppTarget',
        shipped: false,
    },
    {
        id: '06-13',
        owner: 'APW-06',
        method: 'POST',
        path: '/api/works/:id/app-target/kubeconfig',
        wrapper: 'putAppTargetKubeconfig',
        shipped: false,
        note: 'the only App Work path that stores a kubeconfig (CONTRACTS.md:412)',
    },
    {
        id: '06-14',
        owner: 'APW-06',
        method: 'GET',
        path: '/api/works/:id/app-deletion-preview',
        wrapper: 'getAppDeletionPreview',
        shipped: false,
    },
    {
        id: '06-15',
        owner: 'APW-06',
        method: 'GET',
        path: '/api/deploy/works/:id/deployments',
        wrapper: 'listDeployments',
        shipped: false,
        note: 'CONTRACTS §4 "named only in epic plans" (CONTRACTS.md:472)',
    },
    // ---- APW-07 — App env and dependencies ----
    {
        id: '07-1',
        owner: 'APW-07',
        method: 'GET',
        path: '/api/works/:id/app-env',
        wrapper: 'getAppEnvNames',
        shipped: false,
        note: 'names, origins and set/unset only — never values',
    },
    {
        id: '07-2',
        owner: 'APW-07',
        method: 'PUT',
        path: '/api/works/:id/app-env',
        wrapper: 'putAppEnv',
        shipped: false,
    },
    {
        id: '07-3',
        owner: 'APW-07',
        method: 'POST',
        path: '/api/works/:id/app-env/:name/rotate',
        wrapper: 'rotateAppEnv',
        shipped: false,
    },
    {
        id: '07-4',
        owner: 'APW-07',
        method: 'GET',
        path: '/api/works/:id/app-dependencies',
        wrapper: 'getAppDependencies',
        shipped: false,
    },
    {
        id: '07-5',
        owner: 'APW-07',
        method: 'PUT',
        path: '/api/works/:id/app-dependencies/:kind',
        wrapper: 'putAppDependency',
        shipped: false,
    },
    {
        id: '07-6',
        owner: 'APW-07',
        method: 'POST',
        path: '/api/works/:id/app-dependencies/:kind/provision',
        wrapper: 'provisionAppDependency',
        shipped: false,
    },
    {
        id: '07-7',
        owner: 'APW-07',
        method: 'DELETE',
        path: '/api/works/:id/app-dependencies/:kind',
        wrapper: 'deleteAppDependency',
        shipped: false,
    },
    {
        id: '07-8',
        owner: 'APW-07',
        method: 'PUT',
        path: '/api/deploy/works/:id/runtime-env',
        wrapper: 'putRuntimeEnv',
        shipped: false,
        note: 'CONTRACTS §4 "named only in epic plans" (CONTRACTS.md:473)',
    },
    // ---- APW-08 — evolve loop ----
    {
        id: '08-1',
        owner: 'APW-08',
        method: 'POST',
        path: '/api/works/:id/evolve',
        wrapper: 'evolveAppWork',
        shipped: false,
    },
    {
        id: '08-2',
        owner: 'APW-08',
        method: 'GET',
        path: '/api/tasks/:taskId/delivery',
        wrapper: 'getTaskDelivery',
        shipped: false,
    },
    {
        id: '08-3',
        owner: 'APW-08',
        method: 'POST',
        path: '/api/tasks/:taskId/delivery/close',
        wrapper: 'closeTaskDelivery',
        shipped: false,
    },
    {
        id: '08-4',
        owner: 'APW-08',
        method: 'POST',
        path: '/api/tasks/:taskId/delivery/follow-up',
        wrapper: 'followUpTaskDelivery',
        shipped: false,
    },
    {
        id: '08-5',
        owner: 'APW-08',
        method: 'GET',
        path: '/api/tasks/:taskId/cost',
        wrapper: 'getTaskCost',
        shipped: false,
    },
    {
        id: '08-6',
        owner: 'APW-08',
        method: 'POST',
        path: '/api/works/:id/app-runs/allow-containment',
        wrapper: 'allowAppRunContainment',
        shipped: false,
    },
    {
        id: '08-7',
        owner: 'APW-08',
        method: 'GET',
        path: '/api/works/:id/cost',
        wrapper: 'getWorkCost',
        shipped: false,
    },
    {
        id: '08-8',
        owner: 'APW-08',
        method: 'POST',
        path: '/api/agents/:agentId/assign-task',
        wrapper: 'assignTaskToAgent',
        shipped: false,
        note: 'CONTRACTS §4 "named only in epic plans" (CONTRACTS.md:473)',
    },
    // ---- APW-09 — upstream pull requests ----
    {
        id: '09-1',
        owner: 'APW-09',
        method: 'POST',
        path: '/api/works/:id/upstream-pull-requests',
        wrapper: 'proposeUpstreamPr',
        shipped: false,
    },
    {
        id: '09-2',
        owner: 'APW-09',
        method: 'GET',
        path: '/api/works/:id/upstream-pull-requests',
        wrapper: 'listUpstreamPullRequests',
        shipped: false,
    },
    {
        id: '09-3',
        owner: 'APW-09',
        method: 'GET',
        path: '/api/works/:id/upstream-pull-requests/eligibility',
        wrapper: 'getUpstreamPrEligibility',
        shipped: false,
        note: '`?taskId=` is required by the route',
    },
    {
        id: '09-4',
        owner: 'APW-09',
        method: 'GET',
        path: '/api/works/:id/upstream-pull-requests/:prId',
        wrapper: 'getUpstreamPullRequest',
        shipped: false,
    },
    {
        id: '09-5',
        owner: 'APW-09',
        method: 'POST',
        path: '/api/works/:id/upstream-pull-requests/:prId/signed',
        wrapper: 'markUpstreamPrSigned',
        shipped: false,
    },
    {
        id: '09-6',
        owner: 'APW-09',
        method: 'POST',
        path: '/api/works/:id/upstream-pull-requests/:prId/withdraw',
        wrapper: 'withdrawUpstreamPr',
        shipped: false,
    },
    {
        id: '09-7',
        owner: 'APW-09',
        method: 'POST',
        path: '/api/works/:id/upstream-pull-requests/:prId/check',
        wrapper: 'checkUpstreamPr',
        shipped: false,
    },
    {
        id: '09-8',
        owner: 'APW-09',
        method: 'POST',
        path: '/api/works/:id/upstream-pull-requests/:prId/address-review',
        wrapper: 'addressUpstreamPrReview',
        shipped: false,
    },
    {
        id: '09-9',
        owner: 'APW-09',
        method: 'POST',
        path: '/api/works/:id/upstream-pull-requests/suggestions/:taskId/dismiss',
        wrapper: 'dismissUpstreamPrSuggestion',
        shipped: false,
    },
    {
        id: '09-10',
        owner: 'APW-09',
        method: 'POST',
        path: '/api/agent-approvals/:approvalId/approve',
        wrapper: 'approveAgentApproval',
        shipped: false,
        note: 'CONTRACTS §4 "named only in epic plans" (CONTRACTS.md:474)',
    },
    {
        id: '09-11',
        owner: 'APW-09',
        method: 'POST',
        path: '/api/agent-approvals/:approvalId/reject',
        wrapper: 'rejectAgentApproval',
        shipped: false,
        note: 'CONTRACTS §4 "named only in epic plans" (CONTRACTS.md:474)',
    },
    // ---- APW-10 — apps hosting tier (Wave 2, unshipped epic) ----
    {
        id: '10-1',
        owner: 'APW-10',
        method: 'GET',
        path: '/api/me/apps-tier',
        wrapper: 'getMyAppsTier',
        shipped: false,
    },
    {
        id: '10-2',
        owner: 'APW-10',
        method: 'GET',
        path: '/api/works/:id/apps-tier',
        wrapper: 'getAppAppsTier',
        shipped: false,
    },
    {
        id: '10-3',
        owner: 'APW-10',
        method: 'GET',
        path: '/api/admin/apps-tier/*',
        wrapper: 'adminAppsTier',
        shipped: false,
        wildcard: true,
        note: 'operator routes, platform admin — `404` for everyone else',
    },
    // ---- APW-11 — app launcher ----
    {
        id: '11-1',
        owner: 'APW-11',
        method: 'GET',
        path: '/api/me/apps',
        wrapper: 'getMyApps',
        shipped: true,
    },
    {
        id: '11-2',
        owner: 'APW-11',
        method: 'PUT',
        path: '/api/me/apps/preferences',
        wrapper: 'putMyAppsPreferences',
        shipped: true,
    },
    {
        id: '11-3',
        owner: 'APW-11',
        method: 'GET',
        path: '/api/app-launcher/platforms',
        wrapper: 'getAppLauncherPlatforms',
        shipped: true,
        note: 'public, `Cache-Control: max-age=3600`',
    },
    {
        id: '11-4',
        owner: 'APW-11',
        method: 'POST',
        path: '/api/users/me/scope',
        wrapper: 'setMyScope',
        shipped: false,
        note: 'CONTRACTS §4 "named only in epic plans" (CONTRACTS.md:474)',
    },
    // ---- APW-12 — Ever ID relying-party routes (Wave 2, unshipped epic) ----
    {
        id: '12-1',
        owner: 'APW-12',
        method: 'GET',
        path: '/api/auth/ever-id/*',
        wrapper: 'everIdRoute',
        shipped: false,
        wildcard: true,
        note: 'relying-party family; the wrapper takes the method and the sub-path',
    },
];

// ---------------------------------------------------------------------------
// APW-01 — App Work kind
// ---------------------------------------------------------------------------

/** The three repository relations an App Work can be created with (CONTRACTS §4). */
export type AppRepositoryMode = 'link' | 'fork' | 'private-copy';

/**
 * The `POST /api/works` body for `kind: 'app'`, per the APW-01 OpenAPI fragment
 * (`contracts/openapi/apw-01.openapi.yaml:230-264`). Only the fields the kind
 * adds are required; the pre-existing `CreateWorkDto` fields stay optional here.
 */
export interface AppWorkCreateBody {
    kind: 'app';
    /** ≤ 400 chars, trimmed before parsing. */
    repositoryUrl: string;
    /** Required for `kind: 'app'`; `private-copy` is a non-fork duplicate. */
    repositoryMode: AppRepositoryMode;
    /** Required for `fork` and `private-copy`; never for `link`. */
    targetOwner?: string;
    /** Optional — the supported path for a repository no catalog entry lists (FR-81). */
    blueprintId?: string;
    /** Write-only prompted App env values. Never returned by any read (FR-55). */
    appEnv?: Record<string, string>;
    /** `false` skips the App Provisioner. */
    autoProvision?: boolean;
    /** Deploy target; absent ⇒ **None** (R-12). */
    deployProvider?: string;
    name?: string;
    slug?: string;
    description?: string;
    organization?: boolean;
}

/** The `POST /api/works/app-source/inspect` body (APW-01 plan §4.1). */
export interface AppSourceInspectBody {
    /** ≤ 400 chars, trimmed before parsing. */
    repositoryUrl: string;
    /** Validated against the URL parser's host rules, never a literal list. */
    gitProvider?: string;
    /** A catalog id; when sent and not matching on create, the API answers `400 blueprint_mismatch`. */
    blueprintId?: string;
}

/**
 * Build an App Work create body. The `kind: 'app'` discriminator is forced here
 * so no spec can post an App body under another kind; `fork` and `private-copy`
 * still need their `targetOwner`, which the DTO enforces with a `400` — the
 * wrapper deliberately does not pre-empt that answer.
 */
export function appWorkCreateBody(
    input: Omit<AppWorkCreateBody, 'kind'> & { kind?: 'app' },
): AppWorkCreateBody {
    return { ...input, kind: 'app' };
}

/**
 * Build an inspect body. No side effects: the route always answers `200` for a
 * provider-side refusal, which is why its wrapper is the one place a spec checks
 * `blueprint.status` and the per-mode availability entries.
 */
export function appSourceInspectBody(input: AppSourceInspectBody): AppSourceInspectBody {
    return { ...input };
}

/**
 * **Unshipped / contract-only** (APW-01): `POST /api/works` with
 * `kind: 'app'` — the route exists, the App Work branch does not yet, so the
 * DTO refuses `kind: 'app'` until APW-01 lands.
 */
export function createAppWork(
    request: APIRequestContext,
    input: WrapperOptions & BodyInput<AppWorkCreateBody>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', '/api/works', input);
}

/**
 * **Unshipped / contract-only** (APW-01): `POST /api/works/app-source/inspect`
 * — ownership, push access, fork possibility, Blueprint match and licence
 * preview, with no side effects.
 */
export function inspectAppSource(
    request: APIRequestContext,
    input: WrapperOptions & BodyInput<AppSourceInspectBody>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', '/api/works/app-source/inspect', input);
}

/** `POST /api/works/:id/delete` — the existing Work delete route (R-15). */
export function deleteWorkViaAPI(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<{ confirm_slug?: string; delete_stored_data?: boolean }>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/delete`, input);
}

// ---------------------------------------------------------------------------
// APW-02 — fork lifecycle
// ---------------------------------------------------------------------------

/** **Unshipped / contract-only** (APW-02): `GET /api/works/:id/upstream`. */
export function getUpstream(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/upstream`, input);
}

/** **Unshipped / contract-only** (APW-02): `POST /api/works/:id/upstream/sync` (`202`). */
export function syncUpstream(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/upstream/sync`, input);
}

/**
 * **Unshipped / contract-only** (APW-02):
 * `POST /api/works/:id/upstream/readiness/retry` (`202`) — the **Try again** of
 * a timed-out or failed preparing App Work.
 */
export function retryUpstreamReadiness(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(
        request,
        'POST',
        `/api/works/${seg(input.workId)}/upstream/readiness/retry`,
        input,
    );
}

// ---------------------------------------------------------------------------
// APW-03 — App spec and catalog
// ---------------------------------------------------------------------------

/** **Unshipped / contract-only** (APW-03): `GET /api/apps-catalog` (public, cached). */
export function listAppsCatalog(
    request: APIRequestContext,
    input: WrapperOptions = {},
): Promise<RawApiResult> {
    return rawApi(request, 'GET', '/api/apps-catalog', input);
}

/** **Unshipped / contract-only** (APW-03): `GET /api/apps-catalog/:id` (public, cached). */
export function getAppsCatalogEntry(
    request: APIRequestContext,
    input: WrapperOptions & { catalogId: string },
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/apps-catalog/${seg(input.catalogId)}`, input);
}

/** **Unshipped / contract-only** (APW-03): `GET /api/apps-catalog/licenses` (public). */
export function listAppCatalogLicenses(
    request: APIRequestContext,
    input: WrapperOptions = {},
): Promise<RawApiResult> {
    return rawApi(request, 'GET', '/api/apps-catalog/licenses', input);
}

/** `GET /api/schema/app-spec.schema.json` — public, already routed. */
export function getAppSpecSchema(
    request: APIRequestContext,
    input: WrapperOptions = {},
): Promise<RawApiResult> {
    return rawApi(request, 'GET', '/api/schema/app-spec.schema.json', input);
}

/** **Unshipped / contract-only** (APW-03): `GET /api/works/:id/app-spec`. */
export function getAppSpec(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/app-spec`, input);
}

/** **Unshipped / contract-only** (APW-03): `POST /api/works/:id/app-spec/validate`. */
export function validateAppSpec(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/app-spec/validate`, input);
}

/** **Unshipped / contract-only** (APW-03): `POST /api/works/:id/app-spec/blueprint` (`202`). */
export function applyAppSpecBlueprint(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/app-spec/blueprint`, input);
}

/**
 * **Unshipped / contract-only** (APW-03):
 * `POST /api/works/:id/app-spec/blueprint/upgrade` (`202`).
 */
export function upgradeAppSpecBlueprint(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(
        request,
        'POST',
        `/api/works/${seg(input.workId)}/app-spec/blueprint/upgrade`,
        input,
    );
}

/**
 * **Unshipped / contract-only** (APW-03):
 * `POST /api/works/:id/app-spec/blueprint/dismiss`.
 */
export function dismissAppSpecBlueprint(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(
        request,
        'POST',
        `/api/works/${seg(input.workId)}/app-spec/blueprint/dismiss`,
        input,
    );
}

/**
 * **Unshipped / contract-only** (APW-03): `POST /api/works/:id/app-license/attest`
 * — the Work owner accepts a legal obligation (human-only, R-3).
 */
export function attestAppLicense(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/app-license/attest`, input);
}

// ---------------------------------------------------------------------------
// APW-04 — App Provisioner
// ---------------------------------------------------------------------------

/** **Unshipped / contract-only** (APW-04): `POST /api/works/:id/provision` (`202`). */
export function provisionAppWork(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/provision`, input);
}

/**
 * **Unshipped / contract-only** (APW-04): `GET /api/works/:id/provisioning` —
 * active + 10 recent + readiness.
 */
export function getProvisioning(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/provisioning`, input);
}

/** **Unshipped / contract-only** (APW-04): `POST /api/works/:id/provision/cancel` (`202`). */
export function cancelProvision(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/provision/cancel`, input);
}

/**
 * **Unshipped / contract-only** (APW-04):
 * `POST /api/works/:id/provisioning/:provisioningId/blueprint-suggestion` (`202`).
 */
export function suggestProvisioningBlueprint(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>> & { provisioningId: string },
): Promise<RawApiResult> {
    const path = `/api/works/${seg(input.workId)}/provisioning/${seg(
        input.provisioningId,
    )}/blueprint-suggestion`;
    return rawApi(request, 'POST', path, input);
}

/**
 * **Unshipped / contract-only** (APW-04): `GET /api/admin/app-blueprint-suggestions`
 * — platform admin; answers `404` for everyone else.
 */
export function listAdminBlueprintSuggestions(
    request: APIRequestContext,
    input: WrapperOptions = {},
): Promise<RawApiResult> {
    return rawApi(request, 'GET', '/api/admin/app-blueprint-suggestions', input);
}

/**
 * **Unshipped / contract-only** (APW-04):
 * `GET /api/admin/app-blueprint-suggestions/:provisioningId/bundle` — platform admin.
 */
export function getAdminBlueprintSuggestionBundle(
    request: APIRequestContext,
    input: WrapperOptions & { provisioningId: string },
): Promise<RawApiResult> {
    const path = `/api/admin/app-blueprint-suggestions/${seg(input.provisioningId)}/bundle`;
    return rawApi(request, 'GET', path, input);
}

// ---------------------------------------------------------------------------
// APW-05 — Builds
// ---------------------------------------------------------------------------

/** **Unshipped / contract-only** (APW-05): `GET /api/works/:id/builds`. */
export function listBuilds(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/builds`, input);
}

/** **Unshipped / contract-only** (APW-05): `GET /api/works/:id/builds/:buildId`. */
export function getBuild(
    request: APIRequestContext,
    input: WorkScopedInput & { buildId: string },
): Promise<RawApiResult> {
    return rawApi(
        request,
        'GET',
        `/api/works/${seg(input.workId)}/builds/${seg(input.buildId)}`,
        input,
    );
}

/**
 * **Unshipped / contract-only** (APW-05): `POST /api/works/:id/builds` (`202`)
 * — spends runner minutes, so the route is human-only (R-32).
 */
export function startBuild(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/builds`, input);
}

/** **Unshipped / contract-only** (APW-05): `POST /api/works/:id/builds/:buildId/cancel` (`202`). */
export function cancelBuild(
    request: APIRequestContext,
    input: WorkScopedInput & { buildId: string } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(
        request,
        'POST',
        `/api/works/${seg(input.workId)}/builds/${seg(input.buildId)}/cancel`,
        input,
    );
}

/**
 * **Unshipped / contract-only** (APW-05): `PUT /api/works/:id/builds/pull-token`
 * — writes a registry credential (human-only). CONTRACTS §4 lists it under
 * "Routes named only in epic plans" (`CONTRACTS.md:472`), so it has no literal
 * row in the table above and its wrapper is the contract.
 */
export function putBuildsPullToken(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'PUT', `/api/works/${seg(input.workId)}/builds/pull-token`, input);
}

// ---------------------------------------------------------------------------
// APW-06 — App runtime
// ---------------------------------------------------------------------------

/**
 * **Unshipped / contract-only** (APW-06): `POST /api/deploy/works/:id` — the
 * existing deploy route, whose kind-`app` branch APW-06 adds.
 */
export function deployAppWork(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/deploy/works/${seg(input.workId)}`, input);
}

/**
 * **Unshipped / contract-only** (APW-06): `GET /api/works/:id/app-status` — the
 * route every address, host and runtime assertion reads.
 */
export function getAppStatus(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/app-status`, input);
}

/** **Unshipped / contract-only** (APW-06): `POST /api/works/:id/app-jobs/:name/run` (`202`). */
export function runAppJob(
    request: APIRequestContext,
    input: WorkScopedInput & { name: string } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(
        request,
        'POST',
        `/api/works/${seg(input.workId)}/app-jobs/${seg(input.name)}/run`,
        input,
    );
}

/** **Unshipped / contract-only** (APW-06): `POST /api/works/:id/app-status/refresh` (`202`). */
export function refreshAppStatus(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/app-status/refresh`, input);
}

/** **Unshipped / contract-only** (APW-06): `POST /api/works/:id/app-smoke` (`202`). */
export function runAppSmoke(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/app-smoke`, input);
}

/** **Unshipped / contract-only** (APW-06): `POST /api/works/:id/app-rollback` (`202`). */
export function rollbackApp(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/app-rollback`, input);
}

/**
 * **Unshipped / contract-only** (APW-06): `POST /api/works/:id/app-lifecycle`
 * (`202`; `pause` | `resume` | `remove` | `cancel-deploy`).
 */
export function setAppLifecycle(
    request: APIRequestContext,
    input: WorkScopedInput &
        BodyInput<{
            action?: 'pause' | 'resume' | 'remove' | 'cancel-deploy';
            deleteData?: boolean;
        }>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/app-lifecycle`, input);
}

/** **Unshipped / contract-only** (APW-06): `POST /api/works/:id/app-logs` (`202`). */
export function requestAppLogs(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/app-logs`, input);
}

/** **Unshipped / contract-only** (APW-06): `GET /api/works/:id/app-logs/:requestId`. */
export function getAppLogs(
    request: APIRequestContext,
    input: WorkScopedInput & { requestId: string },
): Promise<RawApiResult> {
    const path = `/api/works/${seg(input.workId)}/app-logs/${seg(input.requestId)}`;
    return rawApi(request, 'GET', path, input);
}

/** **Unshipped / contract-only** (APW-06): `GET /api/works/:id/app-target`. */
export function getAppTarget(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/app-target`, input);
}

/** **Unshipped / contract-only** (APW-06): `PUT /api/works/:id/app-target` (human-only). */
export function putAppTarget(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'PUT', `/api/works/${seg(input.workId)}/app-target`, input);
}

/** **Unshipped / contract-only** (APW-06): `POST /api/works/:id/app-target/check` (`202`). */
export function checkAppTarget(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/app-target/check`, input);
}

/**
 * **Unshipped / contract-only** (APW-06): `POST /api/works/:id/app-target/kubeconfig`
 * — the only App Work path that stores a kubeconfig (human-only).
 */
export function putAppTargetKubeconfig(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/app-target/kubeconfig`, input);
}

/** **Unshipped / contract-only** (APW-06): `GET /api/works/:id/app-deletion-preview` (R-15). */
export function getAppDeletionPreview(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/app-deletion-preview`, input);
}

/**
 * **Unshipped / contract-only** (APW-06): `GET /api/deploy/works/:id/deployments`.
 * CONTRACTS §4 lists it under "Routes named only in epic plans"
 * (`CONTRACTS.md:472`).
 */
export function listDeployments(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/deploy/works/${seg(input.workId)}/deployments`, input);
}

// ---------------------------------------------------------------------------
// APW-07 — App env and dependencies
// ---------------------------------------------------------------------------

/**
 * **Unshipped / contract-only** (APW-07): `GET /api/works/:id/app-env` — names,
 * origins and set/unset, **never values**.
 */
export function getAppEnvNames(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/app-env`, input);
}

/** **Unshipped / contract-only** (APW-07): `PUT /api/works/:id/app-env` (human-only, writes secrets). */
export function putAppEnv(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'PUT', `/api/works/${seg(input.workId)}/app-env`, input);
}

/**
 * **Unshipped / contract-only** (APW-07):
 * `POST /api/works/:id/app-env/:name/rotate` — invalidates a live credential (human-only).
 */
export function rotateAppEnv(
    request: APIRequestContext,
    input: WorkScopedInput & { name: string } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(
        request,
        'POST',
        `/api/works/${seg(input.workId)}/app-env/${seg(input.name)}/rotate`,
        input,
    );
}

/** **Unshipped / contract-only** (APW-07): `GET /api/works/:id/app-dependencies`. */
export function getAppDependencies(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/app-dependencies`, input);
}

/**
 * **Unshipped / contract-only** (APW-07):
 * `PUT /api/works/:id/app-dependencies/:kind` (provider choice + write-only prompted config, `202`).
 */
export function putAppDependency(
    request: APIRequestContext,
    input: WorkScopedInput & { kind: string } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(
        request,
        'PUT',
        `/api/works/${seg(input.workId)}/app-dependencies/${seg(input.kind)}`,
        input,
    );
}

/**
 * **Unshipped / contract-only** (APW-07):
 * `POST /api/works/:id/app-dependencies/:kind/provision` (`202`).
 */
export function provisionAppDependency(
    request: APIRequestContext,
    input: WorkScopedInput & { kind: string } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(
        request,
        'POST',
        `/api/works/${seg(input.workId)}/app-dependencies/${seg(input.kind)}/provision`,
        input,
    );
}

/**
 * **Unshipped / contract-only** (APW-07):
 * `DELETE /api/works/:id/app-dependencies/:kind` (body `{ confirmSlug }`, `202`).
 */
export function deleteAppDependency(
    request: APIRequestContext,
    input: WorkScopedInput & { kind: string } & BodyInput<{ confirmSlug?: string }>,
): Promise<RawApiResult> {
    return rawApi(
        request,
        'DELETE',
        `/api/works/${seg(input.workId)}/app-dependencies/${seg(input.kind)}`,
        input,
    );
}

/**
 * **Unshipped / contract-only** (APW-07): `PUT /api/deploy/works/:id/runtime-env`.
 * CONTRACTS §4 lists it under "Routes named only in epic plans"
 * (`CONTRACTS.md:473`).
 */
export function putRuntimeEnv(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'PUT', `/api/deploy/works/${seg(input.workId)}/runtime-env`, input);
}

// ---------------------------------------------------------------------------
// APW-08 — evolve loop
// ---------------------------------------------------------------------------

/** **Unshipped / contract-only** (APW-08): `POST /api/works/:id/evolve` (`202`). */
export function evolveAppWork(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/evolve`, input);
}

/** **Unshipped / contract-only** (APW-08): `GET /api/tasks/:id/delivery`. */
export function getTaskDelivery(
    request: APIRequestContext,
    input: WrapperOptions & { taskId: string },
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/tasks/${seg(input.taskId)}/delivery`, input);
}

/** **Unshipped / contract-only** (APW-08): `POST /api/tasks/:id/delivery/close`. */
export function closeTaskDelivery(
    request: APIRequestContext,
    input: WrapperOptions & { taskId: string } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/tasks/${seg(input.taskId)}/delivery/close`, input);
}

/**
 * **Unshipped / contract-only** (APW-08): `POST /api/tasks/:id/delivery/follow-up`
 * (`202`, body `{ escalationId }`; every refusal answers `422 followUpLimit`).
 */
export function followUpTaskDelivery(
    request: APIRequestContext,
    input: WrapperOptions & { taskId: string } & BodyInput<{ escalationId?: string }>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/tasks/${seg(input.taskId)}/delivery/follow-up`, input);
}

/** **Unshipped / contract-only** (APW-08): `GET /api/tasks/:id/cost`. */
export function getTaskCost(
    request: APIRequestContext,
    input: WrapperOptions & { taskId: string },
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/tasks/${seg(input.taskId)}/cost`, input);
}

/**
 * **Unshipped / contract-only** (APW-08): `POST /api/works/:id/app-runs/allow-containment`
 * (`204`) — the owner allows one Fleet node's containment downgrade once (R-33).
 */
export function allowAppRunContainment(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(
        request,
        'POST',
        `/api/works/${seg(input.workId)}/app-runs/allow-containment`,
        input,
    );
}

/**
 * **Unshipped / contract-only** (APW-08): `GET /api/works/:id/cost`
 * (`WorkCostRollup`).
 */
export function getWorkCost(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/cost`, input);
}

/**
 * **Unshipped / contract-only** (APW-08): `POST /api/agents/:id/assign-task`.
 * CONTRACTS §4 lists it under "Routes named only in epic plans"
 * (`CONTRACTS.md:473`).
 */
export function assignTaskToAgent(
    request: APIRequestContext,
    input: WrapperOptions & { agentId: string } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/agents/${seg(input.agentId)}/assign-task`, input);
}

// ---------------------------------------------------------------------------
// APW-09 — upstream pull requests
// ---------------------------------------------------------------------------

/**
 * **Unshipped / contract-only** (APW-09): `POST /api/works/:id/upstream-pull-requests`
 * — proposal → approval; publishes outside the platform (human-only).
 */
export function proposeUpstreamPr(
    request: APIRequestContext,
    input: WorkScopedInput & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/works/${seg(input.workId)}/upstream-pull-requests`, input);
}

/** **Unshipped / contract-only** (APW-09): `GET /api/works/:id/upstream-pull-requests`. */
export function listUpstreamPullRequests(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/upstream-pull-requests`, input);
}

/**
 * **Unshipped / contract-only** (APW-09):
 * `GET /api/works/:id/upstream-pull-requests/eligibility?taskId=`.
 */
export function getUpstreamPrEligibility(
    request: APIRequestContext,
    input: WorkScopedInput & { taskId: string },
): Promise<RawApiResult> {
    const path = `/api/works/${seg(input.workId)}/upstream-pull-requests/eligibility`;
    return rawApi(request, 'GET', path, {
        ...input,
        query: { ...input.query, taskId: input.taskId },
    });
}

/** **Unshipped / contract-only** (APW-09): `GET /api/works/:id/upstream-pull-requests/:prId`. */
export function getUpstreamPullRequest(
    request: APIRequestContext,
    input: WorkScopedInput & { prId: string | number },
): Promise<RawApiResult> {
    const path = `/api/works/${seg(input.workId)}/upstream-pull-requests/${seg(
        String(input.prId),
    )}`;
    return rawApi(request, 'GET', path, input);
}

/** **Unshipped / contract-only** (APW-09): `POST …/:prId/signed` (`202`) — signs a CLA/DCO. */
export function markUpstreamPrSigned(
    request: APIRequestContext,
    input: WorkScopedInput & { prId: string | number } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    const path = `/api/works/${seg(input.workId)}/upstream-pull-requests/${seg(
        String(input.prId),
    )}/signed`;
    return rawApi(request, 'POST', path, input);
}

/** **Unshipped / contract-only** (APW-09): `POST …/:prId/withdraw` — a public act. */
export function withdrawUpstreamPr(
    request: APIRequestContext,
    input: WorkScopedInput & { prId: string | number } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    const path = `/api/works/${seg(input.workId)}/upstream-pull-requests/${seg(
        String(input.prId),
    )}/withdraw`;
    return rawApi(request, 'POST', path, input);
}

/** **Unshipped / contract-only** (APW-09): `POST …/:prId/check`. */
export function checkUpstreamPr(
    request: APIRequestContext,
    input: WorkScopedInput & { prId: string | number } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    const path = `/api/works/${seg(input.workId)}/upstream-pull-requests/${seg(
        String(input.prId),
    )}/check`;
    return rawApi(request, 'POST', path, input);
}

/** **Unshipped / contract-only** (APW-09): `POST …/:prId/address-review` (`202`). */
export function addressUpstreamPrReview(
    request: APIRequestContext,
    input: WorkScopedInput & { prId: string | number } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    const path = `/api/works/${seg(input.workId)}/upstream-pull-requests/${seg(
        String(input.prId),
    )}/address-review`;
    return rawApi(request, 'POST', path, input);
}

/** **Unshipped / contract-only** (APW-09): `POST …/suggestions/:taskId/dismiss`. */
export function dismissUpstreamPrSuggestion(
    request: APIRequestContext,
    input: WorkScopedInput & { taskId: string } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    const path = `/api/works/${seg(input.workId)}/upstream-pull-requests/suggestions/${seg(
        input.taskId,
    )}/dismiss`;
    return rawApi(request, 'POST', path, input);
}

/**
 * **Unshipped / contract-only** (APW-09): `POST /api/agent-approvals/:id/approve`.
 * CONTRACTS §4 lists it under "Routes named only in epic plans"
 * (`CONTRACTS.md:474`).
 */
export function approveAgentApproval(
    request: APIRequestContext,
    input: WrapperOptions & { approvalId: string } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/agent-approvals/${seg(input.approvalId)}/approve`, input);
}

/**
 * **Unshipped / contract-only** (APW-09): `POST /api/agent-approvals/:id/reject`.
 * CONTRACTS §4 lists it under "Routes named only in epic plans"
 * (`CONTRACTS.md:474`).
 */
export function rejectAgentApproval(
    request: APIRequestContext,
    input: WrapperOptions & { approvalId: string } & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', `/api/agent-approvals/${seg(input.approvalId)}/reject`, input);
}

// ---------------------------------------------------------------------------
// APW-10 — apps hosting tier (unshipped epic)
// ---------------------------------------------------------------------------

/** **Unshipped / contract-only** (APW-10): `GET /api/me/apps-tier`. */
export function getMyAppsTier(
    request: APIRequestContext,
    input: WrapperOptions = {},
): Promise<RawApiResult> {
    return rawApi(request, 'GET', '/api/me/apps-tier', input);
}

/** **Unshipped / contract-only** (APW-10): `GET /api/works/:id/apps-tier`. */
export function getAppAppsTier(
    request: APIRequestContext,
    input: WorkScopedInput,
): Promise<RawApiResult> {
    return rawApi(request, 'GET', `/api/works/${seg(input.workId)}/apps-tier`, input);
}

/**
 * **Unshipped / contract-only** (APW-10): the operator family under
 * `/api/admin/apps-tier/*`. Platform admin; `404` for everyone else. The
 * sub-path is a programming input, so a path that escapes the prefix throws
 * instead of hitting another route.
 */
export function adminAppsTier(
    request: APIRequestContext,
    input: WrapperOptions & { subPath: string; method?: HttpMethod },
): Promise<RawApiResult> {
    return rawApi(
        request,
        input.method ?? 'GET',
        subPathUrl('/api/admin/apps-tier/', input.subPath),
        input,
    );
}

// ---------------------------------------------------------------------------
// APW-11 — app launcher
// ---------------------------------------------------------------------------

/** `GET /api/me/apps` — paged launcher read for the signed-in caller. */
export function getMyApps(
    request: APIRequestContext,
    input: WrapperOptions = {},
): Promise<RawApiResult> {
    return rawApi(request, 'GET', '/api/me/apps', input);
}

/** `PUT /api/me/apps/preferences` — `1..200` changes in one save (FR-28). */
export function putMyAppsPreferences(
    request: APIRequestContext,
    input: WrapperOptions & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'PUT', '/api/me/apps/preferences', input);
}

/** `GET /api/app-launcher/platforms` — public, `Cache-Control: max-age=3600`. */
export function getAppLauncherPlatforms(
    request: APIRequestContext,
    input: WrapperOptions = {},
): Promise<RawApiResult> {
    return rawApi(request, 'GET', '/api/app-launcher/platforms', input);
}

/**
 * **Unshipped / contract-only** (APW-11): `POST /api/users/me/scope`.
 * CONTRACTS §4 lists it under "Routes named only in epic plans"
 * (`CONTRACTS.md:474`).
 */
export function setMyScope(
    request: APIRequestContext,
    input: WrapperOptions & BodyInput<Record<string, unknown>>,
): Promise<RawApiResult> {
    return rawApi(request, 'POST', '/api/users/me/scope', input);
}

// ---------------------------------------------------------------------------
// APW-12 — Ever ID relying-party routes (unshipped epic)
// ---------------------------------------------------------------------------

/**
 * **Unshipped / contract-only** (APW-12): the relying-party family under
 * `/api/auth/ever-id/*`. The wrapper takes the method and the sub-path so a
 * future spec reaches the family through the table rather than by hand.
 */
export function everIdRoute(
    request: APIRequestContext,
    input: WrapperOptions & { subPath: string; method?: HttpMethod },
): Promise<RawApiResult> {
    return rawApi(
        request,
        input.method ?? 'GET',
        subPathUrl('/api/auth/ever-id/', input.subPath),
        input,
    );
}
