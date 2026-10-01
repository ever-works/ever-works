/**
 * Git smart-HTTP for the APW-13 fake GitHub (task T2,
 * `docs/specs/features/app-works/APW-13-golden-paths/tasks.md` P0.1).
 *
 * `plan.md` §8.3 requires "Git smart HTTP over bare repositories on disk
 * (`git http-backend`), so clone and push work against `clone_url`". Every
 * repository the fake serves therefore has a real bare repository under
 * `state.gitRoot`, and `clone_url` is `<fake-origin>/<owner>/<repo>.git` — the
 * origin of the running fake, never `github.com`.
 *
 * This is the piece that makes the T5 switch meaningful: without it, a platform
 * path that clones would still reach real GitHub even though the REST calls hit
 * the fake (`plan.md` §8.3, "Every URL builder the switch must cover").
 *
 * Nothing here is loaded by the platform — it is test infrastructure only.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Absolute path of the bare repository backing `owner/name`. */
export function bareRepoPath(state, owner, name) {
    return path.join(state.gitRoot, String(owner), `${String(name)}.git`);
}

function runGit(args, cwd) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.error) {
        throw new Error(`git ${args.join(' ')} failed to start: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(
            `git ${args.join(' ')} exited ${result.status}: ${(result.stderr ?? '').trim()}`,
        );
    }
    return result.stdout ?? '';
}

/** Create the bare repository for `owner/name` if it does not exist yet. */
export function ensureBareRepo(state, owner, name) {
    const dir = bareRepoPath(state, owner, name);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, 'HEAD'))) {
        runGit(['init', '--bare', '--initial-branch=main', dir], undefined);
        // `http.receivepack` is what lets a push over smart HTTP work at all;
        // without it `git http-backend` refuses `git-receive-pack` and the
        // clone/push round-trip the T2 spec asserts could not exist.
        runGit(['config', 'http.receivepack', 'true'], dir);
        runGit(['config', 'http.uploadpack', 'true'], dir);
    }
    return dir;
}

/** True when the repository directory already holds at least one ref. */
export function bareRepoHasRefs(dir) {
    const result = spawnSync('git', ['show-ref', '--heads'], { cwd: dir, encoding: 'utf8' });
    return result.status === 0 && (result.stdout ?? '').trim().length > 0;
}

/**
 * Seed `owner/name` with one commit on its default branch, so a plain `git
 * clone` against the fake yields a working checkout without the spec having to
 * push first. Idempotent: seeding twice leaves the first commit in place.
 */
export function seedBareRepoCommit(state, repo, files = {}) {
    const dir = ensureBareRepo(state, repo.owner, repo.name);
    if (bareRepoHasRefs(dir)) return dir;
    const work = fs.mkdtempSync(path.join(state.gitRoot, 'work-'));
    runGit(['init', '--initial-branch=main', work], undefined);
    runGit(['config', 'user.email', 'e2e@example.invalid'], work);
    runGit(['config', 'user.name', 'APW-13 fake GitHub'], work);
    const entries = Object.keys(files).length > 0 ? files : { 'README.md': `# ${repo.name}\n` };
    for (const [relative, body] of Object.entries(entries)) {
        const target = path.join(work, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
    }
    runGit(['add', '--all'], work);
    runGit(['commit', '--message', 'APW-13 fake GitHub seed commit'], work);
    runGit(['push', '--quiet', dir, 'HEAD:refs/heads/main'], work);
    if (repo.defaultBranch !== 'main') {
        runGit(['branch', repo.defaultBranch, 'main'], dir);
    }
    repo.gitDir = dir;
    return dir;
}

/**
 * Match a Git smart-HTTP path, which is exactly what `clone_url` advertises:
 * `/<owner>/<repo>.git/...`.
 *
 * `pathInfo` is the **whole** pathname: `git http-backend` resolves it against
 * `GIT_PROJECT_ROOT`, and the bare repository really does live at
 * `<root>/<owner>/<repo>.git`, so stripping a prefix here would point the
 * backend at a path that does not exist (it answers a bare `500` when it
 * cannot find the repository, with no body to explain why).
 */
export function matchGitPath(pathname) {
    const marker = pathname.indexOf('.git/');
    if (marker === -1) return null;
    const segments = pathname.slice(0, marker).split('/').filter(Boolean);
    if (segments.length !== 2) return null;
    const [owner, name] = segments;
    if (!owner || !name) return null;
    return { owner, name, pathInfo: pathname };
}

/**
 * Run `git http-backend` for one request and return its CGI response.
 *
 * The backend speaks CGI: headers on stdout, `\r\n\r\n`, then a possibly binary
 * body. We accumulate Buffers and split on the header terminator so the pack
 * stream is never decoded as text.
 */
export function runGitHttpBackend({
    state,
    method,
    pathInfo,
    queryString,
    contentType,
    contentEncoding,
    rawBody,
}) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['http-backend'], {
            env: {
                ...process.env,
                GIT_PROJECT_ROOT: state.gitRoot,
                GIT_HTTP_EXPORT_ALL: '1',
                PATH_INFO: pathInfo,
                REQUEST_METHOD: method,
                QUERY_STRING: queryString ?? '',
                CONTENT_TYPE: contentType ?? '',
                // A smart-HTTP client gzips a large `upload-pack` request and says so;
                // `git http-backend` only decompresses it when CGI is told, and without
                // this it reads the gzip stream as a pack it cannot parse.
                HTTP_CONTENT_ENCODING: contentEncoding ?? '',
                CONTENT_LENGTH: String(rawBody?.length ?? 0),
                REMOTE_USER: 'apw-e2e',
                REMOTE_ADDR: '127.0.0.1',
                SERVER_PROTOCOL: 'HTTP/1.1',
                SERVER_NAME: '127.0.0.1',
            },
        });
        const chunks = [];
        const errors = [];
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', (chunk) => errors.push(chunk));
        child.on('error', reject);
        child.on('close', () => {
            const buffer = Buffer.concat(chunks);
            const separator = buffer.indexOf('\r\n\r\n');
            const fallback = buffer.indexOf('\n\n');
            const at = separator !== -1 ? separator : fallback;
            if (at === -1) {
                resolve({
                    status: 500,
                    headers: { 'content-type': 'text/plain' },
                    body: Buffer.from(
                        `git http-backend produced no CGI header block\n${Buffer.concat(errors).toString('utf8')}`,
                    ),
                });
                return;
            }
            const headerText = buffer.subarray(0, at).toString('utf8');
            const body = buffer.subarray(at + (separator !== -1 ? 4 : 2));
            const headers = {};
            let status = 200;
            for (const line of headerText.split(/\r?\n/)) {
                if (!line.trim()) continue;
                const colon = line.indexOf(':');
                if (colon === -1) continue;
                const key = line.slice(0, colon).trim().toLowerCase();
                const value = line.slice(colon + 1).trim();
                if (key === 'status') {
                    const parsed = Number.parseInt(value, 10);
                    if (Number.isFinite(parsed)) status = parsed;
                    continue;
                }
                headers[key] = value;
            }
            resolve({ status, headers, body });
        });
        if (rawBody && rawBody.length > 0) child.stdin.write(rawBody);
        child.stdin.end();
    });
}

