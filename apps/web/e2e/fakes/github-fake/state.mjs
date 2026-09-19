/**
 * In-memory state for the APW-13 fake GitHub (task T2,
 * `docs/specs/features/app-works/APW-13-golden-paths/tasks.md` P0.1).
 *
 * The fake is test infrastructure, never a plugin and never loaded by the
 * platform (`plan.md` §13, Constitution I). This module holds everything the
 * routes read and write:
 *
 *   - repositories, with per-login `permissions`, fork linkage and a
 *     **readiness clock** (a fork answers `404` until `readyAt`, or forever when
 *     a `never-ready` fault was planted — `plan.md` §8.3 fault vocabulary);
 *   - token identities — the fake maps a token **value** to a login once, at
 *     seed time, and thereafter records and faults only the **identity**
 *     (`plan.md` §8.3: `GET /_control/calls` records "token identity (never a
 *     value)");
 *   - the catalog fixtures (the test `ever-works/templates` listing, the three
 *     Blueprint repositories, the amber and red licence upstreams) so a spec
 *     seeds them from a checked-in JSON file rather than per-test code;
 *   - the call log and the planted-fault queue used by `/_control/*`.
 *
 * Everything here is plain data plus pure-ish helpers, so `server.mjs` stays a
 * router and the unit specs can drive state directly.
 */

import os from 'node:os';
import path from 'node:path';

/** GitHub's `permissions` object, for a login with read-only access. */
export const READ_ONLY_PERMISSIONS = Object.freeze({
    admin: false,
    maintain: false,
    push: false,
    triage: false,
    pull: true,
});

/** The six fault behaviours of plan §8.3. */
export const FAULT_BEHAVIOURS = Object.freeze([
    'delay',
    'never-ready',
    'rate-limit',
    'server-error',
    'auth-refused',
    'conflict',
]);

/** Behaviours the router answers with a status instead of running the handler. */
export const RESPONSE_BEHAVIOURS = Object.freeze([
    'rate-limit',
    'server-error',
    'auth-refused',
    'conflict',
]);

/** Behaviours the fork handler consumes to shape readiness. */
export const READINESS_BEHAVIOURS = Object.freeze(['delay', 'never-ready']);

/**
 * Create an empty state. `gitRoot` is where `git-backend.mjs` keeps the bare
 * repositories; the default is a per-process temp directory so two concurrent
 * runs never share a checkout.
 */
export function createState(options = {}) {
    const gitRoot =
        options.gitRoot ??
        path.join(os.tmpdir(), `apw-github-fake-${process.pid}-${Date.now().toString(36)}`);
    return {
        gitRoot,
        generatedAt: new Date().toISOString(),
        seq: { repo: 1_000_000, hook: 1, ref: 1, object: 1, pull: 1, run: 1, comment: 1 },
        /** key `owner/name` (lower-cased) -> repository record */
        repositories: new Map(),
        /** token value -> { login, permissions, scopes } — never echoed back */
        users: new Map(),
        organizations: [],
        catalog: null,
        blueprints: [],
        calls: [],
        faults: [],
    };
}

export function repoKey(owner, name) {
    return `${String(owner).toLowerCase()}/${String(name).toLowerCase()}`;
}

/**
 * Insert or replace a repository from the `/_control/seed` shape (plan §8.3).
 * Seeding is idempotent so a spec can re-seed between scenarios.
 */
