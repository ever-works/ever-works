/**
 * T3 — the fake GitHub's contract test.
 *
 * `tasks.md` T3: "for every served route, the fake's response has the same keys
 * and value types as the recorded fixture; scans fixtures for token-shaped
 * strings". Its "Done when" is explicit that **both outcomes are observed** —
 * green now, and red when a key is deleted from any fake response. The red half
 * is exercised by perturbing this file's shape comparator (see the slice
 * report), not by a test that mutates the fake at runtime.
 *
 * Three independent nets, so a drift cannot slip through a gap between them:
 *
 *   1. **plan §8.3 coverage** — every route the plan's tables name has a handler.
 *   2. **fixture ↔ handler** — every route from `server.mjs`'s own route table
 *      names a fixture file that exists, and every one of them is actually
 *      called here (a route nobody calls cannot be contract-checked).
 *   3. **shape equality** — for each call, the fake's status and the key sets and
 *      value types of its response equal the recorded fixture's, to the leaf.
 *
 * Plus a fourth, added 2026-09-19 (T45): **the upstream endpoint list**, checked
 * as concrete URLs through the server's own matcher — see `T45_ROUTES`. Net 1 is
 * APW-13's plan and net 4 is APW-09's, so neither plan's rows can be edited out
 * from under the other.
 *
 * The recorded fixtures are the T1 files; their provenance, their strip rules
 * and the two deliberate departures from GitHub's payloads are in
 * `../fixtures/README.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ROUTES, createFakeGitHub } from '../server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '..', 'fixtures');
const USER_TOKEN = 'apw-e2e-user-token';
const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';

type Json = Record<string, any>;

interface Fake {
    origin: string;
    state: Json;
    start(): Promise<string>;
    stop(): Promise<void>;
    cleanup(): void;
}

interface RouteEntry {
    name: string;
    method: string;
    pattern: string;
    fixture: string | null;
}

let fake: Fake;
const captured: Record<string, string> = {};

/**
 * The plan §8.3 route table, transcribed row for row — the REST subset list
 * (plan.md:511-516) plus the consumer-derived table (plan.md:520-530). Written
 * with the plan's own `:param` spelling; `normalisePattern` reconciles it with
 * the fake's, which uses a `*rest` wildcard where a path may contain slashes.
 */
