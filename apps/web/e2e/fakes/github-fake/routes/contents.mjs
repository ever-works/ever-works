/**
 * Contents and README routes for the APW-13 fake GitHub (task T2, plan §8.3).
 *
 * `GET|PUT /repos/:o/:r/contents/:path` is what APW-03's `commitFiles` and the
 * App-spec PR flow write through, and `GET …/readme` is what the Blueprint
 * resolver reads. Both are served for any path, including paths nested several
 * directories deep — a `:path` wildcard, not a single segment, because
 * `.works/works.yml` and `.github/workflows/ever-works-build.yml` are exactly
 * the paths the consumers use.
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

function decodeBody(raw) {
    if (raw == null) return '';
    const text = String(raw);
    if (!text) return '';
    try {
        return Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
        return '';
    }
}

export const routes = [
    {
        name: 'get-repository-content',
        method: 'GET',
        pattern: '/repos/:owner/:repo/contents/*path',
        fixture: 'contents',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const path = String(ctx.params.path ?? '').replace(/^\/+/, '');
            const ref = ctx.query.get('ref') ?? repo.defaultBranch;
            const entry = repo.contents.get(`${ref}:${path}`) ?? repo.contents.get(`*:${path}`);
            if (!entry) return NOT_FOUND;
            return {
                status: 200,
                body: ctx.projectContents(repo, { path, body: entry.body, sha: entry.sha }),
            };
        },
    },
    {
        name: 'create-or-update-file',
        method: 'PUT',
        pattern: '/repos/:owner/:repo/contents/*path',
        fixture: 'contents-put',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const path = String(ctx.params.path ?? '').replace(/^\/+/, '');
            const branch = ctx.jsonBody?.branch ?? repo.defaultBranch;
            const body = decodeBody(ctx.jsonBody?.content);
            const value = sha(`${repo.owner}/${repo.name}/${branch}/${path}/${body.length}`);
            repo.contents.set(`${branch}:${path}`, { body, sha: value });
            const now = new Date().toISOString();
            const contents = ctx.projectContents(repo, { path, body, sha: value });
            return {
                status: 200,
                body: {
                    content: contents,
                    commit: {
                        sha: sha(`commit-${value}`),
                        url: `${ctx.origin}/repos/${repo.owner}/${repo.name}/git/commits/${sha(`commit-${value}`)}`,
                        html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha(`commit-${value}`)}`,
                        author: { name: 'APW-13 fake GitHub', date: now },
                        committer: { name: 'APW-13 fake GitHub', date: now },
                        message: ctx.jsonBody?.message ?? '',
                        tree: {
                            sha: sha(`tree-${value}`),
                            url: `${ctx.origin}/repos/${repo.owner}/${repo.name}/git/trees/${sha(`tree-${value}`)}`,
                        },
                        parents: [],
                    },
                },
            };
        },
    },
    {
        name: 'get-repository-readme',
        method: 'GET',
        pattern: '/repos/:owner/:repo/readme',
        fixture: 'readme',
        handler: (ctx) => {
            const { repo, error } = requireRepo(ctx);
            if (error) return error;
            const ref = ctx.query.get('ref') ?? repo.defaultBranch;
            const body = repo.readme ?? `# ${repo.name}\n\nAPW-13 fake GitHub fixture README.\n`;
            const value = sha(`${repo.owner}/${repo.name}/README.md/${ref}`);
            const contents = ctx.projectContents(repo, { path: 'README.md', body, sha: value });
            return { status: 200, body: { ...contents, _links: { ...contents._links } } };
        },
    },
];