/**
 * Copy every branch from one bare repository to another. This is what makes
 * `include_all_branches: true` real for `POST /repos/:o/:r/generate`
 * (`plan.md` §8.3; T9's `generateFromTemplate` asserts the copy carries the
 * `variant/*` branches).
 */
export function copyRefsBetweenBareRepos(fromDir, toDir) {
    if (!fromDir || !fs.existsSync(fromDir)) return [];
    const listed = spawnSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
        cwd: fromDir,
        encoding: 'utf8',
    });
    if (listed.status !== 0) return [];
    const branches = (listed.stdout ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (branches.length === 0) return [];
    runGit(['fetch', fromDir, 'refs/heads/*:refs/heads/*'], toDir);
    return branches;
}

/**
 * T45 — delete one branch from a bare repository, for `DELETE
 * /repos/:o/:r/git/refs/*ref` (APW-09's **Withdraw**, FR-33/FR-45).
 *
 * Best-effort and quiet by design: a branch the bare repository never had is not
 * an error here (`git branch -D` on a missing branch exits non-zero), because the
 * repository record is the fake's authority on which refs exist and it is checked
 * by the caller before this runs. A missing directory, or a `git` that cannot run
 * at all, must not turn a `204` into a crash — the platform's own assertion is
 * that the branch is gone, and the record answers that.
 */
export function deleteBareBranch(dir, branch) {
    if (!dir || !fs.existsSync(dir) || !branch) return false;
    const result = spawnSync('git', ['branch', '-D', branch], { cwd: dir, encoding: 'utf8' });
    return result.status === 0;
}

/** Remove the temp git root. Best-effort: a locked file must not fail a spec. */
export function cleanupGitRoot(state) {
    try {
        fs.rmSync(state.gitRoot, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
}