const PLAN_8_3_ROUTES: Array<{ method: string; pattern: string; plan: string }> = [
    { method: 'GET', pattern: '/user', plan: 'plan.md:511' },
    { method: 'GET', pattern: '/user/orgs', plan: 'plan.md:511' },
    { method: 'GET', pattern: '/repos/:owner/:repo', plan: 'plan.md:512' },
    { method: 'POST', pattern: '/repos/:owner/:repo/forks', plan: 'plan.md:513' },
    { method: 'POST', pattern: '/repos/:owner/:repo/generate', plan: 'plan.md:514' },
    { method: 'POST', pattern: '/repos/:owner/:repo/merge-upstream', plan: 'plan.md:514' },
    { method: 'GET', pattern: '/repos/:owner/:repo/compare/:basehead', plan: 'plan.md:514' },
    { method: 'GET', pattern: '/repos/:owner/:repo/pulls', plan: 'plan.md:515' },
    { method: 'POST', pattern: '/repos/:owner/:repo/pulls', plan: 'plan.md:515' },
    { method: 'PUT', pattern: '/repos/:owner/:repo/pulls/:number/merge', plan: 'plan.md:515' },
    { method: 'GET', pattern: '/repos/:owner/:repo/contents/:path', plan: 'plan.md:515' },
    { method: 'PUT', pattern: '/repos/:owner/:repo/contents/:path', plan: 'plan.md:515' },
    { method: 'PUT', pattern: '/repos/:owner/:repo/actions/permissions', plan: 'plan.md:516' },
    { method: 'GET', pattern: '/repos/:owner/:repo/actions/workflows', plan: 'plan.md:516' },
    { method: 'GET', pattern: '/repos/:owner/:repo/license', plan: 'plan.md:516' },
    {
        method: 'GET',
        pattern: '/repos/:owner/:repo/forks',
        plan: 'plan.md:522 (APW-02 findExistingFork)',
    },
    {
        method: 'POST',
        pattern: '/repos/:owner/:repo/git/refs',
        plan: 'plan.md:523 (APW-02/03 commitFiles)',
    },
    { method: 'PATCH', pattern: '/repos/:owner/:repo/git/refs/:ref', plan: 'plan.md:523' },
    { method: 'GET', pattern: '/repos/:owner/:repo/git/refs/:ref', plan: 'plan.md:523' },
    { method: 'POST', pattern: '/repos/:owner/:repo/git/trees', plan: 'plan.md:524' },
    { method: 'POST', pattern: '/repos/:owner/:repo/git/blobs', plan: 'plan.md:524' },
    { method: 'POST', pattern: '/repos/:owner/:repo/git/commits', plan: 'plan.md:524' },
    { method: 'GET', pattern: '/repos/:owner/:repo/git/trees/:sha', plan: 'plan.md:524' },
    { method: 'PUT', pattern: '/repos/:owner/:repo/topics', plan: 'plan.md:525' },
    { method: 'POST', pattern: '/repos/:owner/:repo/hooks', plan: 'plan.md:525' },
    { method: 'DELETE', pattern: '/repos/:owner/:repo/hooks/:id', plan: 'plan.md:525' },
    {
        method: 'PUT',
        pattern: '/repos/:owner/:repo/actions/workflows/:id/disable',
        plan: 'plan.md:526 (APW-02 Actions hygiene)',
    },
    {
        method: 'PUT',
        pattern: '/repos/:owner/:repo/actions/workflows/:id/enable',
        plan: 'plan.md:526',
    },
    {
        method: 'GET',
        pattern: '/repos/:owner/:repo/actions/secrets/public-key',
        plan: 'plan.md:527 (APW-05 build secrets)',
    },
    {
        method: 'PUT',
        pattern: '/repos/:owner/:repo/actions/secrets/:name',
        plan: 'plan.md:527',
    },
    {
        method: 'GET',
        pattern: '/repos/:owner/:repo/actions/runs',
        plan: 'plan.md:528 (APW-05 run-observer)',
    },
    { method: 'GET', pattern: '/repos/:owner/:repo/actions/runs/:id', plan: 'plan.md:528' },
    { method: 'GET', pattern: '/repos/:owner/:repo/actions/runs/:id/jobs', plan: 'plan.md:528' },
    {
        method: 'GET',
        pattern: '/repos/:owner/:repo/actions/runs/:id/artifacts',
        plan: 'plan.md:529',
    },
    {
        method: 'GET',
        pattern: '/repos/:owner/:repo/branches/:branch/protection',
        plan: 'plan.md:529 (APW-05 protected branch)',
    },
    {
        method: 'PUT',
        pattern: '/repos/:owner/:repo/branches/:branch/protection',
        plan: 'plan.md:529',
    },
    { method: 'GET', pattern: '/repos/:owner/:repo/branches/:branch', plan: 'plan.md:530' },
    {
        method: 'GET',
        pattern: '/repos/:owner/:repo/issues/:number/comments',
        plan: 'plan.md:530 (APW-09, APW-13 no-comment pins)',
    },
    {
        method: 'POST',
        pattern: '/repos/:owner/:repo/issues/:number/comments',
        plan: 'plan.md:530',
    },
];

/**
 * The call plan. **Order matters** and is load-bearing in four places, each
 * commented where it appears: a route that seeds lazily must be called before a
 * route that reads what it seeded, a route that mutates must come after the
 * reads that expect the un-mutated shape, a blob sha has to be captured before
 * it can be fetched, and (T45) a ref has to be created before the delete that
 * removes it.
 */