export function upsertRepository(state, input, parents = {}) {
    const owner = input.owner;
    const name = input.name;
    const key = repoKey(owner, name);
    const existing = state.repositories.get(key);
    const record = {
        // The projection needs to resolve a fork's `parent`, so the record keeps
        // a back-reference to its state. A record is never shared between two
        // fake instances.
        __state: state,
        owner,
        name,
        id: input.id ?? existing?.id ?? state.seq.repo++,
        description: input.description ?? `${owner}/${name} (APW-13 fake GitHub fixture)`,
        defaultBranch: input.defaultBranch ?? existing?.defaultBranch ?? 'main',
        private: input.private ?? existing?.private ?? false,
        archived: input.archived ?? existing?.archived ?? false,
        forkingAllowed: input.forkingAllowed ?? existing?.forkingAllowed ?? true,
        license: input.license ?? existing?.license ?? null,
        topics: input.topics ?? existing?.topics ?? [],
        fork: input.fork ?? existing?.fork ?? Boolean(parents.parentFullName),
        parentFullName:
            input.parentFullName ?? parents.parentFullName ?? existing?.parentFullName ?? null,
        sourceFullName:
            input.sourceFullName ?? parents.sourceFullName ?? existing?.sourceFullName ?? null,
        createdAt: input.createdAt ?? existing?.createdAt ?? state.generatedAt,
        updatedAt: input.updatedAt ?? existing?.updatedAt ?? state.generatedAt,
        pushedAt: input.pushedAt ?? existing?.pushedAt ?? state.generatedAt,
        /** login -> `{ push, admin }`, from the seed's `permissions` array */
        permissions: seedPermissions(input.permissions),
        /** epoch ms; a fork is invisible (404) before this */
        readyAt: input.readyAt ?? existing?.readyAt ?? 0,
        hooks: existing?.hooks ?? [],
        refs: existing?.refs ?? new Map(),
        commits: existing?.commits ?? new Map(),
        trees: existing?.trees ?? new Map(),
        blobs: existing?.blobs ?? new Map(),
        pulls: existing?.pulls ?? new Map(),
        issueComments: existing?.issueComments ?? new Map(),
        workflowRuns: existing?.workflowRuns ?? [],
        actionsPermissions: existing?.actionsPermissions ?? {
            enabled: true,
            allowed_actions: 'all',
            selected_actions_url: null,
        },
        workflows: existing?.workflows ?? [],
        actionsSecrets: existing?.actionsSecrets ?? new Map(),
        branchProtection: existing?.branchProtection ?? null,
        /** paths served by `routes/contents.mjs`, seeded on demand */
        contents: existing?.contents ?? new Map(),
        readme: existing?.readme ?? null,
        gitDir: existing?.gitDir ?? null,
    };
    state.repositories.set(key, record);
    return record;
}

function seedPermissions(list) {
    const map = new Map();
    for (const entry of list ?? []) {
        map.set(String(entry.login).toLowerCase(), {
            push: Boolean(entry.push),
            admin: Boolean(entry.admin),
        });
    }
    return map;
}

export function findRepository(state, owner, name) {
    if (!owner || !name) return undefined;
    return state.repositories.get(repoKey(owner, name));
}

/**
 * A repository as a consumer sees it: a fork that is still being prepared is
 * indistinguishable from one that does not exist — the real API answers `404`
 * for a fork in flight, which is exactly the signal APW-02's readiness poll
 * reads.
 */
export function findVisibleRepository(state, owner, name, now = Date.now()) {
    const repo = findRepository(state, owner, name);
    if (!repo) return undefined;
    if (repo.readyAt > now) return undefined;
    return repo;
}

export function permissionsFor(repo, identity) {
    const granted = repo.permissions.get(String(identity ?? 'anonymous').toLowerCase());
    const base = { ...READ_ONLY_PERMISSIONS };
    if (granted) {
        base.push = granted.push;
        base.admin = granted.admin;
        base.maintain = granted.push;
    }
    return base;
}

export function seedUser(state, user) {
    state.users.set(user.token, {
        login: user.login,
        permissions: user.permissions ?? [],
        scopes: user.scopes ?? [],
    });
    if (user.organizations) {
        for (const login of user.organizations) {
            if (!state.organizations.includes(login)) state.organizations.push(login);
        }
    }
}

/**
 * `/_control/seed` (plan §8.3). Accepts the documented shape and is additive:
 * an unknown key is ignored rather than fatal, so a newer spec fixture does not
 * break an older fake.
 */
