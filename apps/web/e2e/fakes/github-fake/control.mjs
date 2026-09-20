/**
 * The fake GitHub control API (task T2, plan §8.3).
 *
 * The routes, exactly as the plan names them plus the additive four:
 *
 *   - `POST /_control/seed`  — the documented seed shape (repositories with
 *     per-login `permissions`, users with tokens, the catalog manifest +
 *     licences, the Blueprint list). A spec seeds from a checked-in JSON
 *     fixture rather than from per-test code. **T45 adds
 *     `upstream_pull_requests[]` and `upstream_approval_proposals[]`**, armed
 *     only while `EVER_WORKS_E2E_FAKES === '1'` in a non-production process
 *     (`state.mjs`'s `upstreamSeedGate` → `seedUpstreamState`). An unarmed seed
 *     is ignored and reports `upstreamSeed.applied: false` with the reason; a
 *     proposal matching no seeded row is a `400` naming the orphan.
 *   - `POST /_control/fault` — plants one fault of the §8.3 vocabulary
 *     (`delay`, `never-ready`, `rate-limit`, `server-error`, `auth-refused`,
 *     `conflict`). Narrow it with `token` (the token **identity**) and/or
 *     `tokenValue` (the token **value** the caller presents — the way to refuse
 *     a credential the fake never seeded, i.e. a dead one); see `addFault` in
 *     `state.mjs`. It applies to the **next matching call only** unless `times`
 *     says otherwise, which is why a spec plants it in the case's own setup.
 *   - `GET  /_control/calls` — every recorded call: method, path, token
 *     **identity** (never a value), the `faultApplied` behaviour and the status
 *     answered — which is what the "zero writes" assertions read.
 *
 * `POST /_control/reset`, `GET /_control/state` and `GET /_control/faults` are
 * additive: a spec that runs several scenarios in one file needs to clear
 * between them, reads the seed result back, and — before a one-shot fault has
 * fired — needs to see that it is still armed. None is a route the platform
 * ever calls. `/_control/state` also carries T45's `upstreamPullRequests` and
 * `upstreamApprovalProposals`, which is how a spec reads its own upstream seed
 * back.
 *
 * These are the fake's own API, not GitHub's, so they carry no `fixture` and the
 * T3 contract test skips them by design.
 */

import { listFaults, reset, seed } from './state.mjs';

export const routes = [
    {
        name: 'control-seed',
        method: 'POST',
        pattern: '/_control/seed',
        fixture: null,
        handler: (ctx) => {
            const seeded = seed(ctx.state, ctx.jsonBody ?? {});
            // T45 — an approval proposal that matches no seeded row is refused
            // loudly rather than stored: a lane whose precondition "an
            // `awaiting_approval` proposal is seeded" silently seeded nothing is
            // the one failure this route can prevent and a 200 would hide.
            if (seeded.upstreamSeed?.error) {
                return { status: 400, body: { message: seeded.upstreamSeed.error, seeded } };
            }
            return { status: 200, body: { seeded } };
        },
    },
    {
        name: 'control-fault',
        method: 'POST',
        pattern: '/_control/fault',
        fixture: null,
        handler: (ctx) => {
            const body = ctx.jsonBody ?? {};
            ctx.plantFault(body);
            return { status: 200, body: { faults: listFaults(ctx.state) } };
        },
    },
    {
        name: 'control-calls',
        method: 'GET',
        pattern: '/_control/calls',
        fixture: null,
        handler: (ctx) => ({
            status: 200,
            body: { calls: ctx.state.calls, count: ctx.state.calls.length },
        }),
    },
    {
        name: 'control-faults',
        method: 'GET',
        pattern: '/_control/faults',
        fixture: null,
        handler: (ctx) => ({ status: 200, body: { faults: listFaults(ctx.state) } }),
    },
    {
        name: 'control-state',
        method: 'GET',
        pattern: '/_control/state',
        fixture: null,
        handler: (ctx) => ({
            status: 200,
            body: {
                repositories: [...ctx.state.repositories.values()].map((repo) => ({
                    full_name: `${repo.owner}/${repo.name}`,
                    default_branch: repo.defaultBranch,
                    archived: repo.archived,
                    fork: repo.fork,
                    parent: repo.parentFullName,
                    ready: repo.readyAt <= Date.now(),
                    topics: repo.topics,
                })),
                users: [...ctx.state.users.values()].map((user) => user.login),
                organizations: ctx.state.organizations,
                catalog: ctx.state.catalog,
                blueprints: ctx.state.blueprints,
                // T45 — the upstream seed, read back so a spec can prove the row
                // and its proposal are what it asked for. Empty unless the seed
                // was armed (`upstreamSeedGate`).
                upstreamPullRequests: ctx.state.upstreamPullRequests.map((row) => ({ ...row })),
                upstreamApprovalProposals: ctx.state.upstreamApprovalProposals.map((proposal) => ({
                    ...proposal,
                    payload: { ...proposal.payload },
                })),
            },
        }),
    },
    {
        name: 'control-reset',
        method: 'POST',
        pattern: '/_control/reset',
        fixture: null,
        handler: (ctx) => {
            reset(ctx.state);
            return { status: 200, body: { reset: true } };
        },
    },
];