const CALL_PLAN: Array<{
    route: string;
    method: string;
    path: string | (() => string);
    body?: unknown;
    status: number;
}> = [
    { route: 'get-authenticated-user', method: 'GET', path: '/user', status: 200 },
    { route: 'list-user-orgs', method: 'GET', path: '/user/orgs', status: 200 },
    { route: 'get-repository', method: 'GET', path: '/repos/ever-works/templates', status: 200 },
    { route: 'list-forks', method: 'GET', path: '/repos/ever-works/templates/forks', status: 200 },
    {
        route: 'get-repository-topics',
        method: 'GET',
        path: '/repos/ever-works/templates/topics',
        status: 200,
    },
    {
        route: 'get-repository-license',
        method: 'GET',
        path: '/repos/ever-works/templates/license',
        status: 200,
    },
    {
        route: 'compare-commits',
        method: 'GET',
        path: '/repos/ever-works/templates/compare/main...apw-e2e-head',
        status: 200,
    },
    {
        route: 'get-git-ref',
        method: 'GET',
        path: '/repos/ever-works/templates/git/refs/heads/main',
        status: 200,
    },
    {
        route: 'get-git-ref-singular',
        method: 'GET',
        path: '/repos/ever-works/templates/git/ref/heads/main',
        status: 200,
    },
    {
        route: 'get-git-tree',
        method: 'GET',
        path: '/repos/ever-works/templates/git/trees/main',
        status: 200,
    },
    {
        route: 'get-branch',
        method: 'GET',
        path: '/repos/ever-works/umami-template/branches/main',
        status: 200,
    },

    // Actions: read first, dispatch last — `list-actions-workflows` seeds the two
    // workflows the disable/enable calls address, and `list-workflow-runs` seeds
    // the completed run whose id the run/jobs/artifacts calls then use.
    {
        route: 'get-actions-permissions',
        method: 'GET',
        path: '/repos/ever-works/templates/actions/permissions',
        status: 200,
    },
    {
        route: 'set-actions-permissions',
        method: 'PUT',
        path: '/repos/ever-works/templates/actions/permissions',
        body: { enabled: true, allowed_actions: 'all' },
        status: 204,
    },
    {
        route: 'list-actions-workflows',
        method: 'GET',
        path: '/repos/ever-works/templates/actions/workflows',
        status: 200,
    },
    {
        route: 'disable-actions-workflow',
        method: 'PUT',
        path: '/repos/ever-works/templates/actions/workflows/900001/disable',
        status: 204,
    },
    {
        route: 'enable-actions-workflow',
        method: 'PUT',
        path: '/repos/ever-works/templates/actions/workflows/900001/enable',
        status: 204,
    },
    {
        route: 'get-actions-secret-public-key',
        method: 'GET',
        path: '/repos/ever-works/templates/actions/secrets/public-key',
        status: 200,
    },
    {
        route: 'put-actions-secret',
        method: 'PUT',
        path: '/repos/ever-works/templates/actions/secrets/EW_BUILD_TOKEN',
        body: { encrypted_value: 'bm90LWEtcmVhbC1zZWNyZXQ=', key_id: 'apw-e2e-fake-key-id-0001' },
        status: 201,
    },
    {
        route: 'list-workflow-runs',
        method: 'GET',
        path: '/repos/ever-works/templates/actions/runs',
        status: 200,
    },
    {
        route: 'get-workflow-run',
        method: 'GET',
        path: '/repos/ever-works/templates/actions/runs/960001',
        status: 200,
    },
    {
        route: 'list-workflow-run-jobs',
        method: 'GET',
        path: '/repos/ever-works/templates/actions/runs/960001/jobs',
        status: 200,
    },
    {
        route: 'list-workflow-run-artifacts',
        method: 'GET',
        path: '/repos/ever-works/templates/actions/runs/960001/artifacts',
        status: 200,
    },
    {
        route: 'dispatch-actions-workflow',
        method: 'POST',
        path: '/repos/ever-works/templates/actions/workflows/900001/dispatches',
        body: { ref: 'main' },
        status: 204,
    },

    // Contents: write then read, and capture the blob sha the GET must address.
    {
        route: 'create-or-update-file',
        method: 'PUT',
        path: '/repos/ever-works/templates/contents/.works/works.yml',
        body: {
            message: 'Add the App spec',
            content: Buffer.from('version: 1\nkind: app\n', 'utf8').toString('base64'),
            branch: 'main',
        },
        status: 200,
    },
    {
        route: 'get-repository-content',
        method: 'GET',
        path: '/repos/ever-works/templates/contents/.works/works.yml',
        status: 200,
    },
    {
        route: 'get-repository-readme',
        method: 'GET',
        path: '/repos/ever-works/templates/readme',
        status: 200,
    },
    {
        route: 'create-git-blob',
        method: 'POST',
        path: '/repos/ever-works/templates/git/blobs',
        body: { content: 'version: 1\nkind: app\n', encoding: 'utf-8' },
        status: 201,
    },
    {
        route: 'get-git-blob',
        method: 'GET',
        path: () => `/repos/ever-works/templates/git/blobs/${captured.blobSha}`,
        status: 200,
    },
    {
        route: 'create-git-tree',
        method: 'POST',
        path: '/repos/ever-works/templates/git/trees',
        body: {
            tree: [
                {
                    path: '.works/works.yml',
                    mode: '100644',
                    type: 'blob',
                    content: 'version: 1\nkind: app\n',
                },
            ],
        },
        status: 201,
    },
    {
        route: 'create-git-commit',
        method: 'POST',
        path: '/repos/ever-works/templates/git/commits',
        body: { message: 'Add the App spec', tree: SHA_B, parents: [] },
        status: 201,
    },
    {
        route: 'create-git-ref',
        method: 'POST',
        path: '/repos/ever-works/templates/git/refs',
        body: { ref: 'refs/heads/apw-e2e-branch', sha: SHA_A },
        status: 201,
    },
    {
        route: 'update-git-ref',
        method: 'PATCH',
        path: '/repos/ever-works/templates/git/refs/heads/apw-e2e-branch',
        body: { sha: SHA_B },
        status: 200,
    },

    // T45 — the upstream endpoints APW-09's lanes call. The branch delete is the
    // one that must come after the ref it removes was created (`create-git-ref` →
    // `update-git-ref` above), and nothing below reads `apw-e2e-branch`.
    {
        route: 'delete-git-ref',
        method: 'DELETE',
        path: '/repos/ever-works/templates/git/refs/heads/apw-e2e-branch',
        status: 204,
    },
    {
        route: 'get-interaction-limits',
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/interaction-limits',
        status: 200,
    },
    {
        route: 'list-check-runs-for-ref',
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/commits/main/check-runs',
        status: 200,
    },
    {
        route: 'list-commit-statuses-for-ref',
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/commits/main/statuses',
        status: 200,
    },
    {
        route: 'get-combined-status-for-ref',
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/commits/main/status',
        status: 200,
    },
    {
        route: 'create-repository-hook',
        method: 'POST',
        path: '/repos/ever-works/templates/hooks',
        body: {
            config: { url: 'http://127.0.0.1:3100/api/ingest/github/events' },
            events: ['push', 'pull_request'],
        },
        status: 201,
    },
    {
        route: 'delete-repository-hook',
        method: 'DELETE',
        path: '/repos/ever-works/templates/hooks/1',
        status: 204,
    },
    {
        route: 'replace-repository-topics',
        method: 'PUT',
        path: '/repos/ever-works/templates/topics',
        body: { names: ['ever-works', 'app-template'] },
        status: 200,
    },
    {
        route: 'update-branch-protection',
        method: 'PUT',
        path: '/repos/ever-works/cal-diy-template/branches/main/protection',
        body: {
            required_status_checks: { strict: true, contexts: ['build'] },
            enforce_admins: true,
        },
        status: 200,
    },
    {
        route: 'get-branch-protection',
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/branches/main/protection',
        status: 200,
    },
    {
        route: 'generate-from-template',
        method: 'POST',
        path: '/repos/ever-works/templates/generate',
        body: { owner: 'apw-e2e-org', name: 'templates-copy', include_all_branches: true },
        status: 201,
    },
    {
        route: 'merge-upstream',
        method: 'POST',
        path: '/repos/ever-works/templates/merge-upstream',
        body: { branch: 'main' },
        status: 200,
    },
    {
        route: 'create-fork',
        method: 'POST',
        path: '/repos/ever-works/templates/forks',
        body: { name: 'templates-forked' },
        status: 202,
    },

    // Pull requests: create, read, then merge last — a merge closes the pull, and
    // the reads above it expect the open shape the fixture records.
    {
        route: 'create-pull-request',
        method: 'POST',
        path: '/repos/ever-works/templates/pulls',
        body: {
            title: 'Add the App spec',
            head: 'apw-e2e-user:apw-e2e-branch',
            base: 'main',
            body: '',
        },
        status: 201,
    },
    {
        route: 'get-pull-request',
        method: 'GET',
        path: '/repos/ever-works/templates/pulls/1',
        status: 200,
    },
    {
        route: 'list-pull-requests',
        method: 'GET',
        path: '/repos/ever-works/templates/pulls',
        status: 200,
    },
    {
        route: 'list-pull-request-files',
        method: 'GET',
        path: '/repos/ever-works/templates/pulls/1/files',
        status: 200,
    },
    {
        route: 'list-pull-request-reviews',
        method: 'GET',
        path: '/repos/ever-works/templates/pulls/1/reviews',
        status: 200,
    },
    {
        route: 'list-pull-request-review-comments',
        method: 'GET',
        path: '/repos/ever-works/templates/pulls/1/comments',
        status: 200,
    },
    {
        route: 'create-pull-request-review-comment',
        method: 'POST',
        path: '/repos/ever-works/templates/pulls/1/comments',
        body: { body: 'Please add the smoke test budget.', path: '.works/works.yml', line: 3 },
        status: 201,
    },
    {
        route: 'update-pull-request',
        method: 'PATCH',
        path: '/repos/ever-works/templates/pulls/1',
        body: { state: 'open' },
        status: 200,
    },
    {
        route: 'create-issue-comment',
        method: 'POST',
        path: '/repos/ever-works/templates/issues/1/comments',
        body: { body: 'No comment was posted by the agent' },
        status: 201,
    },
    {
        route: 'list-issue-comments',
        method: 'GET',
        path: '/repos/ever-works/templates/issues/1/comments',
        status: 200,
    },
    {
        route: 'merge-pull-request',
        method: 'PUT',
        path: '/repos/ever-works/templates/pulls/1/merge',
        body: {},
        status: 200,
    },
];

