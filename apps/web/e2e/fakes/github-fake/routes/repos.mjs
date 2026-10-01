/**
 * Repository, Git Data, branch, topic, hook and issue-comment routes for the
 * APW-13 fake GitHub (task T2, plan §8.3).
 *
 * Every route carries a `fixture` name: `contract.unit.spec.ts` (T3) replays
 * each one and shape-compares the fake's response against
 * `fixtures/<fixture>.json`, which is what stops the fake's shapes drifting
 * from the recorded ones. A route whose `fixture` file is missing fails that
 * test, which is how T2's "every route … has a handler and a recorded fixture"
 * is enforced mechanically rather than by inspection.
 */

import {
    branchProtectionPayload,
    comparePayload,
    gitBlobPayload,
    gitCommitPayload,
    gitRefPayload,
    gitTreePayload,
    interactionLimitPayload,
    issueCommentPayload,
    licenseSummaryPayload,
    repoBranchPayload,
    repoHookPayload,
    takeReadinessFault,
    upsertRepository,
} from '../state.mjs';
import {
    copyRefsBetweenBareRepos,
    deleteBareBranch,
    ensureBareRepo,
    seedBareRepoCommit,
} from '../git-backend.mjs';

const NOT_FOUND = { status: 404, body: { message: 'Not Found' } };