export function seed(state, payload = {}) {
    for (const repo of payload.repositories ?? []) upsertRepository(state, repo);
    for (const user of payload.users ?? []) seedUser(state, user);
    if (payload.organizations) {
        for (const login of payload.organizations) {
            if (!state.organizations.includes(login)) state.organizations.push(login);
        }
    }
    if (payload.catalog) state.catalog = payload.catalog;
    if (payload.blueprints) state.blueprints = payload.blueprints.map((entry) => ({ ...entry }));
    return {
        repositories: state.repositories.size,
        users: state.users.size,
        organizations: state.organizations.length,
        catalog: state.catalog ? 1 : 0,
        blueprints: state.blueprints.length,
    };
}

/** Reset everything except the git root — the unit specs use this between cases. */
export function reset(state) {
    state.repositories.clear();
    state.users.clear();
    state.organizations = [];
    state.catalog = null;
    state.blueprints = [];
    state.calls.length = 0;
    state.faults.length = 0;
    state.seq = { repo: 1_000_000, hook: 1, ref: 1, object: 1, pull: 1, run: 1, comment: 1 };
}

/** The token **identity** for a request — a login, `anonymous` or `unknown`. */
export function identityForToken(state, token) {
    if (!token) return 'anonymous';
    const user = state.users.get(token);
    return user ? user.login : 'unknown';
}

/** Extract the token from an `Authorization` header without echoing its value. */
export function tokenFromHeaders(headers) {
    const raw = headers?.authorization ?? headers?.Authorization;
    if (!raw || typeof raw !== 'string') return '';
    return raw.replace(/^(Bearer|token|Basic)\s+/i, '').trim();
}

export function recordCall(state, entry) {
    state.calls.push({
        method: entry.method,
        path: entry.path,
        tokenIdentity: entry.tokenIdentity,
        authenticated: entry.tokenIdentity !== 'anonymous' && entry.tokenIdentity !== 'unknown',
        faultApplied: entry.faultApplied ?? null,
        status: entry.status ?? null,
        at: new Date().toISOString(),
    });
    return state.calls[state.calls.length - 1];
}

/**
 * Plant a fault. `route` is matched against the request pathname: an exact
 * match, or a trailing `*` wildcard (`/repos/*`).
 *
 * **Narrowing, and which one a case wants.** Two optional keys say *whose* call
 * the fault is about, and either may be used alone or together:
 *
 *   - `token` — the token **identity** the fake resolved (a login, or the
 *     literal `anonymous` / `unknown` it fell back to). This is what APW-01's
 *     "401 for the member's token, then restored" case needs (plan §8.3).
 *   - `tokenValue` — the token **value** the caller presented. This is what a
 *     **dead credential** needs, and it is the one case `token` cannot express:
 *     a revoked token has no identity, because the fake never seeded it, so
 *     every such token collapses to the single identity `unknown` and an
 *     identity-narrowed fault cannot tell two of them apart (nor survive two
 *     spec files arming at once — the fault is one-shot and the first matching
 *     call takes it). `tokenValue` pins the fault to the exact token, so a
 *     second lane arming its own dead token cannot steal it.
 *
 * A planted `tokenValue` is echoed back by `GET /_control/faults` — it is a
 * fixture literal, exactly as `/_control/seed`'s `users[].token` is. The
 * surface that must never carry a value is the **call log** (`recordCall`), and
 * it still records the identity only.
 */
export function addFault(state, fault) {
    if (!FAULT_BEHAVIOURS.includes(fault.behaviour)) {
        throw new Error(
            `unknown fault behaviour '${fault.behaviour}' (expected one of ${FAULT_BEHAVIOURS.join(', ')})`,
        );
    }
    const entry = {
        route: fault.route ?? '*',
        method: fault.method ? String(fault.method).toUpperCase() : null,
        token: fault.token ?? null,
        tokenValue: fault.tokenValue ?? null,
        behaviour: fault.behaviour,
        status: fault.status ?? null,
        body: fault.body ?? null,
        seconds: fault.seconds ?? fault.delaySeconds ?? null,
        times: fault.times ?? 1,
        remaining: fault.times ?? 1,
    };
    state.faults.push(entry);
    return entry;
}