/** `:x` matches one segment; `*x` matches one or more. */
function normalisePattern(pattern: string): string[] {
    return pattern
        .split('/')
        .map((segment) =>
            segment.startsWith(':') ? '*' : segment.startsWith('*') ? '**' : segment,
        );
}

/** A route covers a plan row when every segment matches, `**` covering `*`. */
function covers(routePattern: string, planPattern: string): boolean {
    const route = normalisePattern(routePattern);
    const plan = normalisePattern(planPattern);
    if (route.length !== plan.length) return false;
    return plan.every(
        (segment, index) => route[index] === segment || (segment === '*' && route[index] === '**'),
    );
}

/**
 * T45's named endpoint list, as **concrete** method+path pairs.
 *
 * `docs/specs/features/app-works/APW-09-upstream-pull-requests/tasks.md` T45
 * names the REST subset APW-09's upstream lanes call. It is a different plan from
 * APW-13's §8.3 table above — `PLAN_8_3_ROUTES` is APW-13's and stays exactly as
 * it was — so this is its own table, and it is checked a stronger way: each row
 * is a URL the fake must *answer*, dispatched through the server's own matcher
 * (`compileRoute`, a transcription of `server.mjs`'s `compile`), rather than a
 * segment-shaped plan pattern. A row whose route exists but whose wildcard cannot
 * reach the concrete path fails here, which segment counting would have missed.
 *
 * Three of the eleven rows were already served before T45 (`create-git-ref`,
 * `update-git-ref`, `compare-commits` — the last already answering
 * `total_commits`, APW-09 T1). They are pinned here deliberately: "it was already
 * there" is not a reason for it to be able to disappear.
 */
