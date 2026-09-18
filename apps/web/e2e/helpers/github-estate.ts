/**
 * GitHub estate operations for the App Works acceptance harness (APW-13 T9,
 * `docs/specs/features/app-works/APW-13-golden-paths/tasks.md:140`).
 *
 * Contract of this module (plan §8.2, `plan.md:501`):
 *
 *   - Every call goes through the GitHub REST API with plain `fetch` and
 *     **never throws on an HTTP outcome** — each function resolves to
 *     `{ status, body }`, so a lane asserts the platform's behaviour on a 403
 *     or a 404 instead of catching it. Argument-shape errors (a malformed
 *     `repo`, a variant push with no customer token) do throw: they are
 *     programming errors, not observations.
 *   - **No HTTP deletion verb is ever built by this module**, and no function
 *     here is named for one. ACC-13-17 (`spec.md:551`) forbids a lane code path
 *     that can delete a GitHub repository; the estate is archived, never
 *     removed (FR-60, T68). The static half of that criterion is enforced by
 *     `apps/web/e2e/helpers/__tests__/github-estate.unit.spec.ts`, which walks
 *     `apps/web/e2e/**` and scans this module's real export surface.
 *
 * Base URL and estate token are parameters with environment defaults:
 *
 *   - `APW_E2E_GITHUB_ESTATE_TOKEN` — the estate organization's token
 *     (CONTRACTS §7). It is the default for every read and for per-run upstream
 *     setup only; `pushCommit` deliberately has **no** estate fallback, because
 *     a variant push must carry the customer's own token (T67,
 *     `tasks.md:776`).
 *   - `APW_E2E_GITHUB_FAKE_URL` — honoured only while `EVER_WORKS_E2E_FAKES=1`,
 *     so the PR lanes can be pointed at the fake GitHub (plan §8.3, `plan.md:549`)
 *     while a live lane can never be silently redirected by a stray variable.
 */

export interface GithubResult<T = unknown> {
    /** The HTTP status of the response, or of the first failing call. */
    status: number;
    body: T;
}

/** Every estate call takes the repository plus optional base URL / token. */
export interface EstateCall {
    /** The repository, `owner/name`. */
    repo: string;
    /** API base URL; defaults as documented in the module header. */
    baseUrl?: string;
    /** Token; defaults to `APW_E2E_GITHUB_ESTATE_TOKEN`. */
    token?: string;
}

export interface GenerateFromTemplateInput extends EstateCall {
    /** Name of the generated repository (no owner part). */
    newName: string;
    /**
     * Accepted for call-site clarity and **always sent as `true`** — see
     * {@link generateFromTemplate}. Passing `false` cannot turn branches off.
     */
    includeAllBranches?: boolean;
    /** Owner of the generated repository; defaults to `repo`'s owner. */
    owner?: string;
    /** Repository description; the harness labels generated copies here. */
    description?: string;
    /** Whether the copy is private; the estate's copies are private by default. */
    isPrivate?: boolean;
}

export interface PushCommitInput extends EstateCall {
    /** Branch the commit lands on, e.g. the fork's tracked branch. */
    branch: string;
    /** Either `{ path: content }` or an ordered list of `{ path, content }`. */
    files: CommitFiles;
    /** Commit message. */
    message: string;
    /**
     * **Required.** The customer account's own token — the estate token must
     * not be used for a platform-facing push (T67, `tasks.md:776-787`).
     */
    token: string;
}

export type CommitFiles = Record<string, string> | ReadonlyArray<{ path: string; content: string }>;

export interface PushCommitBody {
    branch: string;
    /** One entry per file, in the order the files were submitted. */
    commits: Array<{ path: string; status: number; body: unknown }>;
}

export interface ArchiveAndLabelInput extends EstateCall {
    /** The run id, recorded in the archived repository's description. */
    runId: string;
    /** Topics kept on the repository; `apw-e2e-expired` is always added. */
    topics?: string[];
    /** Description prefix; the run id is appended after it. */
    descriptionPrefix?: string;
}

