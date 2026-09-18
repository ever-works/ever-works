/**
 * Pull-request routes for the APW-13 fake GitHub (task T2, plan §8.3).
 *
 * `GET|POST /repos/:o/:r/pulls`, `PUT …/pulls/:n/merge`, plus the read routes
 * APW-09 and APW-13 need for PR status and the "no comment was posted" pins
 * (`GET …/issues/:n/comments`, `POST …/issues/:n/comments` — the latter lives in
 * `repos.mjs` beside the other issue routes).
 *
 * Every `html_url`/`diff_url` here points at `github.com` on purpose: those are
 * the clickable links a human sees in Activity and in a PR payload, and the
 * switch of T5 covers `getWebUrl` (plan §8.3) rather than rewriting payloads the
 * fake serves.
 */

const NOT_FOUND = { status: 404, body: { message: 'Not Found' } };

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

function requirePull(ctx, repo) {
    const pull = repo.pulls.get(Number(ctx.params.pullNumber));
    if (!pull) return { error: NOT_FOUND };
    return { pull };
}

export const routes = [
    {
        name: 'list-pull-requests',
        method: 'GET',
        pattern: '/repos/:owner/:repo/pulls',
        fixture: 'pulls',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const state = ctx.query.get('state') ?? 'open';
            const pulls = [...repo.pulls.values()].filter(
                (pull) => state === 'all' || pull.state === state,
            );
            return { status: 200, body: pulls.map((pull) => ctx.projectPull(repo, pull)) };
        },
    },
    {
        name: 'create-pull-request',
        method: 'POST',
        pattern: '/repos/:owner/:repo/pulls',
        fixture: 'pull',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const body = ctx.jsonBody ?? {};
            const number = repo.pulls.size + 1;
            const headRef = String(body.head ?? 'apw-e2e-head')
                .split(':')
                .pop();
            const headOwner = String(body.head ?? '').includes(':')
                ? String(body.head).split(':')[0]
                : repo.owner;
            const now = new Date().toISOString();
            const pull = {
                id: 700000 + number,
                number,
                state: 'open',
                title: body.title ?? 'APW-13 fake GitHub fixture pull request',
                body: body.body ?? '',
                login: ctx.identity === 'anonymous' ? repo.owner : ctx.identity,
                createdAt: now,
                updatedAt: now,
                baseRef: body.base ?? repo.defaultBranch,
                baseSha: sha(`${repo.owner}/${repo.name}/${body.base ?? repo.defaultBranch}`),
                headRef,
                headOwner,
                headSha: sha(`${headOwner}/${repo.name}/${headRef}`),
                headRepoFullName: `${headOwner}/${repo.name}`,
                merged: false,
            };
            repo.pulls.set(number, pull);
            return { status: 201, body: ctx.projectPull(repo, pull) };
        },
    },
    {
        name: 'get-pull-request',
        method: 'GET',
        pattern: '/repos/:owner/:repo/pulls/:pullNumber',
        fixture: 'pull',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const { pull, error: pullError } = requirePull(ctx, repo);
            if (pullError) return pullError;
            return { status: 200, body: ctx.projectPull(repo, pull) };
        },
    },
    {
        name: 'update-pull-request',
        method: 'PATCH',
        pattern: '/repos/:owner/:repo/pulls/:pullNumber',
        fixture: 'pull',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const { pull, error: pullError } = requirePull(ctx, repo);
            if (pullError) return pullError;
            const body = ctx.jsonBody ?? {};
            if (body.state) pull.state = body.state;
            if (pull.state === 'closed' && !pull.merged) pull.closedAt = new Date().toISOString();
            if (typeof body.title === 'string') pull.title = body.title;
            if (typeof body.body === 'string') pull.body = body.body;
            pull.updatedAt = new Date().toISOString();
            return { status: 200, body: ctx.projectPull(repo, pull) };
        },
    },
    {
        name: 'merge-pull-request',
        method: 'PUT',
        pattern: '/repos/:owner/:repo/pulls/:pullNumber/merge',
        fixture: 'pull-merge',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const { pull, error: pullError } = requirePull(ctx, repo);
            if (pullError) return pullError;
            if (pull.state === 'closed' && !pull.merged) {
                return { status: 405, body: { message: 'Pull Request is not mergeable' } };
            }
            const now = new Date().toISOString();
            pull.merged = true;
            pull.state = 'closed';
            pull.mergedAt = now;
            pull.closedAt = now;
            pull.updatedAt = now;
            pull.mergeCommitSha = sha(`merge-${repo.owner}/${repo.name}#${pull.number}`);
            return {
                status: 200,
                body: {
                    sha: pull.mergeCommitSha,
                    merged: true,
                    message: 'Pull Request successfully merged',
                },
            };
        },
    },
    {
        name: 'list-pull-request-files',
        method: 'GET',
        pattern: '/repos/:owner/:repo/pulls/:pullNumber/files',
        fixture: 'pull-files',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const { pull, error: pullError } = requirePull(ctx, repo);
            if (pullError) return pullError;
            return {
                status: 200,
                body: [
                    {
                        sha: sha(`${repo.owner}/${repo.name}#${pull.number}-works-yml`),
                        filename: '.works/works.yml',
                        status: 'added',
                        additions: 24,
                        deletions: 0,
                        changes: 24,
                        blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.headSha}/.works/works.yml`,
                        raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.headSha}/.works/works.yml`,
                        contents_url: `${ctx.origin}/repos/${repo.owner}/${repo.name}/contents/.works/works.yml`,
                        patch: '@@ -0,0 +1,24 @@\n+version: 1',
                    },
                ],
            };
        },
    },
    {
        name: 'list-pull-request-reviews',
        method: 'GET',
        pattern: '/repos/:owner/:repo/pulls/:pullNumber/reviews',
        fixture: 'pull-reviews',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const { pull, error: pullError } = requirePull(ctx, repo);
            if (pullError) return pullError;
            return {
                status: 200,
                body: [
                    {
                        id: 800000 + pull.number,
                        login: 'apw-e2e-reviewer',
                        body: 'APW-13 fake GitHub fixture review',
                        state: 'APPROVED',
                        pullNumber: pull.number,
                        submittedAt: pull.updatedAt,
                        commitId: pull.headSha,
                        association: 'MEMBER',
                    },
                ].map((review) => ctx.projectReview(repo, review)),
            };
        },
    },
    {
        name: 'list-pull-request-review-comments',
        method: 'GET',
        pattern: '/repos/:owner/:repo/pulls/:pullNumber/comments',
        fixture: 'pull-review-comments',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const { pull, error: pullError } = requirePull(ctx, repo);
            if (pullError) return pullError;
            return {
                status: 200,
                body: [
                    {
                        id: 810000 + pull.number,
                        body: 'APW-13 fake GitHub fixture review comment',
                        path: '.works/works.yml',
                        position: 3,
                        line: 3,
                        commitId: pull.headSha,
                        login: 'apw-e2e-reviewer',
                        createdAt: pull.updatedAt,
                        pullNumber: pull.number,
                        association: 'MEMBER',
                    },
                ].map((comment) => ctx.projectReviewComment(repo, comment)),
            };
        },
    },
    {
        name: 'create-pull-request-review-comment',
        method: 'POST',
        pattern: '/repos/:owner/:repo/pulls/:pullNumber/comments',
        fixture: 'pull-review-comment',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const { pull, error: pullError } = requirePull(ctx, repo);
            if (pullError) return pullError;
            const now = new Date().toISOString();
            return {
                status: 201,
                body: ctx.projectReviewComment(repo, {
                    id: 820000 + pull.number,
                    body: ctx.jsonBody?.body ?? '',
                    path: ctx.jsonBody?.path ?? '.works/works.yml',
                    position: ctx.jsonBody?.position ?? 1,
                    line: ctx.jsonBody?.line ?? 1,
                    commitId: pull.headSha,
                    login: ctx.identity === 'anonymous' ? repo.owner : ctx.identity,
                    createdAt: now,
                    pullNumber: pull.number,
                    association: 'MEMBER',
                    inReplyToId: null,
                }),
            };
        },
    },
];