const T45_ROUTES: Array<{ method: string; path: string; task: string }> = [
    {
        method: 'POST',
        path: '/repos/ever-works/templates/git/refs',
        task: 'POST /repos/:o/:r/git/refs',
    },
    {
        method: 'PATCH',
        path: '/repos/ever-works/templates/git/refs/heads/apw-e2e-branch',
        task: 'PATCH /repos/:o/:r/git/refs/heads/*',
    },
    {
        method: 'DELETE',
        path: '/repos/ever-works/templates/git/refs/heads/apw-e2e-branch',
        task: 'DELETE /repos/:o/:r/git/refs/heads/*',
    },
    {
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/interaction-limits',
        task: 'GET /repos/:o/:r/interaction-limits',
    },
    {
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/pulls/1',
        task: 'GET /repos/:o/:r/pulls/:n',
    },
    {
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/pulls/1/reviews',
        task: 'GET /repos/:o/:r/pulls/:n/reviews',
    },
    {
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/pulls/1/comments',
        task: 'GET /repos/:o/:r/pulls/:n/comments',
    },
    {
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/commits/main/check-runs',
        task: 'GET /repos/:o/:r/commits/:ref/check-runs',
    },
    {
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/commits/main/status',
        task: 'GET /repos/:o/:r/commits/:ref/status',
    },
    {
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/commits/main/statuses',
        task: 'GET /repos/:o/:r/commits/:ref/statuses',
    },
    {
        method: 'GET',
        path: '/repos/ever-works/cal-diy-template/compare/main...apw-e2e-head',
        task: 'GET /repos/:o/:r/compare/:basehead (total_commits)',
    },
];