function routeMatches(fault, method, pathname) {
    if (fault.method && fault.method !== method) return false;
    if (fault.route === '*') return true;
    if (fault.route.endsWith('*')) return pathname.startsWith(fault.route.slice(0, -1));
    return pathname === fault.route;
}

/**
 * Take the next applicable fault for this request, decrementing its remaining
 * applications and dropping it once spent. Returns `null` when no fault
 * applies, so a route runs normally.
 *
 * `tokenIdentity` is matched against a fault's `token`; `tokenValue` against its
 * `tokenValue`. A fault that declares a narrowing key only matches a request
 * that supplies the same value, so a fault narrowed to a token value never
 * fires for a request whose value the caller did not pass.
 */
export function takeFault(
    state,
    { method, pathname, tokenIdentity, tokenValue, behaviours = RESPONSE_BEHAVIOURS },
) {
    for (let index = 0; index < state.faults.length; index++) {
        const fault = state.faults[index];
        if (!behaviours.includes(fault.behaviour)) continue;
        if (fault.remaining <= 0) continue;
        if (fault.token && fault.token !== tokenIdentity) continue;
        if (fault.tokenValue && fault.tokenValue !== tokenValue) continue;
        if (!routeMatches(fault, method, pathname)) continue;
        fault.remaining -= 1;
        if (fault.remaining <= 0) state.faults.splice(index, 1);
        return fault;
    }
    return null;
}

/** The same lookup for the readiness behaviours (`delay`, `never-ready`). */
export function takeReadinessFault(state, { pathname, tokenIdentity }) {
    return takeFault(state, {
        method: 'POST',
        pathname,
        tokenIdentity,
        behaviours: READINESS_BEHAVIOURS,
    });
}

export function listFaults(state) {
    return state.faults.map((fault) => ({ ...fault }));
}

// ---------------------------------------------------------------------------
// Wire projections
//
// These are the fake's response shapes, and they are the other half of the T3
// contract test: `contract.unit.spec.ts` shape-compares every served route
// against its recorded fixture, so the key set of the functions below and the
// key set of `fixtures/*.json` must agree exactly.
//
// Two deliberate departures from GitHub's live payloads, both required by T1
// ("Strip tokens, emails and node ids") and both recorded in
// `fixtures/README.md`:
//   - no `node_id` anywhere, and no `git_url`/`ssh_url` (the SSH form carries a
//     `git@…` string that an email scan would flag);
//   - commit/tag author objects carry `{ name, date }` and no `email`.
// ---------------------------------------------------------------------------

/** A stable numeric id derived from a login, so two runs agree on sort order. */
function loginId(login) {
    let hash = 7;
    for (const ch of String(login)) hash = (hash * 31 + ch.charCodeAt(0)) % 9_000_000;
    return 1_000 + hash;
}

// The hosts the fake puts in `url`-shaped fields. These stay the *real* hosts —
// only `clone_url` and the fork-list `clone_url` point at the fake, because that
// is the one field the platform hands to git (`plan.md` §8.3). Keeping the rest
// faithful is what lets the recorded fixtures of T1 be compared field for field.
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

/** `https://api.github.com/repos/<owner>/<name>` for a repository record. */
function apiBase(repo) {
    return `${API}/repos/${repo.owner}/${repo.name}`;
}

export function ownerPayload(login) {
    return {
        login: String(login),
        id: loginId(login),
        type: 'User',
        site_admin: false,
    };
}

export function licenseSummaryPayload(license, origin) {
    if (!license) return null;
    return {
        key: license.key,
        name: license.name,
        spdx_id: license.spdx_id,
        url: `${origin}/licenses/${license.key}`,
    };
}

