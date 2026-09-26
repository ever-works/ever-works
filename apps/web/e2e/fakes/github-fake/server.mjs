/**
 * The APW-13 fake GitHub server — entry point (task T2,
 * `docs/specs/features/app-works/APW-13-golden-paths/tasks.md` P0.1).
 *
 * A Node HTTP server with **no framework**, started by the PR lanes beside the
 * API (`plan.md` §9.1):
 *
 *     node apps/web/e2e/fakes/github-fake/server.mjs        # PORT defaults to 3900
 *
 * It is test infrastructure. The platform never loads it; the only runtime hook
 * in the product is the `EVER_WORKS_E2E_FAKES` switch inside the GitHub plugin
 * (task T5, `plan.md` §8.3).
 *
 * Responsibilities, in the order a request sees them:
 *
 *   1. `/_control/*`      — the fake's own control API (`control.mjs`). Never
 *      faulted and never recorded as a GitHub call: a fault planted on
 *      `/_control/fault` would be unusable, and `/_control/calls` must answer
 *      with GitHub traffic only.
 *   2. `/<owner>/<repo>.git/...` — Git smart HTTP over the bare repositories on
 *      disk (`git-backend.mjs`), which is what makes `clone_url` real.
 *   3. the GitHub REST subset the consuming epics call (`routes/*.mjs`), with a
 *      planted fault of the §8.3 vocabulary taking precedence over the handler.
 *   4. a recorded call for every request, and a JSON 404 otherwise.
 *
 * ---------------------------------------------------------------------------
 * The `_control` API, for a spec author
 * ---------------------------------------------------------------------------
 *
 * The fake's own API — the only way a spec arranges a refusal, reads back what
 * the platform did, or clears state between scenarios. It is dispatched FIRST,
 * so it is never faulted, never recorded as a GitHub call and never matched by
 * `route` patterns below. Full shapes live in `control.mjs` / `state.mjs`; the
 * census, so a spec author need not read either:
 *
 *   - `POST /_control/seed`   — `{ repositories[], users[], organizations[],
 *     catalog, blueprints }`. Idempotent; unknown keys are ignored. A `users[]`
 *     entry maps a token **value** to a login once, which is what gives later
 *     requests an identity.
 *     **T45 adds two keys, and they are the only gated ones:**
 *     `upstream_pull_requests[]` and `upstream_approval_proposals[]` — APW-09's
 *     own state (plan §3.1 / §6), armed **only** when
 *     `EVER_WORKS_E2E_FAKES === '1'` and `NODE_ENV !== 'production'`
 *     (`state.mjs`'s `upstreamSeedGate`). The switch is read in the **fake's**
 *     process, so the fake itself must be started with it; an unarmed seed is
 *     ignored and answers `upstreamSeed.applied: false` with the reason. A
 *     proposal that names no seeded row is a `400` naming the orphan, and a
 *     matched proposal gets its `payload.upstreamPullRequestId` filled in.
 *     Read both back with `GET /_control/state`.
 *   - `POST /_control/fault`  — `{ route, behaviour, method?, token?,
 *     tokenValue?, status?, body?, seconds?, times? }`. Answers `200` with the
 *     still-planted faults; an unknown `behaviour` answers `500` naming it.
 *     Behaviours: `delay`, `never-ready`, `rate-limit`, `server-error`,
 *     `auth-refused`, `conflict`.
 *   - `GET  /_control/calls`  — every recorded call: `{ method, path,
 *     tokenIdentity, authenticated, faultApplied, status, at }`. The identity,
 *     never the value; `faultApplied` names the behaviour a planted fault
 *     answered with, which is how a spec proves its fault was the one that
 *     fired.
 *   - `GET  /_control/faults` — the faults still armed, in match order.
 *   - `GET  /_control/state`  — repositories, user logins, organizations,
 *     catalog, blueprints, and (T45) the seeded `upstreamPullRequests` and
 *     `upstreamApprovalProposals`.
 *   - `POST /_control/reset`  — clears repositories, users, catalog, blueprints,
 *     the upstream seed, the call log and the fault queue. Keeps the git root.
 *
 * **The REST subset, by consumer (T45 additions marked).** APW-13's own rows are
 * in `routes/{repos,pulls,actions,contents}.mjs`; T45 adds the endpoints
 * APW-09's upstream lanes call, in `routes/commits.mjs` plus two rows in
 * `routes/repos.mjs`:
 *
 *   - `DELETE /repos/:o/:r/git/refs/*ref` — the branch delete **Withdraw**
 *     performs (FR-33/FR-45); `204` and the ref really goes, so a following read
 *     is a `404`.
 *   - `GET /repos/:o/:r/interaction-limits` — `getInteractionLimit` (G16). A
 *     seeded limit answers `200 { limit, origin, expires_at }`; an unseeded
 *     repository answers GitHub's own `204`, which the plugin maps to `null` and
 *     **never** to `'none'`.
 *   - `GET /repos/:o/:r/commits/:ref/check-runs` — `checks.listForRef`
 *     (`total_count`, `check_runs[].{name,status,conclusion,details_url}`).
 *   - `GET /repos/:o/:r/commits/:ref/statuses` — the commit statuses one commit
 *     carries; `readChecks` keys them by `context`, newest first.
 *   - `GET /repos/:o/:r/commits/:ref/status` — the combined status, rolled up
 *     from the statuses above (`combinedState`) rather than asserted.
 *   - `GET /repos/:o/:r/compare/:basehead` already answered `total_commits`
 *     (APW-09 T1's read); `POST /git/refs` and `PATCH /git/refs/*ref` were
 *     already served. Three of T45's named endpoints were therefore already
 *     here, and the T45 spec pins them so they cannot regress.
 *
 * **"The next matching call only" — the semantics that decide where a plant
 * goes.** A fault is planted with `times` (default **1**) and matched in plant
 * order; each request that matches takes one application, and the fault is
 * dropped from the queue when its last one is spent. A spec must therefore
 * plant **immediately before the case that needs it**, in that case's own setup
 * — never once in `global-setup` and never for a whole file, because the next
 * matching call from *anywhere* (another case, another worker, another spec
 * file — the fake is one process shared by them all) consumes it. "Matching" is
 * the `route` method+pathname, narrowed by `token` (identity) and/or
 * `tokenValue` (the presented token); to refuse one token and leave every other
 * caller alone, narrow by `tokenValue`.
 *
 * Exported (`createFakeGitHub`, `startFakeGitHub`) so the unit specs of T2/T3
 * can drive it on an ephemeral port without shelling out to a second process.
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { routes as controlRoutes } from './control.mjs';
import { routes as repoRoutes } from './routes/repos.mjs';
import { routes as pullRoutes } from './routes/pulls.mjs';
import { routes as commitRoutes } from './routes/commits.mjs';
import { routes as actionRoutes } from './routes/actions.mjs';
import { routes as contentRoutes } from './routes/contents.mjs';
import {
    addFault,
    actionJobPayload,
    contentsPayload,
    createState,
    identityForToken,
    pullRequestPayload,
    pullReviewCommentPayload,
    pullReviewPayload,
    recordCall,
    repoPayload,
    takeFault,
    tokenFromHeaders,
    workflowPayload,
    workflowRunPayload,
} from './state.mjs';
import { cleanupGitRoot, matchGitPath, runGitHttpBackend } from './git-backend.mjs';

/** Every route the fake serves, in dispatch order. */
export const ALL_ROUTES = [
    ...controlRoutes,
    ...repoRoutes,
    ...pullRoutes,
    ...commitRoutes,
    ...actionRoutes,
    ...contentRoutes,
];