/**
 * Does the fake's route table answer this concrete method+path?
 *
 * A transcription of `server.mjs`'s `compile` + `matchRoute`: `:param` is one
 * segment, `*param` is the rest. Kept local rather than exported from the server
 * so the assertion is about the *table*, not about a second implementation the
 * server hands it.
 */
function fakeAnswers(method: string, path: string): boolean {
    return (ALL_ROUTES as RouteEntry[]).some((route) => {
        if (route.method !== method) return false;
        const source = route.pattern
            .split('/')
            .map((segment) => {
                if (segment.startsWith(':')) return '([^/]+)';
                if (segment.startsWith('*')) return '(.*)';
                return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            })
            .join('/');
        return new RegExp(`^${source}$`).test(path);
    });
}

function fixtureFileNames(): string[] {
    return fs
        .readdirSync(FIXTURE_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace(/\.json$/, ''));
}

function loadFixture(name: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

function describeValue(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array(${value.length})`;
    return typeof value;
}

/**
 * The comparator T3 exists for: same keys, same value types, all the way down.
 * A key missing from the fake's response, or present in it but not in the
 * fixture, is a difference — "the fake drifted" and "the fixture drifted" are
 * both failures, and the failing path says which key.
 */
function shapeDiff(expected: unknown, actual: unknown, at = '$'): string[] {
    if (expected === null) {
        return actual === null ? [] : [`${at}: expected null, got ${describeValue(actual)}`];
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) return [`${at}: expected array, got ${describeValue(actual)}`];
        if (expected.length === 0) return [];
        if (actual.length === 0) {
            return [`${at}: expected a non-empty array (the fixture records ${expected.length})`];
        }
        return actual.flatMap((entry, index) => shapeDiff(expected[0], entry, `${at}[${index}]`));
    }
    if (typeof expected === 'object') {
        if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
            return [`${at}: expected object, got ${describeValue(actual)}`];
        }
        const problems: string[] = [];
        for (const key of Object.keys(expected as Json)) {
            if (!(key in (actual as Json))) {
                problems.push(`${at}.${key}: missing from the fake's response`);
                continue;
            }
            problems.push(
                ...shapeDiff((expected as Json)[key], (actual as Json)[key], `${at}.${key}`),
            );
        }
        for (const key of Object.keys(actual as Json)) {
            if (!(key in (expected as Json))) {
                problems.push(
                    `${at}.${key}: present in the fake's response but not in the fixture`,
                );
            }
        }
        return problems;
    }
    return typeof expected === typeof actual
        ? []
        : [`${at}: expected ${typeof expected}, got ${typeof actual}`];
}

async function callRoute(
    entry: (typeof CALL_PLAN)[number],
): Promise<{ status: number; body: any }> {
    const routePath = typeof entry.path === 'function' ? entry.path() : entry.path;
    const headers: Record<string, string> = { authorization: `Bearer ${USER_TOKEN}` };
    if (entry.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${fake.origin}${routePath}`, {
        method: entry.method,
        headers,
        body: entry.body === undefined ? undefined : JSON.stringify(entry.body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}

beforeAll(async () => {
    fake = createFakeGitHub({ port: 0 }) as unknown as Fake;
    await fake.start();
    const seed = JSON.parse(
        fs.readFileSync(path.join(FIXTURE_DIR, 'catalog-pr-lane.seed.json'), 'utf8'),
    );
    const seeded = await fetch(`${fake.origin}/_control/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(seed),
    });
    expect(seeded.status).toBe(200);
});

afterAll(async () => {
    await fake.stop();
    fake.cleanup();
});