/**
 * The repository projection. `depth` bounds the fork recursion: `parent` and
 * `source` are rendered at depth 1 (their own `parent`/`source` are `null`),
 * which is where the real API's chain terminates for a one-generation fork.
 */
export function repoPayload(repo, origin, depth = 0, identity = 'anonymous') {
    const fullName = `${repo.owner}/${repo.name}`;
    const base = `${origin}/${fullName}`;
    const parent = repo.parentFullName
        ? findRepository(stateOfRepo(repo), ...String(repo.parentFullName).split('/'))
        : undefined;
    return {
        id: repo.id,
        name: repo.name,
        full_name: fullName,
        private: repo.private,
        owner: ownerPayload(repo.owner),
        html_url: base,
        description: repo.description,
        fork: repo.fork,
        url: `${origin}/repos/${fullName}`,
        forks_url: `${origin}/repos/${fullName}/forks`,
        clone_url: `${base}.git`,
        default_branch: repo.defaultBranch,
        archived: repo.archived,
        disabled: false,
        visibility: repo.private ? 'private' : 'public',
        allow_forking: repo.forkingAllowed,
        topics: [...repo.topics],
        license: licenseSummaryPayload(repo.license, origin),
        permissions: permissionsFor(repo, identity),
        parent:
            depth === 0 && parent
                ? repoPayload(parent, origin, depth + 1, identity)
                : depth === 0 && repo.parentFullName
                  ? repoPayload(placeholderRepo(repo.parentFullName), origin, depth + 1, identity)
                  : null,
        source:
            depth === 0 && parent
                ? repoPayload(parent, origin, depth + 1, identity)
                : depth === 0 && repo.sourceFullName
                  ? repoPayload(placeholderRepo(repo.sourceFullName), origin, depth + 1, identity)
                  : null,
        created_at: repo.createdAt,
        updated_at: repo.updatedAt,
        pushed_at: repo.pushedAt,
    };
}

// The `parent` lookup needs a state handle, but the projection is called from
// the router which has one. Rather than thread it through every call site the
// record carries a back-reference (`__state`, set by `upsertRepository`).
function stateOfRepo(repo) {
    return repo.__state;
}

function placeholderRepo(fullName) {
    const [owner, name] = String(fullName).split('/');
    return {
        owner,
        name,
        id: loginId(fullName),
        description: `${fullName} (APW-13 fake GitHub fixture)`,
        defaultBranch: 'main',
        private: false,
        archived: false,
        forkingAllowed: true,
        license: null,
        topics: [],
        fork: false,
        parentFullName: null,
        sourceFullName: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        pushedAt: new Date(0).toISOString(),
        permissions: new Map(),
        readyAt: 0,
        hooks: [],
        refs: new Map(),
        commits: new Map(),
        trees: new Map(),
        blobs: new Map(),
        pulls: new Map(),
        issueComments: new Map(),
        workflowRuns: [],
        actionsPermissions: { enabled: true, allowed_actions: 'all', selected_actions_url: null },
        workflows: [],
        actionsSecrets: new Map(),
        branchProtection: null,
        contents: new Map(),
        readme: null,
        gitDir: null,
    };
}

export function gitRefPayload(repo, refName, sha) {
    const base = apiBase(repo);
    return {
        ref: `refs/${refName}`,
        url: `${base}/git/refs/${refName}`,
        object: { sha, type: 'commit', url: `${base}/git/commits/${sha}` },
    };
}

export function gitTreePayload(sha, entries, truncated = false) {
    const base = `${API}/git/trees`;
    return {
        sha,
        url: `${base}/${sha}`,
        truncated,
        tree: entries.map((entry) => ({
            path: entry.path,
            mode: entry.mode ?? (entry.type === 'tree' ? '040000' : '100644'),
            type: entry.type ?? 'blob',
            sha: entry.sha,
            url: `${base}/${entry.sha}`,
        })),
    };
}