export interface ArchiveAndLabelBody {
    fullName: string;
    archived: boolean;
    description: string;
    topics: string[];
    /** Per-call outcomes, so a partly-applied archive is visible. */
    calls: Array<{ label: string; status: number }>;
}

export interface ClosePullRequestInput extends EstateCall {
    /** The pull request number. */
    number: number;
}

export interface ListWorkflowRunsInput extends EstateCall {
    branch?: string;
    /** `queued` | `in_progress` | `completed` | … (GitHub's own vocabulary). */
    status?: string;
    perPage?: number;
}

export interface ListWorkflowRunsBody {
    total_count: number;
    workflow_runs: Array<{
        id: number;
        status: string;
        conclusion: string | null;
        head_sha: string;
        head_branch: string;
        run_started_at?: string;
        html_url?: string;
    }>;
}

export interface ListPullsInput extends EstateCall {
    /** `open` (default) | `closed` | `all`. */
    state?: 'open' | 'closed' | 'all';
    head?: string;
    base?: string;
    perPage?: number;
}

export interface PullSummary {
    number: number;
    state: string;
    title: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    html_url?: string;
}

export interface UserPermissionBody {
    permission: 'admin' | 'maintain' | 'push' | 'triage' | 'pull' | 'none';
    role_name?: string;
    user?: { login: string };
}

/** The topic the harness stamps on an expired per-run repository (T9). */
export const EXPIRED_TOPIC = 'apw-e2e-expired';

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * The HTTP verbs this module can build. The deletion verb is deliberately
 * absent from the union, so a call site cannot reach it even by accident.
 */
type AllowedMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

function resolveBaseUrl(baseUrl?: string): string {
    const explicit = baseUrl?.trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    const fake = process.env.APW_E2E_GITHUB_FAKE_URL?.trim();
    if (process.env.EVER_WORKS_E2E_FAKES === '1' && fake) return fake.replace(/\/+$/, '');
    return GITHUB_API_BASE;
}

function resolveToken(token?: string): string | undefined {
    const value = (token ?? process.env.APW_E2E_GITHUB_ESTATE_TOKEN ?? '').trim();
    return value.length > 0 ? value : undefined;
}

function splitRepo(repo: string): { owner: string; name: string; fullName: string } {
    const parts = String(repo ?? '')
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`github-estate: \`repo\` must be "owner/name", got "${String(repo)}"`);
    }
    return { owner: parts[0], name: parts[1], fullName: `${parts[0]}/${parts[1]}` };
}

async function readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

async function call<T>(
    url: string,
    init: { method: AllowedMethod; token?: string; body?: unknown },
): Promise<GithubResult<T>> {
    const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ever-works-apw13-harness',
    };
    if (init.token) headers.authorization = `Bearer ${init.token}`;

    const res = await fetch(url, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: res.status, body: (await readBody(res)) as T };
}

function normaliseFiles(files: CommitFiles): Array<{ path: string; content: string }> {
    if (Array.isArray(files)) {
        return files.map((file) => ({
            path: String(file.path).replace(/^\/+/, ''),
            content: String(file.content ?? ''),
        }));
    }
    return Object.entries(files as Record<string, string>).map(([path, content]) => ({
        path: path.replace(/^\/+/, ''),
        content: String(content ?? ''),
    }));
}

/**
 * `POST /repos/{owner}/{repo}/generate` — copy the template repository into the
 * estate organization (T9, `tasks.md:141`).
 *
 * `include_all_branches` is **always** `true`: the fixture's `variant/*`
 * branches must travel with the copy (FR-60, T68 — `tasks.md:142`), and a copy
 * that dropped them would silently produce a lane that can never exercise a
 * build-failure variant. The `includeAllBranches` parameter therefore accepts
 * the intent but cannot turn branches off; there is no wire value for "copy
 * without branches" in this helper.
 */
export async function generateFromTemplate(
    input: GenerateFromTemplateInput,
): Promise<GithubResult<{ full_name?: string; name?: string; owner?: { login?: string } }>> {
    const { fullName } = splitRepo(input.repo);
    const owner = input.owner?.trim() || fullName.split('/')[0];
    const url = `${resolveBaseUrl(input.baseUrl)}/repos/${fullName}/generate`;
    return call(url, {
        method: 'POST',
        token: resolveToken(input.token),
        body: {
            owner,
            name: input.newName,
            description: input.description ?? `APW-13 e2e estate copy of ${fullName}`,
            private: input.isPrivate ?? true,
            include_all_branches: true,
        },
    });
}

