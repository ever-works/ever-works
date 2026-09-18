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
 * Exported (`createFakeGitHub`, `startFakeGitHub`) so the unit specs of T2/T3
 * can drive it on an ephemeral port without shelling out to a second process.
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { routes as controlRoutes } from './control.mjs';
import { routes as repoRoutes } from './routes/repos.mjs';
import { routes as pullRoutes } from './routes/pulls.mjs';
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
                body: fault.body ?? { message: 'Bad credentials' },
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
        const identity = identityForToken(state, tokenFromHeaders(req.headers));

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
        const fault = takeFault(state, { method, pathname, tokenIdentity: identity });
        if (fault) {
            recordCall(state, {
                method,
                path: pathname,
                tokenIdentity: identity,
                faultApplied: fault.behaviour,
            });
            const response = faultResponse(fault);
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