export function gitBlobPayload(sha, content) {
    const body = Buffer.from(content ?? '', 'utf8').toString('base64');
    return {
        sha,
        url: `${API}/git/blobs/${sha}`,
        size: Buffer.byteLength(content ?? '', 'utf8'),
        encoding: 'base64',
        content: body,
    };
}

/** A commit object for `repo`. The author carries no email (T1 strips them). */
export function gitCommitPayload(repo, input) {
    const base = apiBase(repo);
    return {
        sha: input.sha,
        url: `${base}/git/commits/${input.sha}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${input.sha}`,
        author: { name: input.authorName ?? 'APW-13 fake GitHub', date: input.date },
        committer: { name: input.committerName ?? 'APW-13 fake GitHub', date: input.date },
        message: input.message ?? '',
        tree: { sha: input.treeSha, url: `${base}/git/trees/${input.treeSha}` },
        parents: (input.parentShas ?? []).map((sha) => ({
            sha,
            url: `${base}/git/commits/${sha}`,
        })),
    };
}

export function contentsPayload(repo, entry) {
    const owner = repo.owner;
    const name = repo.name;
    const base = apiBase(repo);
    const htmlUrl = `https://github.com/${owner}/${name}/blob/${repo.defaultBranch}/${entry.path}`;
    return {
        type: 'file',
        encoding: 'base64',
        size: Buffer.byteLength(entry.body ?? '', 'utf8'),
        name: entry.path.split('/').pop(),
        path: entry.path,
        content: Buffer.from(entry.body ?? '', 'utf8').toString('base64'),
        sha: entry.sha,
        url: `${base}/contents/${entry.path}`,
        git_url: `${base}/git/blobs/${entry.sha}`,
        html_url: htmlUrl,
        download_url: `${RAW}/${owner}/${name}/${repo.defaultBranch}/${entry.path}`,
        _links: {
            self: `${base}/contents/${entry.path}`,
            git: `${base}/git/blobs/${entry.sha}`,
            html: `https://github.com/${owner}/${name}/blob/${repo.defaultBranch}/${entry.path}`,
        },
    };
}

export function issueCommentPayload(repo, comment) {
    const owner = repo.owner;
    const name = repo.name;
    const base = apiBase(repo);
    return {
        id: comment.id,
        body: comment.body,
        user: ownerPayload(comment.login),
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
        url: `${base}/issues/comments/${comment.id}`,
        html_url: `https://github.com/${owner}/${name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
        issue_url: `${base}/issues/${comment.issueNumber}`,
        author_association: comment.association ?? 'NONE',
    };
}

export function workflowPayload(repo, workflow) {
    const owner = repo.owner;
    const name = repo.name;
    const base = `${apiBase(repo)}/actions/workflows`;
    return {
        id: workflow.id,
        name: workflow.name,
        path: workflow.path,
        state: workflow.state,
        created_at: repo.createdAt,
        updated_at: repo.updatedAt,
        url: `${base}/${workflow.id}`,
        html_url: `https://github.com/${owner}/${name}/blob/${repo.defaultBranch}/${workflow.path}`,
        badge_url: `https://github.com/${owner}/${name}/workflows/${encodeURIComponent(workflow.name)}/badge.svg`,
    };
}

export function workflowRunPayload(repo, run) {
    const owner = repo.owner;
    const name = repo.name;
    const base = `${apiBase(repo)}/actions/runs`;
    return {
        id: run.id,
        name: run.name,
        display_title: run.displayTitle ?? run.name,
        event: run.event ?? 'workflow_dispatch',
        status: run.status,
        conclusion: run.conclusion,
        head_branch: run.headBranch ?? repo.defaultBranch,
        head_sha: run.headSha,
        run_number: run.runNumber,
        run_attempt: 1,
        workflow_id: run.workflowId,
        url: `${base}/${run.id}`,
        html_url: `https://github.com/${owner}/${name}/actions/runs/${run.id}`,
        jobs_url: `${base}/${run.id}/jobs`,
        artifacts_url: `${base}/${run.id}/artifacts`,
        created_at: run.createdAt,
        updated_at: run.updatedAt,
        run_started_at: run.startedAt,
        pull_requests: [],
        head_commit: null,
    };
}

