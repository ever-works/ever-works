/**
 * Commit-scoped check and status routes for the APW-13 fake GitHub — the
 * endpoints APW-09 T45 adds (`docs/specs/features/app-works/APW-09-upstream-pull-requests/tasks.md`
 * T45; APW-09 `plan.md` §4).
 *
 * These are the three reads `packages/plugins/github/src/github-api.service.ts`
 * makes of ONE commit when it rolls up a pull request's checks
 * (`readChecks`, `:2115-2206`):
 *
 *   - `GET /repos/:o/:r/commits/:ref/check-runs`  → `checks.listForRef`
 *   - `GET /repos/:o/:r/commits/:ref/statuses`    → `repos.listCommitStatusesForRef`
 *   - `GET /repos/:o/:r/commits/:ref/status`      → `repos.getCombinedStatusForRef`
 *
 * ## Why the defaults are derived and not frozen
 *
 * A route whose answer is a fixed blob cannot express the states APW-09's
 * acceptance rows turn on: `action_required` must read as **waiting for
 * maintainers** rather than failing (ACC-09-17), a red check must be red, and a
 * `pending` status must not roll up as green. The defaults are therefore one
 * green run and one `success` status derived from the requested `ref`, and a
 * spec that needs another state **seeds** `checkRuns` / `commitStatuses` on the
 * repository (`/_control/seed`, documented in `fixtures/README.md` and the
 * runbook §4). The roll-up itself is computed (`combinedState`), never asserted
 * — a `failure` among the statuses is a `failure` here for the same reason it is
 * one on GitHub.
 *
 * Every route carries a `fixture` name, so T3's contract test shape-compares it
 * against the recorded shape (see `fixtures/README.md` for the two documented
 * subsets).
 */

import {
    DEFAULT_CHECK_RUN_NAME,
    DEFAULT_COMMIT_STATUS_CONTEXT,
    checkRunsPayload,
    combinedStatusPayload,
    commitStatusesPayload,
} from '../state.mjs';

const NOT_FOUND = { status: 404, body: { message: 'Not Found' } };

/** A stable 40-hex sha for a `(repo, ref)` pair — the same rule `repos.mjs` uses. */
function sha(seed) {
    let hash = 0x811c9dc5;
    for (const ch of String(seed)) {
        hash ^= ch.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0').repeat(5).slice(0, 40);
}

function requireRepo(ctx) {
    const repo = ctx.locate(ctx.params.owner, ctx.params.repo);
    if (!repo) return { error: NOT_FOUND };
    return { repo };
}

/** The check runs this repository answers with: seeded rows, else the green default. */
function checkRunsFor(repo, ref) {
    if (Array.isArray(repo.checkRuns)) {
        return repo.checkRuns.map((run) => ({ ...run, headSha: run.headSha ?? ref }));
    }
    return [
        {
            id: 900100,
            name: DEFAULT_CHECK_RUN_NAME,
            status: 'completed',
            conclusion: 'success',
            startedAt: repo.pushedAt,
            completedAt: repo.updatedAt,
            detailsUrl: `https://github.com/${repo.owner}/${repo.name}/actions/runs/960001`,
            headSha: ref,
            externalId: 'apw-e2e-check-build',
        },
    ];
}

/** The commit statuses: seeded rows, else the one green default. */
function commitStatusesFor(repo, ref) {
    if (Array.isArray(repo.commitStatuses)) {
        return repo.commitStatuses.map((status) => ({ ...status }));
    }
    return [
        {
            id: 900200,
            context: DEFAULT_COMMIT_STATUS_CONTEXT,
            state: 'success',
            description: `APW-13 fake GitHub fixture status on ${ref}`,
            targetUrl: `https://ci.example.invalid/apw-e2e/${ref}`,
            createdAt: repo.pushedAt,
        },
    ];
}

/** Resolve the ref a route is about: the path segment, or the default branch's head. */
function refFor(repo, raw) {
    const ref = String(raw ?? '').replace(/^\/+/, '');
    if (!ref) return sha(`${repo.owner}/${repo.name}/default`);
    return ref;
}

export const routes = [
    {
        name: 'list-check-runs-for-ref',
        method: 'GET',
        pattern: '/repos/:owner/:repo/commits/:ref/check-runs',
        fixture: 'check-runs',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const ref = refFor(repo, ctx.params.ref);
            return { status: 200, body: checkRunsPayload(repo, checkRunsFor(repo, ref)) };
        },
    },
    {
        name: 'list-commit-statuses-for-ref',
        method: 'GET',
        pattern: '/repos/:owner/:repo/commits/:ref/statuses',
        fixture: 'commit-statuses',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const ref = refFor(repo, ctx.params.ref);
            return { status: 200, body: commitStatusesPayload(repo, commitStatusesFor(repo, ref)) };
        },
    },
    {
        name: 'get-combined-status-for-ref',
        method: 'GET',
        pattern: '/repos/:owner/:repo/commits/:ref/status',
        fixture: 'commit-status',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const ref = refFor(repo, ctx.params.ref);
            return {
                status: 200,
                body: combinedStatusPayload(repo, ref, commitStatusesFor(repo, ref), ctx.origin),
            };
        },
    },
];