/**
 * Commit files to a branch through the contents API
 * (`PUT /repos/{owner}/{repo}/contents/{path}`) — T9, `tasks.md:143`.
 *
 * The token is **the caller's explicit choice and never inherited**: a variant
 * push carries the customer account's own token (T67, `tasks.md:780-781`), and
 * only per-run upstream setup uses the estate token. A missing `token` is
 * therefore refused here rather than silently defaulting to the estate.
 */
export async function pushCommit(input: PushCommitInput): Promise<GithubResult<PushCommitBody>> {
    const { fullName } = splitRepo(input.repo);
    const explicit = input.token?.trim();
    if (!explicit) {
        throw new Error(
            "github-estate.pushCommit: `token` is required — pass the customer account's own " +
                'token for a variant push (T67); this helper never falls back to ' +
                'APW_E2E_GITHUB_ESTATE_TOKEN.',
        );
    }
    if (!input.branch?.trim()) {
        throw new Error('github-estate.pushCommit: `branch` is required');
    }

    const base = `${resolveBaseUrl(input.baseUrl)}/repos/${fullName}`;
    const commits: PushCommitBody['commits'] = [];
    let status = 200;

    for (const file of normaliseFiles(input.files)) {
        // The contents API needs the blob sha to replace an existing file.
        const existing = await call<{ sha?: string }>(
            `${base}/contents/${file.path}?ref=${encodeURIComponent(input.branch)}`,
            { method: 'GET', token: explicit },
        );
        const sha = existing.status === 200 ? existing.body?.sha : undefined;

        const result = await call<unknown>(`${base}/contents/${file.path}`, {
            method: 'PUT',
            token: explicit,
            body: {
                message: input.message,
                content: Buffer.from(file.content, 'utf8').toString('base64'),
                branch: input.branch,
                ...(sha ? { sha } : {}),
            },
        });
        if (status < 300 && result.status >= 300) status = result.status;
        commits.push({ path: file.path, status: result.status, body: result.body });
    }

    return { status, body: { branch: input.branch, commits } };
}

/**
 * Archive the per-run repository and stamp it for the operator (T9,
 * `tasks.md:144`): `PATCH /repos/{owner}/{repo}` with `archived: true` and the
 * run id in the description, plus the `apw-e2e-expired` topic merged into
 * `PUT /repos/{owner}/{repo}/topics`.
 *
 * Archiving — not deleting — is the estate's end-of-run operation
 * (ACC-13-17, `spec.md:551`; plan §7 keeps pruning out of scope).
 */
export async function archiveAndLabel(
    input: ArchiveAndLabelInput,
): Promise<GithubResult<ArchiveAndLabelBody>> {
    const { fullName } = splitRepo(input.repo);
    const base = `${resolveBaseUrl(input.baseUrl)}/repos/${fullName}`;
    const token = resolveToken(input.token);
    const prefix = input.descriptionPrefix?.trim() || 'APW-13 acceptance run';
    const description = `${prefix} ${input.runId} — expired, kept for investigation`;
    const calls: ArchiveAndLabelBody['calls'] = [];

    const archived = await call<{ archived?: boolean }>(base, {
        method: 'PATCH',
        token,
        body: { archived: true, description },
    });
    calls.push({ label: 'archive', status: archived.status });

    const current = await call<{ names?: string[] }>(`${base}/topics`, {
        method: 'GET',
        token,
    });
    const topics = Array.from(
        new Set([...(current.body?.names ?? []), ...(input.topics ?? []), EXPIRED_TOPIC]),
    ).sort();
    const labelled = await call<{ names?: string[] }>(`${base}/topics`, {
        method: 'PUT',
        token,
        body: { names: topics },
    });
    calls.push({ label: 'topics', status: labelled.status });

    let status = 200;
    for (const entry of calls) {
        if (status < 300 && entry.status >= 300) status = entry.status;
    }

    return {
        status,
        body: {
            fullName,
            archived: archived.status < 300,
            description,
            topics,
            calls,
        },
    };
}