describe('T3 — fixture hygiene (T1: strip tokens, emails and node ids)', () => {
    const TOKEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
        { name: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
        { name: 'a fine-grained PAT', pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/ },
        { name: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
        { name: 'an email address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
        { name: 'a node id key', pattern: /"node_id"\s*:/ },
        { name: 'a node id value', pattern: /\b(MDEwOl|MDQ6|R_kgD|I_kwD)[A-Za-z0-9_-]{4,}/ },
    ];

    it('scans every fixture for a token-shaped string, an email address and a node id', () => {
        const names = fixtureFileNames();
        expect(names.length, 'the fixture directory must not be empty').toBeGreaterThanOrEqual(40);
        const findings: string[] = [];
        for (const name of names) {
            const raw = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8');
            for (const { name: label, pattern } of TOKEN_PATTERNS) {
                const match = pattern.exec(raw);
                if (match)
                    findings.push(`${name}.json contains ${label}: ${match[0].slice(0, 24)}…`);
            }
            const parsed = JSON.parse(raw);
            findings.push(...findSecretKeys(parsed, `${name}.json`));
        }
        expect(findings, findings.join('\n')).toEqual([]);
    });

    function findSecretKeys(value: unknown, at: string): string[] {
        if (value === null || typeof value !== 'object') return [];
        if (Array.isArray(value)) {
            return value.flatMap((entry, index) => findSecretKeys(entry, `${at}[${index}]`));
        }
        const secretKeys = ['access_token', 'refresh_token', 'client_secret', 'private_key'];
        const found: string[] = [];
        for (const [key, entry] of Object.entries(value as Json)) {
            if (secretKeys.includes(key)) found.push(`${at}.${key} is a secret-shaped key`);
            found.push(...findSecretKeys(entry, `${at}.${key}`));
        }
        return found;
    }

    it('keeps the PR-lane seed token deliberately non-token-shaped', () => {
        const seed = fs.readFileSync(path.join(FIXTURE_DIR, 'catalog-pr-lane.seed.json'), 'utf8');
        expect(seed).toContain('apw-e2e-user-token');
        expect(seed).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/);
    });
});

describe('T3 — every plan §8.3 route has a handler and a recorded fixture', () => {
    it('serves a handler for every row of the plan §8.3 tables', () => {
        const missing = PLAN_8_3_ROUTES.filter(
            (row) =>
                !ALL_ROUTES.some(
                    (route) => route.method === row.method && covers(route.pattern, row.pattern),
                ),
        ).map((row) => `${row.method} ${row.pattern} (${row.plan})`);
        expect(missing, `no handler for:\n${missing.join('\n')}`).toEqual([]);
    });

    it('names an existing fixture file for every non-control route', () => {
        const available = new Set(fixtureFileNames());
        const problems: string[] = [];
        for (const route of ALL_ROUTES as RouteEntry[]) {
            if (route.pattern.startsWith('/_control')) {
                expect(
                    route.fixture,
                    `${route.name} is a control route and must not claim a fixture`,
                ).toBeNull();
                continue;
            }
            if (!route.fixture) {
                problems.push(`${route.name} (${route.method} ${route.pattern}) has no fixture`);
                continue;
            }
            if (!available.has(route.fixture)) {
                problems.push(
                    `${route.name} names fixture '${route.fixture}', which does not exist`,
                );
            }
        }
        expect(problems, problems.join('\n')).toEqual([]);
    });

    it('calls every fixture-carrying route, so no route escapes the contract', () => {
        const called = new Set(CALL_PLAN.map((entry) => entry.route));
        const uncalled = (ALL_ROUTES as RouteEntry[])
            .filter((route) => !route.pattern.startsWith('/_control'))
            .map((route) => route.name)
            .filter((name) => !called.has(name));
        expect(uncalled, `routes never exercised by CALL_PLAN:\n${uncalled.join('\n')}`).toEqual(
            [],
        );
    });

    it('names a real route for every call in the plan', () => {
        const names = new Set((ALL_ROUTES as RouteEntry[]).map((route) => route.name));
        const unknown = CALL_PLAN.filter((entry) => !names.has(entry.route)).map(
            (entry) => entry.route,
        );
        expect(unknown).toEqual([]);
    });

    /**
     * T45 — the upstream endpoint list APW-09's lanes depend on, checked as
     * concrete URLs through the server's own matcher. Its own `it()` because it
     * is its own plan (see `T45_ROUTES`); the APW-13 rows above are untouched.
     */
    it('answers every URL of APW-09 T45’s endpoint list, dispatched as the server dispatches', () => {
        const unanswered = T45_ROUTES.filter((row) => !fakeAnswers(row.method, row.path)).map(
            (row) => `${row.method} ${row.path} — named by T45 as ${row.task}`,
        );
        expect(unanswered, `the fake answers no route for:\n${unanswered.join('\n')}`).toEqual([]);
    });

    it('agrees with each route on the method it is called with', () => {
        const byName = new Map((ALL_ROUTES as RouteEntry[]).map((route) => [route.name, route]));
        const mismatched = CALL_PLAN.filter(
            (entry) => byName.get(entry.route)?.method !== entry.method,
        ).map(
            (entry) =>
                `${entry.route}: route is ${byName.get(entry.route)?.method}, plan calls ${entry.method}`,
        );
        expect(mismatched).toEqual([]);
    });
});

describe('T3 — the fake matches the recorded fixtures, key for key and type for type', () => {
    for (const entry of CALL_PLAN) {
        const route = (ALL_ROUTES as RouteEntry[]).find(
            (candidate) => candidate.name === entry.route,
        );
        it(`${entry.route} — ${entry.method} matches fixtures/${route?.fixture}.json`, async () => {
            const fixture = loadFixture(route?.fixture as string);
            const result = await callRoute(entry);

            expect(
                result.status,
                `${entry.route} answered ${result.status}, the fixture records ${entry.status} ` +
                    `(body: ${JSON.stringify(result.body)?.slice(0, 200)})`,
            ).toBe(entry.status);

            if (entry.route === 'create-git-blob') captured.blobSha = result.body.sha;

            const differences = shapeDiff(fixture, result.body);
            expect(
                differences,
                `shape drift on ${entry.route}:\n${differences.join('\n')}`,
            ).toEqual([]);
        });
    }
});

/**
 * C11 — the repository projection carries GitHub's `size` (KB).
 *
 * The platform's mode resolver fails closed on an unmeasurable size
 * (`resolveAppRepositoryModes` answers `too_large_for_private_copy` when
 * `sizeKb` is unknown), and the GitHub plugin reads `sizeKb` from the payload's
 * `size`. A projection without `size` therefore made Private copy unreachable
 * on every PR-lane repository. The seed's `sizeKb` is what a spec sets; an
 * unseeded size is 1024 KB, well inside the 512000 KB private-copy cap.
 */
describe('C11 — the repository projection reports the seeded size', () => {
    async function getRepository(owner: string, name: string): Promise<Json> {
        const response = await fetch(`${fake.origin}/repos/${owner}/${name}`, {
            headers: { authorization: `Bearer ${USER_TOKEN}` },
        });
        expect(response.status, `GET /repos/${owner}/${name}`).toBe(200);
        return (await response.json()) as Json;
    }

    it('projects `size` equal to a seeded `sizeKb`, and 1024 when none was seeded', async () => {
        const seeded = await fetch(`${fake.origin}/_control/seed`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                repositories: [
                    { owner: 'apw-e2e-upstream', name: 'c11-too-large', sizeKb: 600000 },
                    { owner: 'apw-e2e-upstream', name: 'c11-default-size' },
                    {
                        owner: 'apw-e2e-user',
                        name: 'c11-fork-of-unseeded',
                        fork: true,
                        parentFullName: 'apw-e2e-upstream/c11-never-seeded',
                        sourceFullName: 'apw-e2e-upstream/c11-never-seeded',
                    },
                ],
            }),
        });
        expect(seeded.status).toBe(200);

        expect((await getRepository('apw-e2e-upstream', 'c11-too-large')).size).toBe(600000);
        expect((await getRepository('apw-e2e-upstream', 'c11-default-size')).size).toBe(1024);

        // A parent the fake only knows by name is projected from a placeholder
        // record; it carries the same key, so the payload's shape never varies.
        const fork = await getRepository('apw-e2e-user', 'c11-fork-of-unseeded');
        expect(fork.size).toBe(1024);
        expect(fork.parent?.size).toBe(1024);
        expect(fork.source?.size).toBe(1024);
    });

    it('keeps a seeded `sizeKb` when the repository is re-seeded without one', async () => {
        const reseed = async (repository: Json) =>
            fetch(`${fake.origin}/_control/seed`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ repositories: [repository] }),
            });
        expect(
            (await reseed({ owner: 'apw-e2e-upstream', name: 'c11-resized', sizeKb: 2048 })).status,
        ).toBe(200);
        expect((await reseed({ owner: 'apw-e2e-upstream', name: 'c11-resized' })).status).toBe(200);

        expect((await getRepository('apw-e2e-upstream', 'c11-resized')).size).toBe(2048);
    });
});