const DEFAULT_PORT = 3900;

/** Compile `/repos/:owner/:repo/contents/*path` into a matcher. */
function compile(pattern) {
    const names = [];
    const source = pattern
        .split('/')
        .map((segment) => {
            if (segment.startsWith(':')) {
                names.push(segment.slice(1));
                return '([^/]+)';
            }
            if (segment.startsWith('*')) {
                names.push(segment.slice(1));
                return '(.*)';
            }
            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/');
    return { regex: new RegExp(`^${source}$`), names };
}

const COMPILED = ALL_ROUTES.map((route) => ({ route, ...compile(route.pattern) }));

function matchRoute(method, pathname) {
    for (const entry of COMPILED) {
        if (entry.route.method !== method) continue;
        const match = entry.regex.exec(pathname);
        if (!match) continue;
        const params = {};
        entry.names.forEach((name, index) => {
            params[name] = decodeURIComponent(match[index + 1] ?? '');
        });
        return { route: entry.route, params };
    }
    return null;
}

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function parseJson(buffer) {
    if (!buffer || buffer.length === 0) return null;
    try {
        return JSON.parse(buffer.toString('utf8'));
    } catch {
        return null;
    }
}

/** The fault-to-response mapping of plan §8.3. */
function faultResponse(fault) {
    switch (fault.behaviour) {
        case 'rate-limit':
            return {
                status: fault.status ?? 403,
                body: fault.body ?? { message: 'API rate limit exceeded' },
                headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000' },
            };
        case 'auth-refused':
            return {
                status: fault.status ?? 401,
                // GitHub's own 401 envelope, verbatim: a spec asserting "the
                // dead token was refused by GitHub" gets the body GitHub sends,
                // not a paraphrase of it.
                body: fault.body ?? {
                    message: 'Bad credentials',
                    documentation_url: 'https://docs.github.com/rest',
                    status: '401',
                },
            };
        case 'conflict':
            return {
                status: fault.status ?? 409,
                body: fault.body ?? { message: 'A fork of this repository already exists' },
            };
        case 'server-error':
        default:
            return { status: fault.status ?? 500, body: fault.body ?? { message: 'Server Error' } };
    }
}

/**
 * Build a fake GitHub. Returns the state, the `http.Server`, and
 * `start`/`stop`/`cleanup` helpers. Nothing listens until `start()` is called,
 * so a spec can ask for port 0 and get an ephemeral one.
 */
export function createFakeGitHub(options = {}) {
    const state = options.state ?? createState();
    const server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
            if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: `fake GitHub crashed: ${error?.message}` }));
        });
    });

    const requestedPort = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
    let origin = `http://127.0.0.1:${requestedPort}`;

    function sendJson(res, status, body, headers = {}) {
        const payload = body === null || body === undefined ? '' : JSON.stringify(body, null, 2);
        res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
            ...headers,
        });
        res.end(payload);
    }

    function buildContext(req, res, params, jsonBody, rawBody) {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const identity = identityForToken(state, tokenFromHeaders(req.headers));
        return {
            state,
            req,
            res,
            method: (req.method ?? 'GET').toUpperCase(),
            pathname: url.pathname,
            query: url.searchParams,
            origin,
            params,
            jsonBody,
            rawBody,
            identity,
            /** Resolve a repository as a consumer sees it (ready forks only). */
            locate(owner, name) {
                const key = `${String(owner).toLowerCase()}/${String(name).toLowerCase()}`;
                const repo = state.repositories.get(key);
                if (!repo) return undefined;
                if (repo.readyAt > Date.now()) return undefined;
                return repo;
            },
            project(repo) {
                return repoPayload(repo, origin, 0, identity);
            },
            projectPull(repo, pull) {
                return pullRequestPayload(repo, pull, origin, identity);
            },
            projectReview(repo, review) {
                return pullReviewPayload(repo, review);
            },
            projectReviewComment(repo, comment) {
                return pullReviewCommentPayload(repo, comment);
            },
            projectWorkflow(repo, workflow) {
                return workflowPayload(repo, workflow);
            },
            projectRun(repo, run) {
                return workflowRunPayload(repo, run);
            },
            projectJob(repo, job) {
                return actionJobPayload(repo, job);
            },
            projectContents(repo, entry) {
                return contentsPayload(repo, entry);
            },
            plantFault(body) {
                return addFault(state, body);
            },
        };
    }

    async function handle(req, res) {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        const rawBody = await readRawBody(req);
        origin = `http://${req.headers.host ?? `127.0.0.1:${requestedPort}`}`;
        const presentedToken = tokenFromHeaders(req.headers);
        const identity = identityForToken(state, presentedToken);

        // 1. The fake's own control API.
        const firstMatch = matchRoute(method, pathname);
        if (firstMatch && firstMatch.route.pattern.startsWith('/_control')) {
            const result = await firstMatch.route.handler(
                buildContext(req, res, firstMatch.params, parseJson(rawBody), rawBody),
            );
            sendJson(res, result.status, result.body, result.headers);
            return;
        }

        // 2. Git smart HTTP. `/<owner>/<repo>.git/...` is what `clone_url`
        //    advertises, so it must be answered before the REST router.
        const gitPath = matchGitPath(pathname);
        if (gitPath) {
            recordCall(state, { method, path: pathname, tokenIdentity: identity });
            const result = await runGitHttpBackend({
                state,
                method,
                pathInfo: gitPath.pathInfo,
                // CGI wants the query string without its leading `?`.
                queryString: url.search.replace(/^\?/, ''),
                contentType: req.headers['content-type'],
                contentEncoding: req.headers['content-encoding'],
                rawBody,
            });
            res.writeHead(result.status, {
                ...result.headers,
                'content-length': result.body.length,
            });
            res.end(result.body);
            return;
        }

        // 3. A planted fault answers before the handler it targets.
        const fault = takeFault(state, {
            method,
            pathname,
            tokenIdentity: identity,
            tokenValue: presentedToken,
        });
        if (fault) {
            const response = faultResponse(fault);
            recordCall(state, {
                method,
                path: pathname,
                tokenIdentity: identity,
                faultApplied: fault.behaviour,
                // The status the fault answered with, so `/_control/calls`
                // proves *what* the fault said and not merely that one fired.
                status: response.status,
            });
            sendJson(res, response.status, response.body, response.headers);
            return;
        }

        if (!firstMatch) {
            recordCall(state, { method, path: pathname, tokenIdentity: identity, status: 404 });
            sendJson(res, 404, { message: 'Not Found' });
            return;
        }

        const ctx = buildContext(req, res, firstMatch.params, parseJson(rawBody), rawBody);
        let result;
        try {
            result = await firstMatch.route.handler(ctx);
        } catch (error) {
            result = {
                status: 500,
                body: { message: `fake GitHub handler failed: ${error?.message}` },
            };
        }
        recordCall(state, {
            method,
            path: pathname,
            tokenIdentity: identity,
            status: result.status,
        });
        sendJson(res, result.status, result.body, result.headers);
    }

    return {
        state,
        server,
        get origin() {
            return origin;
        },
        start() {
            return new Promise((resolve) => {
                server.listen(requestedPort, '127.0.0.1', () => {
                    const address = server.address();
                    if (address && typeof address === 'object') {
                        origin = `http://127.0.0.1:${address.port}`;
                    }
                    resolve(origin);
                });
            });
        },
        stop() {
            return new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections?.();
            });
        },
        cleanup() {
            cleanupGitRoot(state);
        },
    };
}

/** Convenience for the lanes: create, listen, and resolve the origin. */
export async function startFakeGitHub(options = {}) {
    const fake = createFakeGitHub(options);
    await fake.start();
    return fake;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
    const fake = createFakeGitHub();
    fake.start().then((url) => {
        // The lanes wait on this line; keep it on one line and on stdout.
        process.stdout.write(`fake GitHub listening on ${url}\n`);
    });
    const shutdown = () => {
        fake.stop().finally(() => {
            fake.cleanup();
            process.exit(0);
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