/** `PATCH /repos/{owner}/{repo}/pulls/{number}` with `state: closed` (T9). */
export async function closePullRequest(
    input: ClosePullRequestInput,
): Promise<GithubResult<PullSummary>> {
    const { fullName } = splitRepo(input.repo);
    if (!Number.isInteger(input.number) || input.number <= 0) {
        throw new Error(`github-estate.closePullRequest: invalid number ${String(input.number)}`);
    }
    const url = `${resolveBaseUrl(input.baseUrl)}/repos/${fullName}/pulls/${input.number}`;
    return call<PullSummary>(url, {
        method: 'PATCH',
        token: resolveToken(input.token),
        body: { state: 'closed' },
    });
}

/** `GET /repos/{owner}/{repo}` — fork / archived / permissions state (T9). */
export async function getRepo(input: EstateCall): Promise<
    GithubResult<{
        full_name?: string;
        fork?: boolean;
        archived?: boolean;
        default_branch?: string;
        permissions?: Record<string, boolean>;
        parent?: { full_name?: string } | null;
        source?: { full_name?: string } | null;
    }>
> {
    const { fullName } = splitRepo(input.repo);
    return call(`${resolveBaseUrl(input.baseUrl)}/repos/${fullName}`, {
        method: 'GET',
        token: resolveToken(input.token),
    });
}

/** `GET /repos/{owner}/{repo}/actions/permissions` (T9). */
export async function getActionsPermissions(
    input: EstateCall,
): Promise<
    GithubResult<{ enabled?: boolean; allowed_actions?: string; sha_pinning_required?: boolean }>
> {
    const { fullName } = splitRepo(input.repo);
    return call(`${resolveBaseUrl(input.baseUrl)}/repos/${fullName}/actions/permissions`, {
        method: 'GET',
        token: resolveToken(input.token),
    });
}

/** `GET /repos/{owner}/{repo}/actions/runs` — the estate's Actions hygiene read. */
export async function listWorkflowRuns(
    input: ListWorkflowRunsInput,
): Promise<GithubResult<ListWorkflowRunsBody>> {
    const { fullName } = splitRepo(input.repo);
    const query = new URLSearchParams();
    if (input.branch) query.set('branch', input.branch);
    if (input.status) query.set('status', input.status);
    query.set('per_page', String(input.perPage ?? 30));
    const url = `${resolveBaseUrl(input.baseUrl)}/repos/${fullName}/actions/runs?${query.toString()}`;
    return call<ListWorkflowRunsBody>(url, { method: 'GET', token: resolveToken(input.token) });
}

/** `GET /repos/{owner}/{repo}/pulls` — open/fork PR state for a lane. */
export async function listPulls(input: ListPullsInput): Promise<GithubResult<PullSummary[]>> {
    const { fullName } = splitRepo(input.repo);
    const query = new URLSearchParams();
    query.set('state', input.state ?? 'open');
    if (input.head) query.set('head', input.head);
    if (input.base) query.set('base', input.base);
    query.set('per_page', String(input.perPage ?? 30));
    const url = `${resolveBaseUrl(input.baseUrl)}/repos/${fullName}/pulls?${query.toString()}`;
    return call<PullSummary[]>(url, { method: 'GET', token: resolveToken(input.token) });
}

/** `GET /repos/{owner}/{repo}/collaborators/{username}/permission` (T9). */
export async function getUserPermission(
    input: EstateCall & { username: string },
): Promise<GithubResult<UserPermissionBody>> {
    const { fullName } = splitRepo(input.repo);
    const username = input.username?.trim();
    if (!username) {
        throw new Error('github-estate.getUserPermission: `username` is required');
    }
    const url =
        `${resolveBaseUrl(input.baseUrl)}/repos/${fullName}` +
        `/collaborators/${encodeURIComponent(username)}/permission`;
    return call<UserPermissionBody>(url, {
        method: 'GET',
        token: resolveToken(input.token),
    });
}