export function actionStepPayload(step) {
    return {
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        number: step.number,
    };
}

export function actionJobPayload(repo, job) {
    const owner = repo.owner;
    const name = repo.name;
    const base = `${apiBase(repo)}/actions/jobs`;
    return {
        id: job.id,
        run_id: job.runId,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        started_at: job.startedAt,
        completed_at: job.completedAt,
        runner_name: job.runnerName ?? 'apw-e2e-runner',
        html_url: `https://github.com/${owner}/${name}/actions/runs/${job.runId}/job/${job.id}`,
        url: `${base}/${job.id}`,
        steps: (job.steps ?? []).map(actionStepPayload),
    };
}

export function workflowRunFilePayload(file) {
    return {
        sha: file.sha,
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: file.blobUrl ?? '',
        raw_url: file.rawUrl ?? '',
        contents_url: file.contentsUrl ?? '',
        patch: file.patch ?? '',
    };
}

export function repoBranchPayload(repo, branch) {
    const owner = repo.owner;
    const name = repo.name;
    const base = apiBase(repo);
    return {
        name: branch.name,
        commit: { sha: branch.sha, url: `${base}/commits/${branch.sha}` },
        protected: Boolean(branch.protected),
        protection: branch.protected ? branchProtectionPayload(repo) : null,
        protection_url: branch.protected ? `${base}/branches/${branch.name}/protection` : null,
    };
}

export function branchProtectionPayload(repo) {
    const base = `${apiBase(repo)}/branches/${repo.defaultBranch}/protection`;
    return {
        url: base,
        required_status_checks: {
            url: `${base}/required_status_checks`,
            strict: true,
            contexts: ['build'],
            checks: [{ context: 'build', app_id: null }],
        },
        enforce_admins: { url: `${base}/enforce_admins`, enabled: true },
        required_pull_request_reviews: null,
        restrictions: null,
        required_linear_history: { enabled: false },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
    };
}

export function repoHookPayload(repo, hook) {
    const base = `${apiBase(repo)}/hooks`;
    return {
        id: hook.id,
        name: 'web',
        active: true,
        events: [...(hook.events ?? ['push', 'pull_request'])],
        config: { url: hook.url, content_type: 'json', insecure_ssl: '0' },
        created_at: repo.createdAt,
        updated_at: repo.updatedAt,
        url: `${base}/${hook.id}`,
        test_url: `${base}/${hook.id}/tests`,
        ping_url: `${base}/${hook.id}/pings`,
        last_response: { code: null, status: 'unused', message: null },
    };
}