function sha(seed) {
    let hash = 0x811c9dc5;
    for (const ch of String(seed)) {
        hash ^= ch.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0').repeat(5).slice(0, 40);
}

/** Resolve a repository or return the shared 404 envelope. */
function requireRepo(ctx) {
    const repo = ctx.locate(ctx.params.owner, ctx.params.repo);
    if (!repo) return { error: NOT_FOUND };
    if (!repo.forkingAllowed && ctx.method === 'POST' && ctx.pathname.endsWith('/forks')) {
        return {
            error: { status: 403, body: { message: 'Forking is disabled for this repository' } },
        };
    }
    return { repo };
}

function refName(raw) {
    const value = String(raw ?? '').replace(/^\/+/, '');
    return value.startsWith('refs/') ? value : `refs/${value}`;
}

function shortRef(raw) {
    return refName(raw).replace(/^refs\//, '');
}

function readRef(repo, raw) {
    const wanted = refName(raw);
    if (repo.refs.has(wanted)) return repo.refs.get(wanted);
    // A repository that was seeded but never pushed still answers for its
    // default branch with a deterministic synthetic sha, so a consumer's
    // "does this branch exist" probe is not defeated by fixture setup order.
    if (wanted === `refs/heads/${repo.defaultBranch}`)
        return sha(`${repo.owner}/${repo.name}/default`);
    return null;
}

export const routes = [
    {
        name: 'get-authenticated-user',
        method: 'GET',
        pattern: '/user',
        fixture: 'user',
        handler: (ctx) => ({
            status: 200,
            body: {
                login: ctx.identity === 'anonymous' ? 'apw-e2e-user' : ctx.identity,
                id: 40400,
                type: 'User',
                site_admin: false,
                name: 'APW-13 E2E user',
                company: null,
                blog: '',
                location: null,
                bio: null,
                public_repos: 3,
                followers: 0,
                following: 0,
                created_at: ctx.state.generatedAt,
                updated_at: ctx.state.generatedAt,
            },
        }),
    },
    {
        name: 'list-user-orgs',
        method: 'GET',
        pattern: '/user/orgs',
        fixture: 'user-orgs',
        handler: (ctx) => ({
            status: 200,
            body: ctx.state.organizations.map((login, index) => ({
                login,
                id: 90000 + index,
                type: 'Organization',
                site_admin: false,
                description: `${login} (APW-13 fake GitHub fixture)`,
            })),
        }),
    },
    {
        name: 'get-repository',
        method: 'GET',
        pattern: '/repos/:owner/:repo',
        fixture: 'repo',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            return { status: 200, body: ctx.project(repo) };
        },
    },
    {
        name: 'list-forks',
        method: 'GET',
        pattern: '/repos/:owner/:repo/forks',
        fixture: 'repo-forks',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const fullName = `${repo.owner}/${repo.name}`.toLowerCase();
            const forks = [...ctx.state.repositories.values()].filter(
                (candidate) =>
                    candidate.parentFullName &&
                    candidate.parentFullName.toLowerCase() === fullName &&
                    candidate.readyAt <= Date.now(),
            );
            return { status: 200, body: forks.map((fork) => ctx.project(fork)) };
        },
    },
    {
        name: 'create-fork',
        method: 'POST',
        pattern: '/repos/:owner/:repo/forks',
        fixture: 'repo-fork',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const body = ctx.jsonBody ?? {};
            const targetOwner =
                body.organization || (ctx.identity === 'anonymous' ? 'apw-e2e' : ctx.identity);
            const name = body.name || repo.name;
            const readiness = takeReadinessFault(ctx.state, {
                pathname: ctx.pathname,
                tokenIdentity: ctx.identity,
            });
            const delayMs =
                readiness?.behaviour === 'delay' ? Number(readiness.seconds ?? 0) * 1000 : 0;
            const neverReady = readiness?.behaviour === 'never-ready';
            const fork = upsertRepository(
                ctx.state,
                {
                    owner: targetOwner,
                    name,
                    private: body.private ?? repo.private,
                    defaultBranch: repo.defaultBranch,
                    license: repo.license,
                    topics: repo.topics,
                    fork: true,
                    readyAt: neverReady ? Number.POSITIVE_INFINITY : Date.now() + delayMs,
                },
                {
                    parentFullName: `${repo.owner}/${repo.name}`,
                    sourceFullName: repo.sourceFullName ?? `${repo.owner}/${repo.name}`,
                },
            );
            // A fork is a real repository: it gets its own bare repo so a clone
            // against the fake fork's `clone_url` works like the upstream's.
            fork.gitDir = ensureBareRepo(ctx.state, fork.owner, fork.name);
            return { status: 202, body: ctx.project(fork) };
        },
    },
    {
        name: 'generate-from-template',
        method: 'POST',
        pattern: '/repos/:owner/:repo/generate',
        fixture: 'repo-generate',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const body = ctx.jsonBody ?? {};
            const targetOwner =
                body.owner || (ctx.identity === 'anonymous' ? 'apw-e2e' : ctx.identity);
            const created = upsertRepository(ctx.state, {
                owner: targetOwner,
                name: body.name || `${repo.name}-copy`,
                description: body.description ?? repo.description,
                private: body.private ?? false,
                defaultBranch: repo.defaultBranch,
                license: repo.license,
                topics: repo.topics,
                fork: false,
            });
            seedBareRepoCommit(ctx.state, repo);
            const targetDir = ensureBareRepo(ctx.state, created.owner, created.name);
            created.gitDir = targetDir;
            if (body.include_all_branches === true) {
                const branches = copyRefsBetweenBareRepos(repo.gitDir, targetDir);
                for (const branch of branches) {
                    created.refs.set(
                        `refs/heads/${branch}`,
                        sha(`${created.owner}/${created.name}/${branch}`),
                    );
                }
            }
            return { status: 201, body: ctx.project(created) };
        },
    },
    {
        name: 'merge-upstream',
        method: 'POST',
        pattern: '/repos/:owner/:repo/merge-upstream',
        fixture: 'repo-merge-upstream',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const branch = ctx.jsonBody?.branch ?? repo.defaultBranch;
            return {
                status: 200,
                body: {
                    message: 'Successfully fetched and fast-forwarded from upstream',
                    merge_type: 'fast-forward',
                    base_branch: branch,
                },
            };
        },
    },
    {
        name: 'compare-commits',
        method: 'GET',
        pattern: '/repos/:owner/:repo/compare/:basehead',
        fixture: 'repo-compare',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const [base, head] = String(ctx.params.basehead).split('...');
            const date = ctx.state.generatedAt;
            const commit = (label) => ({
                sha: sha(`${repo.owner}/${repo.name}/${label}`),
                date,
                message: `APW-13 fake GitHub fixture commit on ${label}`,
                treeSha: sha(`${repo.owner}/${repo.name}/${label}/tree`),
                parentShas: [],
            });
            return {
                status: 200,
                body: comparePayload(repo, {
                    base: base ?? repo.defaultBranch,
                    head: head ?? 'apw-e2e-head',
                    baseCommit: commit(base ?? repo.defaultBranch),
                    commits: [commit(head ?? 'apw-e2e-head')],
                    files: [
                        {
                            sha: sha(`${repo.owner}/${repo.name}/file`),
                            filename: '.works/works.yml',
                            status: 'modified',
                            additions: 4,
                            deletions: 1,
                            changes: 5,
                        },
                    ],
                }),
            };
        },
    },
    {
        name: 'get-repository-license',
        method: 'GET',
        pattern: '/repos/:owner/:repo/license',
        fixture: 'repo-license',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const summary = licenseSummaryPayload(repo.license, ctx.origin);
            if (!summary) return { status: 404, body: { message: 'Not Found' } };
            return {
                status: 200,
                body: {
                    ...summary,
                    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/LICENSE`,
                    description: 'A short and simple permissive license.',
                    implementation:
                        'Create a text file (typically named LICENSE) in the root of your source code.',
                    permissions: ['commercial-use', 'modifications', 'distribution', 'private-use'],
                    conditions: ['include-copyright'],
                    limitations: ['liability', 'warranty'],
                    body: `${repo.license.name}\n\nCopyright (c) APW-13 fake GitHub fixture\n`,
                    licensed: { ...summary },
                },
            };
        },
    },
    {
        name: 'get-repository-topics',
        method: 'GET',
        pattern: '/repos/:owner/:repo/topics',
        fixture: 'repo-topics',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            return { status: 200, body: { names: [...repo.topics] } };
        },
    },
    {
        name: 'replace-repository-topics',
        method: 'PUT',
        pattern: '/repos/:owner/:repo/topics',
        fixture: 'repo-topics',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const names = (ctx.jsonBody?.names ?? []).map((entry) => String(entry));
            repo.topics = names;
            return { status: 200, body: { names: [...names] } };
        },
    },
    {
        name: 'create-repository-hook',
        method: 'POST',
        pattern: '/repos/:owner/:repo/hooks',
        fixture: 'repo-hook',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const hook = {
                id: ctx.state.seq.hook++,
                url: ctx.jsonBody?.config?.url ?? `${ctx.origin}/apw-e2e-hook`,
                events: ctx.jsonBody?.events ?? ['push', 'pull_request'],
            };
            repo.hooks.push(hook);
            return { status: 201, body: repoHookPayload(repo, hook) };
        },
    },
    {
        name: 'delete-repository-hook',
        method: 'DELETE',
        pattern: '/repos/:owner/:repo/hooks/:hookId',
        fixture: 'repo-hook-delete',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const index = repo.hooks.findIndex(
                (hook) => String(hook.id) === String(ctx.params.hookId),
            );
            if (index === -1) return { status: 404, body: { message: 'Not Found' } };
            repo.hooks.splice(index, 1);
            return { status: 204, body: null };
        },
    },
    {
        name: 'create-git-ref',
        method: 'POST',
        pattern: '/repos/:owner/:repo/git/refs',
        fixture: 'git-ref',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const body = ctx.jsonBody ?? {};
            const ref = refName(body.ref);
            const value = body.sha ?? sha(`${ref}-${ctx.state.seq.ref++}`);
            repo.refs.set(ref, value);
            return { status: 201, body: gitRefPayload(repo, ref.replace(/^refs\//, ''), value) };
        },
    },
    {
        name: 'get-git-ref',
        method: 'GET',
        pattern: '/repos/:owner/:repo/git/refs/*ref',
        fixture: 'git-ref',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const value = readRef(repo, ctx.params.ref);
            if (!value) return { status: 404, body: { message: 'Not Found' } };
            return { status: 200, body: gitRefPayload(repo, shortRef(ctx.params.ref), value) };
        },
    },
    {
        name: 'get-git-ref-singular',
        method: 'GET',
        pattern: '/repos/:owner/:repo/git/ref/*ref',
        fixture: 'git-ref',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const value = readRef(repo, ctx.params.ref);
            if (!value) return { status: 404, body: { message: 'Not Found' } };
            return { status: 200, body: gitRefPayload(repo, shortRef(ctx.params.ref), value) };
        },
    },
    {
        name: 'update-git-ref',
        method: 'PATCH',
        pattern: '/repos/:owner/:repo/git/refs/*ref',
        fixture: 'git-ref',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const ref = refName(ctx.params.ref);
            const value = ctx.jsonBody?.sha ?? sha(`${ref}-${ctx.state.seq.ref++}`);
            repo.refs.set(ref, value);
            return { status: 200, body: gitRefPayload(repo, ref.replace(/^refs\//, ''), value) };
        },
    },
    {
        /**
         * T45 — the branch delete **Withdraw** performs (APW-09 FR-33/FR-45,
         * `git.deleteRef`). The path is the live API's own general form
         * (`DELETE /repos/{owner}/{repo}/git/refs/{ref}`), so it answers the
         * `refs/heads/*` case T45 names without a second, narrower pattern.
         *
         * `204` with no body on success — and the ref is really removed from the
         * repository record and from the bare repository on disk, so a following
         * `GET …/git/refs/heads/<branch>` answers `404`. A fake that answered
         * `204` while the branch stayed readable would let a lane pass a
         * "the branch is gone" assertion it never earned.
         */
        name: 'delete-git-ref',
        method: 'DELETE',
        pattern: '/repos/:owner/:repo/git/refs/*ref',
        fixture: 'git-ref-delete',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const ref = refName(ctx.params.ref);
            if (!repo.refs.has(ref)) return { status: 404, body: { message: 'Not Found' } };
            repo.refs.delete(ref);
            // The bare repository is the other half of "the branch exists": a
            // clone or a `GET /branches/:branch` must not still find it.
            if (ref.startsWith('refs/heads/')) {
                const bare = repo.gitDir ?? ensureBareRepo(ctx.state, repo.owner, repo.name);
                deleteBareBranch(bare, ref.replace(/^refs\/heads\//, ''));
            }
            return { status: 204, body: null };
        },
    },
    {
        /**
         * T45 — the repository's temporary interaction limit (APW-09 T2/G16,
         * `interactions.getRestrictionsForRepo` → `getInteractionLimit`).
         *
         * A seeded limit answers `200`; **unseeded answers `204`**, which is what
         * the live API does when a repository has no temporary limit and what the
         * plugin maps to `null` — never to `'none'`. A `403`/`404` (the
         * unreadable-repository halves) is reachable with the existing fault
         * vocabulary.
         */
        name: 'get-interaction-limits',
        method: 'GET',
        pattern: '/repos/:owner/:repo/interaction-limits',
        fixture: 'interaction-limits',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const payload = interactionLimitPayload(repo.interactionLimits);
            if (!payload) return { status: 204, body: null };
            return { status: 200, body: payload };
        },
    },
    {
        name: 'create-git-tree',
        method: 'POST',
        pattern: '/repos/:owner/:repo/git/trees',
        fixture: 'git-tree',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const entries = (ctx.jsonBody?.tree ?? []).map((entry, index) => ({
                path: entry.path,
                mode: entry.mode,
                type: entry.type ?? 'blob',
                sha: entry.sha ?? sha(`${entry.path}-${index}-${repo.name}`),
            }));
            const value = sha(`tree-${ctx.state.seq.object++}-${repo.name}`);
            repo.trees.set(value, entries);
            return { status: 201, body: gitTreePayload(value, entries) };
        },
    },
    {
        name: 'get-git-tree',
        method: 'GET',
        pattern: '/repos/:owner/:repo/git/trees/:treeSha',
        fixture: 'git-tree',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const entries = repo.trees.get(ctx.params.treeSha);
            if (!entries) {
                // A seeded repository answers its default branch with one entry so
                // `getRepositoryTree` has something faithful to read.
                const fallback = [
                    {
                        path: '.works',
                        mode: '040000',
                        type: 'tree',
                        sha: sha(`${repo.name}-works`),
                    },
                    {
                        path: '.works/works.yml',
                        mode: '100644',
                        type: 'blob',
                        sha: sha(`${repo.name}-works-yml`),
                    },
                ];
                return { status: 200, body: gitTreePayload(ctx.params.treeSha, fallback) };
            }
            return { status: 200, body: gitTreePayload(ctx.params.treeSha, entries) };
        },
    },
    {
        name: 'create-git-blob',
        method: 'POST',
        pattern: '/repos/:owner/:repo/git/blobs',
        fixture: 'git-blob',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const body = ctx.jsonBody ?? {};
            const content =
                body.encoding === 'base64'
                    ? Buffer.from(String(body.content ?? ''), 'base64').toString('utf8')
                    : String(body.content ?? '');
            const value = sha(`blob-${ctx.state.seq.object++}-${content.length}`);
            repo.blobs.set(value, content);
            return { status: 201, body: gitBlobPayload(value, content) };
        },
    },
    {
        name: 'get-git-blob',
        method: 'GET',
        pattern: '/repos/:owner/:repo/git/blobs/:blobSha',
        fixture: 'git-blob',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const content = repo.blobs.get(ctx.params.blobSha);
            if (content === undefined) return { status: 404, body: { message: 'Not Found' } };
            return { status: 200, body: gitBlobPayload(ctx.params.blobSha, content) };
        },
    },
    {
        name: 'create-git-commit',
        method: 'POST',
        pattern: '/repos/:owner/:repo/git/commits',
        fixture: 'git-commit',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const body = ctx.jsonBody ?? {};
            const value = sha(`commit-${ctx.state.seq.object++}-${body.message ?? ''}`);
            const payload = gitCommitPayload(repo, {
                sha: value,
                date: ctx.state.generatedAt,
                message: body.message ?? '',
                treeSha: body.tree ?? sha(`${repo.name}-tree`),
                parentShas: body.parents ?? [],
            });
            repo.commits.set(value, payload);
            return { status: 201, body: payload };
        },
    },
    {
        name: 'get-branch',
        method: 'GET',
        pattern: '/repos/:owner/:repo/branches/:branch',
        fixture: 'repo-branch',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const branch = ctx.params.branch;
            const value = readRef(repo, `heads/${branch}`);
            if (!value) return { status: 404, body: { message: 'Branch not found' } };
            return {
                status: 200,
                body: repoBranchPayload(repo, {
                    name: branch,
                    sha: value,
                    protected: Boolean(repo.branchProtection),
                }),
            };
        },
    },
    {
        name: 'get-branch-protection',
        method: 'GET',
        pattern: '/repos/:owner/:repo/branches/:branch/protection',
        fixture: 'repo-branch-protection',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            if (!repo.branchProtection)
                return { status: 404, body: { message: 'Branch not protected' } };
            return { status: 200, body: branchProtectionPayload(repo) };
        },
    },
    {
        name: 'update-branch-protection',
        method: 'PUT',
        pattern: '/repos/:owner/:repo/branches/:branch/protection',
        fixture: 'repo-branch-protection',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            repo.branchProtection = ctx.jsonBody ?? {
                required_status_checks: null,
                enforce_admins: true,
            };
            return { status: 200, body: branchProtectionPayload(repo) };
        },
    },
    {
        name: 'list-issue-comments',
        method: 'GET',
        pattern: '/repos/:owner/:repo/issues/:issueNumber/comments',
        fixture: 'issue-comments',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const comments = [...repo.issueComments.values()].filter(
                (comment) => String(comment.issueNumber) === String(ctx.params.issueNumber),
            );
            return {
                status: 200,
                body: comments.map((comment) => issueCommentPayload(repo, comment)),
            };
        },
    },
    {
        name: 'create-issue-comment',
        method: 'POST',
        pattern: '/repos/:owner/:repo/issues/:issueNumber/comments',
        fixture: 'issue-comment',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const comment = {
                id: ctx.state.seq.comment++,
                issueNumber: Number(ctx.params.issueNumber),
                body: ctx.jsonBody?.body ?? '',
                login: ctx.identity === 'anonymous' ? 'apw-e2e-user' : ctx.identity,
                createdAt: new Date().toISOString(),
                association: 'MEMBER',
            };
            repo.issueComments.set(comment.id, comment);
            return { status: 201, body: issueCommentPayload(repo, comment) };
        },
    },
];