export function pullRequestPayload(repo, pull, origin, identity = 'anonymous') {
    const owner = repo.owner;
    const name = repo.name;
    const base = `${origin}/repos/${owner}/${name}`;
    const headRepo = pull.headRepoFullName
        ? findRepository(stateOfRepo(repo), ...String(pull.headRepoFullName).split('/'))
        : undefined;
    return {
        id: pull.id,
        number: pull.number,
        state: pull.state,
        locked: false,
        title: pull.title,
        body: pull.body ?? '',
        user: ownerPayload(pull.login),
        created_at: pull.createdAt,
        updated_at: pull.updatedAt,
        closed_at: pull.closedAt ?? null,
        merged_at: pull.mergedAt ?? null,
        merge_commit_sha: pull.mergeCommitSha ?? null,
        draft: false,
        merged: Boolean(pull.merged),
        mergeable: true,
        merged_by: pull.merged ? ownerPayload(pull.mergedBy ?? pull.login) : null,
        comments: pull.comments ?? 0,
        commits: pull.commits ?? 1,
        additions: pull.additions ?? 1,
        deletions: pull.deletions ?? 0,
        changed_files: pull.changedFiles ?? 1,
        url: `${base}/pulls/${pull.number}`,
        html_url: `https://github.com/${owner}/${name}/pull/${pull.number}`,
        diff_url: `https://github.com/${owner}/${name}/pull/${pull.number}.diff`,
        patch_url: `https://github.com/${owner}/${name}/pull/${pull.number}.patch`,
        head: {
            label: `${pull.headOwner ?? owner}:${pull.headRef}`,
            ref: pull.headRef,
            sha: pull.headSha,
            user: ownerPayload(pull.headOwner ?? owner),
            repo: headRepo ? repoPayload(headRepo, origin, 1, identity) : null,
        },
        base: {
            label: `${owner}:${pull.baseRef}`,
            ref: pull.baseRef,
            sha: pull.baseSha,
            user: ownerPayload(owner),
            repo: repoPayload(repo, origin, 1, identity),
        },
        _links: {
            self: { href: `${base}/pulls/${pull.number}` },
            html: { href: `https://github.com/${owner}/${name}/pull/${pull.number}` },
            issue: { href: `${base}/issues/${pull.number}` },
            comments: { href: `${base}/issues/${pull.number}/comments` },
            review_comments: { href: `${base}/pulls/${pull.number}/comments` },
            commits: { href: `${base}/pulls/${pull.number}/commits` },
        },
    };
}

export function pullReviewPayload(repo, review) {
    const owner = repo.owner;
    const name = repo.name;
    const base = apiBase(repo);
    return {
        id: review.id,
        user: ownerPayload(review.login),
        body: review.body ?? '',
        state: review.state,
        html_url: `https://github.com/${owner}/${name}/pull/${review.pullNumber}#pullrequestreview-${review.id}`,
        pull_request_url: `${base}/pulls/${review.pullNumber}`,
        submitted_at: review.submittedAt,
        commit_id: review.commitId,
        author_association: review.association ?? 'NONE',
    };
}

export function pullReviewCommentPayload(repo, comment) {
    const owner = repo.owner;
    const name = repo.name;
    const base = apiBase(repo);
    return {
        id: comment.id,
        body: comment.body,
        path: comment.path,
        position: comment.position ?? 1,
        line: comment.line ?? 1,
        commit_id: comment.commitId,
        user: ownerPayload(comment.login),
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
        html_url: `https://github.com/${owner}/${name}/pull/${comment.pullNumber}#discussion_r${comment.id}`,
        pull_request_url: `${base}/pulls/${comment.pullNumber}`,
        author_association: comment.association ?? 'NONE',
        in_reply_to_id: comment.inReplyToId ?? null,
    };
}

export function comparePayload(repo, input) {
    const owner = repo.owner;
    const name = repo.name;
    const base = apiBase(repo);
    return {
        url: `${base}/compare/${input.base}...${input.head}`,
        html_url: `https://github.com/${owner}/${name}/compare/${input.base}...${input.head}`,
        permalink_url: `https://github.com/${owner}/${name}/compare/${input.base}...${input.head}`,
        diff_url: `https://github.com/${owner}/${name}/compare/${input.base}...${input.head}.diff`,
        patch_url: `https://github.com/${owner}/${name}/compare/${input.base}...${input.head}.patch`,
        base_commit: gitCommitPayload(repo, input.baseCommit),
        merge_base_commit: gitCommitPayload(repo, input.baseCommit),
        status: input.status ?? 'ahead',
        ahead_by: input.aheadBy ?? 1,
        behind_by: input.behindBy ?? 0,
        total_commits: input.totalCommits ?? 1,
        commits: (input.commits ?? []).map((commit) => gitCommitPayload(repo, commit)),
        files: (input.files ?? []).map(workflowRunFilePayload),
    };
}
