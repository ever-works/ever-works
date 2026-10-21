/**
 * Fleet — checkouts on computers (FL-14, CONTRACTS §3.3, §4.3, §4.7, §7, §10).
 *
 * A **Checkout** is a git clone or worktree on a Node. Three kinds:
 *
 *  - `discovered` — it was already there: a clone the machine owner keeps in
 *    one of the code folders they listed on the machine (`--code-folder`);
 *  - `clone` — Ever Works cloned it (P2);
 *  - `worktree` — Ever Works added it to an existing checkout, or it is one of
 *    the node's own per-Task worktrees (`createdBy: 'task'`).
 *
 * The NODE is the source of truth for everything about the folder (does it
 * exist, its branch, its git line, its size); the PLATFORM keeps one
 * `fleet_checkouts` row per checkout, the bin (`archived`) and the audit
 * trail. The platform never holds a machine credential and never reads
 * repository content.
 *
 * The node keys a checkout by its absolute PATH (one path, one checkout —
 * discovery never registers a path twice, spec U13); the platform's row is
 * unique on `(nodeId, path)` and carries its own uuid. Every request the
 * platform sends names the path, and the node acts only on a path its own
 * registry holds — never on a folder the platform made up.
 *
 * Everything here is a wire or storage shape; every union carries a
 * `readonly` list and an `isX` guard (the house pattern), and every
 * node→platform shape has a parser that answers `null` — never throws — for
 * anything it does not recognise, because the node is a different release of
 * the code than the platform reading it.
 */

// ─── Kinds, states, isolation, creator (CONTRACTS §4.3) ─────────────────────

export const FLEET_CHECKOUT_KINDS = ['clone', 'worktree', 'discovered'] as const;

export type FleetCheckoutKind = (typeof FLEET_CHECKOUT_KINDS)[number];

export function isFleetCheckoutKind(value: unknown): value is FleetCheckoutKind {
	return typeof value === 'string' && (FLEET_CHECKOUT_KINDS as readonly string[]).includes(value);
}

/**
 * `creating` — a clone or worktree is being made (P2); `ready` — the folder is
 * there; `missing` — the folder is gone from the machine; `archived` — in the
 * bin (the folder is untouched, or "folder removed" after a delete).
 */
export const FLEET_CHECKOUT_STATES = ['creating', 'ready', 'missing', 'archived'] as const;

export type FleetCheckoutState = (typeof FLEET_CHECKOUT_STATES)[number];

export function isFleetCheckoutState(value: unknown): value is FleetCheckoutState {
	return typeof value === 'string' && (FLEET_CHECKOUT_STATES as readonly string[]).includes(value);
}

/** `host` — commands run on the machine itself; `container` — inside a container with the folder mounted (P3). */
export const FLEET_CHECKOUT_ISOLATIONS = ['host', 'container'] as const;

export type FleetCheckoutIsolation = (typeof FLEET_CHECKOUT_ISOLATIONS)[number];

export function isFleetCheckoutIsolation(value: unknown): value is FleetCheckoutIsolation {
	return typeof value === 'string' && (FLEET_CHECKOUT_ISOLATIONS as readonly string[]).includes(value);
}

/** Who made the checkout (CONTRACTS §4.3). */
export const FLEET_CHECKOUT_CREATED_BY = ['user', 'agent', 'task', 'discovery'] as const;

export type FleetCheckoutCreatedBy = (typeof FLEET_CHECKOUT_CREATED_BY)[number];

export function isFleetCheckoutCreatedBy(value: unknown): value is FleetCheckoutCreatedBy {
	return typeof value === 'string' && (FLEET_CHECKOUT_CREATED_BY as readonly string[]).includes(value);
}

/** Network git operations a person may ask for (spec FR-12, FR-21, FR-22). */
export const FLEET_CHECKOUT_SYNC_OPS = ['fetch', 'pull', 'push'] as const;

export type FleetCheckoutSyncOp = (typeof FLEET_CHECKOUT_SYNC_OPS)[number];

export function isFleetCheckoutSyncOp(value: unknown): value is FleetCheckoutSyncOp {
	return typeof value === 'string' && (FLEET_CHECKOUT_SYNC_OPS as readonly string[]).includes(value);
}

/**
 * Where a checkout the node holds came from, as the NODE records it: found by
 * discovery, made on the platform's request, or one of its own Task worktrees.
 */
export const FLEET_NODE_CHECKOUT_ORIGINS = ['discovery', 'platform', 'task'] as const;

export type FleetNodeCheckoutOrigin = (typeof FLEET_NODE_CHECKOUT_ORIGINS)[number];

export function isFleetNodeCheckoutOrigin(value: unknown): value is FleetNodeCheckoutOrigin {
	return typeof value === 'string' && (FLEET_NODE_CHECKOUT_ORIGINS as readonly string[]).includes(value);
}

// ─── Limits and cadences (CONTRACTS §10, §10.1; spec FR-4, FR-9, FR-11) ─────

/** Discovery stops at this many checkouts per Node, and says so (`truncated`). */
export const FLEET_CHECKOUTS_DISCOVERY_CAP = 300;

/** Discovery never descends deeper than this many folders below a code folder. */
export const FLEET_CHECKOUTS_DISCOVERY_MAX_DEPTH = 3;

/** One discovery pass stops after this long, reporting what it found (spec §6: ≤ 30 s). */
export const FLEET_CHECKOUTS_DISCOVERY_BUDGET_MS = 30_000;

/** Folders discovery never descends into: dependency and build output (spec FR-4). */
export const FLEET_CHECKOUTS_DISCOVERY_SKIP_DIRS: readonly string[] = [
	'node_modules',
	'.pnpm-store',
	'dist',
	'build',
	'target',
	'.venv',
	'venv',
	'vendor',
	'.next',
	'.turbo',
	'.cache',
	'__pycache__'
];

/** The git line refreshes this often while a session runs in the checkout. */
export const FLEET_CHECKOUT_GIT_LINE_REFRESH_MS = 60_000;

/** A person may refresh one checkout's git line at most this often. */
export const FLEET_CHECKOUT_MANUAL_REFRESH_MIN_MS = 10_000;

/** A listed checkout's git line is recomputed at most this often when nothing runs in it. */
export const FLEET_CHECKOUT_LISTED_REFRESH_MS = 5 * 60_000;

/** The node re-checks every checkout's folder this often (and on every link open). */
export const FLEET_CHECKOUT_RECONCILE_MS = 10 * 60_000;

/** A row left `creating` longer than this is swept to `missing` (spec §6 Reliability). */
export const FLEET_CHECKOUT_CREATING_STALE_MS = 10 * 60_000;

/** Checkout writes (create, sync, archive, restore, delete, scan) per user per minute (CONTRACTS §10.1). */
export const FLEET_CHECKOUT_WRITES_PER_MINUTE = 30;

/** Longest absolute path a checkout may have. */
export const FLEET_CHECKOUT_PATH_MAX_LENGTH = 1024;

/** Longest branch or ref name stored. */
export const FLEET_CHECKOUT_REF_MAX_LENGTH = 255;

/** Longest remote URL stored (token-free). */
export const FLEET_CHECKOUT_REMOTE_MAX_LENGTH = 2048;

/** Most code folders one node reports. */
export const FLEET_CHECKOUT_CODE_FOLDERS_MAX = 32;

/** The first line of git's stderr kept on a failed command. */
export const FLEET_CHECKOUT_STDERR_HEAD_MAX_LENGTH = 300;

/** Reconcile sweep schedule: minute 7 of every ten (plan §10, spelt as a range every cron parser reads). */
export const FLEET_CHECKOUT_RECONCILE_CRON = '7-59/10 * * * *';

// ─── Link verbs (CONTRACTS §3.3 `machine` family) ───────────────────────────

/**
 * The `machine` verbs this epic serves. `checkouts.changes` is FL-06's; it is
 * named here so the node and the platform agree on it.
 */
export const FLEET_CHECKOUT_LINK_VERBS = [
	'checkouts.list',
	'checkouts.create',
	'checkouts.sync',
	'checkouts.delete',
	'checkouts.changes'
] as const;

export type FleetCheckoutLinkVerb = (typeof FLEET_CHECKOUT_LINK_VERBS)[number];

export function isFleetCheckoutLinkVerb(value: unknown): value is FleetCheckoutLinkVerb {
	return typeof value === 'string' && (FLEET_CHECKOUT_LINK_VERBS as readonly string[]).includes(value);
}

// ─── Git line (CONTRACTS §4.7) ──────────────────────────────────────────────

export const FLEET_GIT_LINE_PR_STATES = ['open', 'draft', 'merged', 'closed'] as const;

export type FleetGitLinePullRequestState = (typeof FLEET_GIT_LINE_PR_STATES)[number];

export const FLEET_GIT_LINE_PR_CHECKS = ['pending', 'passing', 'failing'] as const;

export type FleetGitLinePullRequestChecks = (typeof FLEET_GIT_LINE_PR_CHECKS)[number];

/** The pull-request part of a git line — supplied by FL-06; null until then. */
export interface FleetGitLinePullRequest {
	number: number;
	state: FleetGitLinePullRequestState;
	checks: FleetGitLinePullRequestChecks | null;
	url: string;
}

/**
 * The git line (CONTRACTS §4.7): computed on the node WITHOUT contacting the
 * remote (spec FR-10) — ahead/behind are against the remote-tracking ref the
 * last fetch left, null when the branch tracks nothing.
 */
export interface FleetGitLine {
	branch: string | null;
	isWorktree: boolean;
	baseRef: string | null;
	ahead: number | null;
	behind: number | null;
	/** Lines added / removed in the working tree against HEAD (staged and unstaged). */
	added: number;
	removed: number;
	/** Tracked files with changes against HEAD. */
	filesChanged: number;
	/** Changed tracked files plus untracked files (what a pull would refuse on). */
	uncommitted: number;
	pr: FleetGitLinePullRequest | null;
	/** ISO time the snapshot was taken (node clock). */
	at: string;
}

const MAX_COUNT = 10_000_000;

function count(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null;
}

function boundedString(value: unknown, max: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > max || trimmed.includes('\0')) return null;
	return trimmed;
}

function isoTime(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 40) return null;
	return Number.isFinite(Date.parse(value)) ? value : null;
}

function parsePullRequest(value: unknown): FleetGitLinePullRequest | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const number = count(raw.number);
	const state = raw.state;
	const url = boundedString(raw.url, 2048);
	if (number === null || !url || !/^https:\/\//.test(url)) return null;
	if (typeof state !== 'string' || !(FLEET_GIT_LINE_PR_STATES as readonly string[]).includes(state)) return null;
	const checks =
		typeof raw.checks === 'string' && (FLEET_GIT_LINE_PR_CHECKS as readonly string[]).includes(raw.checks)
			? (raw.checks as FleetGitLinePullRequestChecks)
			: null;
	return { number, state: state as FleetGitLinePullRequestState, checks, url };
}

/** A git line from anywhere outside this process (the node, a stored column), or null. */
export function parseFleetGitLine(value: unknown): FleetGitLine | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const at = isoTime(raw.at);
	if (!at) return null;
	const added = count(raw.added);
	const removed = count(raw.removed);
	const filesChanged = count(raw.filesChanged);
	const uncommitted = count(raw.uncommitted);
	if (added === null || removed === null || filesChanged === null || uncommitted === null) return null;
	return {
		branch: boundedString(raw.branch, FLEET_CHECKOUT_REF_MAX_LENGTH),
		isWorktree: raw.isWorktree === true,
		baseRef: boundedString(raw.baseRef, FLEET_CHECKOUT_REF_MAX_LENGTH),
		ahead: count(raw.ahead),
		behind: count(raw.behind),
		added,
		removed,
		filesChanged,
		uncommitted,
		pr: parsePullRequest(raw.pr),
		at
	};
}

// ─── Remotes: token-free, host-aware (spec FR-5, FR-6, U12) ─────────────────

/** What {@link stripFleetRemoteCredential} answers. */
export interface FleetStrippedRemote {
	/** The remote with any embedded credential removed. */
	url: string;
	/** True when the remote carried a credential (userinfo with a secret, a query string) that was removed. */
	hadCredential: boolean;
}

/**
 * Remove any embedded credential from a remote URL (spec FR-5, U12): the
 * userinfo of an http(s) URL (`https://x:token@github.com/acme/api` →
 * `https://github.com/acme/api`), the password of an ssh URL (its user —
 * `git@` — is not a secret and stays), and any query string or fragment.
 * The scp-like form (`git@github.com:acme/api.git`) carries no secret and is
 * returned as it is. Null for something that is not a remote URL at all — a
 * caller then stores no remote.
 *
 * Run on the node BEFORE a remote leaves the machine, and again on the
 * platform before it is stored: the raw URL never reaches a row, a log or
 * an audit entry.
 */
export function stripFleetRemoteCredential(raw: unknown): FleetStrippedRemote | null {
	if (typeof raw !== 'string') return null;
	const value = raw.trim();
	if (value.length === 0 || value.length > FLEET_CHECKOUT_REMOTE_MAX_LENGTH * 2 || /[\0\r\n\s]/.test(value))
		return null;
	if (value.startsWith('-')) return null;
	// scp-like `user@host:path` — the user part is an ssh login name, never a secret.
	if (/^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9._-]*:(?![\\/])/.test(value) && !value.includes('://')) {
		return value.length <= FLEET_CHECKOUT_REMOTE_MAX_LENGTH ? { url: value, hadCredential: false } : null;
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	const protocol = parsed.protocol;
	if (protocol !== 'https:' && protocol !== 'http:' && protocol !== 'ssh:' && protocol !== 'git:') return null;
	if (!parsed.hostname || parsed.hostname.startsWith('-')) return null;
	let hadCredential = false;
	if (protocol === 'https:' || protocol === 'http:') {
		if (parsed.username || parsed.password) hadCredential = true;
		parsed.username = '';
		parsed.password = '';
	} else if (parsed.password) {
		hadCredential = true;
		parsed.password = '';
	}
	if (parsed.search) {
		hadCredential = true;
		parsed.search = '';
	}
	if (parsed.hash) {
		hadCredential = true;
		parsed.hash = '';
	}
	const url = parsed.toString();
	return url.length <= FLEET_CHECKOUT_REMOTE_MAX_LENGTH ? { url, hadCredential } : null;
}

/** A remote as `host` + `owner/repo` (spec FR-6: matching is host-aware). */
export interface FleetParsedRemote {
	/** Lower-case host name, without port. */
	host: string;
	owner: string;
	repo: string;
	/** `owner/repo`, lower-cased for comparison. */
	fullName: string;
}

const NAME_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * `host` and `owner/repo` of a remote — https, ssh and scp-like forms, a
 * trailing `.git` dropped, compared case-insensitively. Null for anything
 * that does not name exactly an owner and a repository (a deeper path, a
 * local path, a URL with a credential still in it).
 */
export function parseFleetRemote(raw: unknown): FleetParsedRemote | null {
	if (typeof raw !== 'string') return null;
	const value = raw.trim();
	if (value.length === 0 || value.length > FLEET_CHECKOUT_REMOTE_MAX_LENGTH) return null;
	let host: string;
	let path: string;
	const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9][A-Za-z0-9._-]*):(?![\\/])(.+)$/.exec(value);
	if (scp && !value.includes('://')) {
		host = scp[1];
		path = scp[2];
	} else {
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			return null;
		}
		if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
		// A remote still carrying a credential is never matched: strip it first.
		if (parsed.password || ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.username))
			return null;
		host = parsed.hostname;
		try {
			path = decodeURIComponent(parsed.pathname);
		} catch {
			return null;
		}
	}
	const segments = path
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.split('/')
		.filter((segment) => segment.length > 0);
	if (segments.length !== 2) return null;
	const owner = segments[0];
	const repo = segments[1].endsWith('.git') ? segments[1].slice(0, -4) : segments[1];
	if (!NAME_SEGMENT.test(owner) || !NAME_SEGMENT.test(repo) || repo === '.' || repo === '..') return null;
	const normalizedHost = host.toLowerCase();
	if (!/^[a-z0-9][a-z0-9.-]*$/.test(normalizedHost)) return null;
	return { host: normalizedHost, owner, repo, fullName: `${owner}/${repo}`.toLowerCase() };
}

/** True when two remotes name the same repository on the same host. */
export function fleetRemotesMatch(left: unknown, right: unknown): boolean {
	const a = parseFleetRemote(left);
	const b = parseFleetRemote(right);
	return a !== null && b !== null && a.host === b.host && a.fullName === b.fullName;
}

// ─── What the node reports (`checkouts.list` reply) ─────────────────────────

/** Why the node would refuse to change a checkout right now (spec U9, U10). */
export const FLEET_NODE_CHECKOUT_BUSY_REASONS = ['session', 'lease', 'reaper', 'operation'] as const;

export type FleetNodeCheckoutBusyReason = (typeof FLEET_NODE_CHECKOUT_BUSY_REASONS)[number];

/** One checkout as the node knows it. */
export interface FleetNodeCheckoutRecord {
	/** Absolute, canonical path on the node — the node's key. */
	path: string;
	/** The platform's id, when the platform made it and told the node; else null. */
	checkoutId: string | null;
	kind: FleetCheckoutKind;
	origin: FleetNodeCheckoutOrigin;
	/** The checkout this one is a worktree of (by path), when known. */
	parentPath: string | null;
	/** Token-free (`stripFleetRemoteCredential` already ran on the node). */
	remoteUrl: string | null;
	remoteHadCredential: boolean;
	branch: string | null;
	baseRef: string | null;
	headSha: string | null;
	isolation: FleetCheckoutIsolation;
	/** The folder exists and is still a git checkout. */
	present: boolean;
	gitLine: FleetGitLine | null;
	sizeBytes: number | null;
	/** Something holds it right now; mutating requests are refused `busy`. */
	busy: FleetNodeCheckoutBusyReason | null;
	/** For a Task worktree: what the node's reaper would do with it ("would be tidied in 3 days"). */
	reaperNote: string | null;
	/** Last use the node can prove (a Task worktree's usage stamp), ISO. */
	lastUsedAt: string | null;
}

/** `checkouts.list` params. Absent flags are false. */
export interface FleetCheckoutsListParams {
	/** Run discovery over the code folders and re-import the Task worktrees (needs `--manage` for discovery). */
	rescan?: boolean;
	/** Recompute git lines (for `paths` when given, else every checkout). Never contacts the remote. */
	refresh?: boolean;
	/** Only these checkouts (by path). Absent: every checkout the node holds (`complete: true`). */
	paths?: string[];
	/** FL-06's additive flag: also answer the remote's branch names (`git ls-remote --heads`) for `paths[0]`. */
	remoteHeads?: boolean;
	/** Measure sizes on disk (slow on big trees). Default: on a rescan only. */
	measureSize?: boolean;
}

/** `checkouts.list` reply. */
export interface FleetCheckoutsListReply {
	checkouts: FleetNodeCheckoutRecord[];
	/** True when `checkouts` is every checkout the node holds (no `paths` filter). */
	complete: boolean;
	/** Discovery stopped at {@link FLEET_CHECKOUTS_DISCOVERY_CAP} (or its time budget). */
	truncated: boolean;
	/** The code folders this machine scans (`--code-folder`), as the node resolved them. */
	codeFolders: string[];
	/** When discovery last ran on the node, ISO; null when it never did. */
	scannedAt: string | null;
	/** Where checkouts Ever Works creates go on this node (P2), or null. */
	checkoutsRoot: string | null;
	/** Present only when the request asked `remoteHeads`. */
	remoteBranches?: string[];
}

/** `checkouts.sync` params (P1: `fetch`; P2: `pull`, `push`). */
export interface FleetCheckoutsSyncParams {
	path: string;
	op: FleetCheckoutSyncOp;
	/** The platform's id, echoed back so a finished operation finds its row. */
	checkoutId?: string;
}

/** `checkouts.sync` result (inline, or the operation's `result`). */
export interface FleetCheckoutsSyncResult {
	path: string;
	checkoutId: string | null;
	op: FleetCheckoutSyncOp;
	exitCode: number;
	/** First line of git's stderr on failure (never a credential — the node redacts). */
	stderrHead: string | null;
	/** The checkout after the operation (its git line refreshed). */
	checkout: FleetNodeCheckoutRecord | null;
}

function stringList(value: unknown, max: number, itemMax: number): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const text = boundedString(item, itemMax);
		if (text && !out.includes(text)) out.push(text);
		if (out.length >= max) break;
	}
	return out;
}

function isCheckoutId(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

/** A path the node reported: absolute (POSIX `/…`, Windows `C:\…` or UNC `\\…`), bounded, no NUL. */
export function isFleetCheckoutPath(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	if (value.length === 0 || value.length > FLEET_CHECKOUT_PATH_MAX_LENGTH || value.includes('\0')) return false;
	return /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/.test(value);
}

/** One node-reported checkout, or null when it is not one this platform understands. */
export function parseFleetNodeCheckoutRecord(value: unknown): FleetNodeCheckoutRecord | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (!isFleetCheckoutPath(raw.path)) return null;
	if (!isFleetCheckoutKind(raw.kind) || !isFleetNodeCheckoutOrigin(raw.origin)) return null;
	// Belt and braces: the node stripped it, the platform strips again.
	const remote =
		raw.remoteUrl === null || raw.remoteUrl === undefined ? null : stripFleetRemoteCredential(raw.remoteUrl);
	const checkoutId = isCheckoutId(raw.checkoutId) ? raw.checkoutId : null;
	const busy =
		typeof raw.busy === 'string' && (FLEET_NODE_CHECKOUT_BUSY_REASONS as readonly string[]).includes(raw.busy)
			? (raw.busy as FleetNodeCheckoutBusyReason)
			: null;
	const sizeBytes =
		typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes) && raw.sizeBytes >= 0
			? Math.floor(raw.sizeBytes)
			: null;
	const headSha = typeof raw.headSha === 'string' && /^[0-9a-f]{7,64}$/i.test(raw.headSha) ? raw.headSha : null;
	return {
		path: raw.path,
		checkoutId,
		kind: raw.kind,
		origin: raw.origin,
		parentPath: isFleetCheckoutPath(raw.parentPath) ? raw.parentPath : null,
		remoteUrl: remote?.url ?? null,
		remoteHadCredential: raw.remoteHadCredential === true || remote?.hadCredential === true,
		branch: boundedString(raw.branch, FLEET_CHECKOUT_REF_MAX_LENGTH),
		baseRef: boundedString(raw.baseRef, FLEET_CHECKOUT_REF_MAX_LENGTH),
		headSha,
		isolation: isFleetCheckoutIsolation(raw.isolation) ? raw.isolation : 'host',
		present: raw.present === true,
		gitLine: parseFleetGitLine(raw.gitLine),
		sizeBytes,
		busy,
		reaperNote: boundedString(raw.reaperNote, 200),
		lastUsedAt: isoTime(raw.lastUsedAt)
	};
}

/** A whole `checkouts.list` reply, or null. Records it cannot read are dropped, never guessed. */
export function parseFleetCheckoutsListReply(value: unknown): FleetCheckoutsListReply | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.checkouts)) return null;
	const checkouts: FleetNodeCheckoutRecord[] = [];
	const seen = new Set<string>();
	for (const entry of raw.checkouts) {
		const record = parseFleetNodeCheckoutRecord(entry);
		if (!record || seen.has(record.path)) continue;
		seen.add(record.path);
		checkouts.push(record);
		// The node caps discovery; a reply far past the cap is not one this platform trusts whole.
		if (checkouts.length >= FLEET_CHECKOUTS_DISCOVERY_CAP * 4) break;
	}
	const codeFolders = stringList(raw.codeFolders, FLEET_CHECKOUT_CODE_FOLDERS_MAX, FLEET_CHECKOUT_PATH_MAX_LENGTH);
	const reply: FleetCheckoutsListReply = {
		checkouts,
		complete: raw.complete === true,
		truncated: raw.truncated === true,
		codeFolders: codeFolders.filter((folder) => isFleetCheckoutPath(folder)),
		scannedAt: isoTime(raw.scannedAt),
		checkoutsRoot: isFleetCheckoutPath(raw.checkoutsRoot) ? raw.checkoutsRoot : null
	};
	if (Array.isArray(raw.remoteBranches)) {
		reply.remoteBranches = stringList(raw.remoteBranches, 5000, FLEET_CHECKOUT_REF_MAX_LENGTH);
	}
	return reply;
}

/** A `checkouts.sync` result, or null. */
export function parseFleetCheckoutsSyncResult(value: unknown): FleetCheckoutsSyncResult | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (!isFleetCheckoutPath(raw.path) || !isFleetCheckoutSyncOp(raw.op)) return null;
	if (typeof raw.exitCode !== 'number' || !Number.isInteger(raw.exitCode)) return null;
	return {
		path: raw.path,
		checkoutId: isCheckoutId(raw.checkoutId) ? raw.checkoutId : null,
		op: raw.op,
		exitCode: raw.exitCode,
		stderrHead: boundedString(raw.stderrHead, FLEET_CHECKOUT_STDERR_HEAD_MAX_LENGTH),
		checkout: parseFleetNodeCheckoutRecord(raw.checkout)
	};
}

// ─── The platform's view (REST, tools, CLI `--json`) ────────────────────────

/** The last command run on a checkout (`lastCommand`, CONTRACTS §4.3). */
export interface FleetCheckoutLastCommand {
	/** `fetch` · `pull` · `push` · `clone` · `worktree` · `delete` · `forget` · `refresh`. */
	command: string;
	/** Null while it runs; `-1` when it never reported (swept). */
	exitCode: number | null;
	at: string;
	/** The first line of the error, when it failed. */
	stderrHead?: string | null;
	/** The link operation carrying it, while it runs. */
	operationId?: string | null;
}

/** One checkout as every surface reads it. */
export interface FleetCheckoutView {
	id: string;
	nodeId: string;
	/** The Node's owner. */
	userId: string;
	path: string;
	kind: FleetCheckoutKind;
	parentCheckoutId: string | null;
	remoteUrl: string | null;
	remoteHadCredential: boolean;
	/** `owner/repo` of the remote when it parses (the hub groups by it), else null. */
	repository: string | null;
	/** The remote's host, when it parses. */
	repositoryHost: string | null;
	workId: string | null;
	/** The linked Work's name, when the viewer may see it. */
	workName: string | null;
	branch: string | null;
	baseRef: string | null;
	isolation: FleetCheckoutIsolation;
	state: FleetCheckoutState;
	createdBy: FleetCheckoutCreatedBy;
	gitLine: FleetGitLine | null;
	lastCommand: FleetCheckoutLastCommand | null;
	sizeBytes: number | null;
	lastSeenAt: string | null;
	archivedAt: string | null;
	/** True once a delete removed the folder (the bin's "folder removed"); Restore is not offered. */
	folderRemoved: boolean;
	/** What the node's reaper would do with it (Task worktrees), from the last list. */
	reaperNote: string | null;
	/** Something held it at the last list (`busy`); mutating requests may be refused. */
	busy: FleetNodeCheckoutBusyReason | null;
	createdAt: string;
	updatedAt: string;
}

/** What one Node said about its checkouts at its last list (the Code folders card). */
export interface FleetNodeCheckoutsMeta {
	nodeId: string;
	codeFolders: string[] | null;
	scannedAt: string | null;
	truncated: boolean;
	checkoutsRoot: string | null;
	/** When the platform last heard a list from this node (this API process), ISO; null when unknown. */
	listedAt: string | null;
	/** Sum of the node's checkouts' `sizeBytes` (spec FR-14). */
	totalSizeBytes: number;
	/** Rows on this node, not in the bin. */
	count: number;
}

/** `GET /api/fleet/checkouts`. */
export interface FleetCheckoutListResponse {
	data: FleetCheckoutView[];
	meta: { nextCursor: string | null; bin: number };
}

/** `GET /api/fleet/nodes/:id/checkouts`. */
export interface FleetNodeCheckoutsResponse {
	data: FleetCheckoutView[];
	meta: { nextCursor: string | null; bin: number };
	node: FleetNodeCheckoutsMeta;
	/** Present when a rescan or a refresh is still running on the machine. */
	operationId?: string;
	/**
	 * Why the list is last-known rather than fresh: the computer is offline
	 * (`unreachable`), lacks the consent (`consent_missing`), or the kill switch
	 * is on (`kill_switch`). Absent when the node answered.
	 */
	stale?: { code: string; hint: string };
}

/** `POST /api/fleet/checkouts/:id/sync`. */
export interface FleetCheckoutSyncRequest {
	op: FleetCheckoutSyncOp;
	/** CONTRACTS §2.2 class `confirm` for pull and push. */
	confirm?: boolean;
}

/** `202` answer of sync (and of a slow refresh). */
export interface FleetCheckoutOperationResponse {
	checkout: FleetCheckoutView;
	/** The link operation, when the machine is still working on it. Null when it finished inline. */
	operationId: string | null;
}

/** `POST /api/fleet/checkouts/:id/archive` (class `confirm`). */
export interface FleetCheckoutArchiveRequest {
	confirm?: boolean;
}

/** Display: `~/code/api` for a path under the home folder, else the path itself. */
export function fleetCheckoutDisplayPath(path: string, homeHint?: string | null): string {
	if (homeHint && path.startsWith(homeHint)) {
		const rest = path.slice(homeHint.length);
		if (rest === '') return '~';
		if (rest.startsWith('/') || rest.startsWith('\\')) return `~${rest}`;
	}
	return path;
}

/** The checkout's own folder name (what `confirm-destructive` asks to type). */
export function fleetCheckoutName(path: string): string {
	let end = path.length;
	while (end > 0 && (path.charAt(end - 1) === '/' || path.charAt(end - 1) === '\\')) end -= 1;
	let start = end;
	while (start > 0 && path.charAt(start - 1) !== '/' && path.charAt(start - 1) !== '\\') start -= 1;
	return path.slice(start, end) || path;
}

// ─── P2: create, delete, the operation-scoped credential ────────────────────

/** `delete` removes the folder (a worktree keeps its branch); `forget` drops the row only (spec FR-25). */
export const FLEET_CHECKOUT_DELETE_MODES = ['delete', 'forget'] as const;

export type FleetCheckoutDeleteMode = (typeof FLEET_CHECKOUT_DELETE_MODES)[number];

export function isFleetCheckoutDeleteMode(value: unknown): value is FleetCheckoutDeleteMode {
	return typeof value === 'string' && (FLEET_CHECKOUT_DELETE_MODES as readonly string[]).includes(value);
}

/** What deleting would lose, computed on the node (spec FR-24) — twice: for the preview and again on execute. */
export interface FleetCheckoutChangesEvidence {
	/** Changed tracked files plus untracked files. */
	uncommitted: number;
	/** Commits on HEAD that no remote-tracking ref reaches. */
	unpushedCommits: number;
	/** A git lock file is present (another git command is running). */
	hasLocks: boolean;
}

/** Where a new checkout comes from (spec FR-16). Container isolation is P3. */
export type FleetCheckoutCreateSource =
	| { kind: 'clone'; repoUrl: string }
	| { kind: 'worktree'; parentCheckoutId: string };

/** `POST /api/fleet/checkouts`. */
export interface FleetCheckoutCreateRequest {
	nodeId: string;
	source: FleetCheckoutCreateSource;
	/** The branch to check out (a worktree's new branch); proposed by the branch rule when absent (FR-18, FR-19). */
	branch?: string;
	/** What a new branch starts from; the parent's branch (worktree) or the remote default (clone) when absent. */
	baseRef?: string;
	isolation?: FleetCheckoutIsolation;
}

/** `202` answer of create. */
export interface FleetCheckoutCreateResponse {
	checkout: FleetCheckoutView;
	operationId: string | null;
}

/** `DELETE /api/fleet/checkouts/:id` body (CONTRACTS §2.2: `confirm` or `confirmName`). */
export interface FleetCheckoutDeleteRequest {
	mode?: FleetCheckoutDeleteMode;
	confirm?: boolean;
	confirmName?: string;
}

/** `checkouts.create` params — the platform names the exact target path under the node's checkouts root. */
export interface FleetCheckoutsCreateParams {
	checkoutId: string;
	path: string;
	source: { kind: 'clone'; repoUrl: string } | { kind: 'worktree'; parentPath: string };
	branch: string;
	baseRef: string | null;
	/** `task` for a checkout a Task run asked for (`--work` suffices); else a person or an Agent (`--manage`). */
	createdBy: FleetCheckoutCreatedBy;
}

/** `checkouts.create` result. */
export interface FleetCheckoutsCreateResult {
	checkoutId: string;
	path: string;
	exitCode: number;
	stderrHead: string | null;
	checkout: FleetNodeCheckoutRecord | null;
}

/** `checkouts.delete` params: `preview` computes the evidence and changes nothing. */
export interface FleetCheckoutsDeleteParams {
	path: string;
	mode: FleetCheckoutDeleteMode | 'preview';
	/** The counts the person confirmed; the node refuses when the evidence grew since (plan §6). */
	expected?: Pick<FleetCheckoutChangesEvidence, 'uncommitted' | 'unpushedCommits'>;
	checkoutId?: string;
}

/** `checkouts.delete` result. */
export interface FleetCheckoutsDeleteResult {
	path: string;
	mode: FleetCheckoutDeleteMode | 'preview';
	evidence: FleetCheckoutChangesEvidence;
	/** The folder is gone (delete); false for preview and forget. */
	removed: boolean;
	/** The branch a removed worktree kept. */
	branchKept: string | null;
}

/** Access an operation-scoped git credential grants: `read` for clone/fetch/pull, `write` for push. */
export const FLEET_CHECKOUT_CREDENTIAL_ACCESS = ['read', 'write'] as const;

export type FleetCheckoutCredentialAccess = (typeof FLEET_CHECKOUT_CREDENTIAL_ACCESS)[number];

export function isFleetCheckoutCredentialAccess(value: unknown): value is FleetCheckoutCredentialAccess {
	return typeof value === 'string' && (FLEET_CHECKOUT_CREDENTIAL_ACCESS as readonly string[]).includes(value);
}

/**
 * The answer to the node's `POST /api/fleet/checkouts/:id/credential` (spec
 * FR-17): a GitHub App installation token narrowed to ONE repository, minted
 * for one operation, injected into one git child's environment and revoked
 * when the operation ends. Never stored on the machine, the row or a log.
 */
export interface FleetCheckoutCredentialResponse {
	token: string;
	username: string;
	expiresAt: string;
	/** `owner/repo` — the node verifies its remote names exactly this before use. */
	repository: string;
	access: FleetCheckoutCredentialAccess;
}

const BRANCH_FORBIDDEN = /[\u0000- \u007f~^:?*[\\]/;

/**
 * A branch name this program will hand to git: bounded, no option-looking
 * leading `-`, none of the characters git refuses in a ref, no `..`, no
 * `@{`, no trailing `/` or `.lock`.
 */
export function isFleetCheckoutBranchName(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	if (value.length === 0 || value.length > FLEET_CHECKOUT_REF_MAX_LENGTH) return false;
	if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
	if (value.endsWith('.lock') || value.includes('..') || value.includes('@{') || value.includes('//')) return false;
	return !BRANCH_FORBIDDEN.test(value);
}

/**
 * The branch rule (spec FR-19): a proposed name already on the remote or on
 * any checkout row for that remote (the bin included) gets `-2`, `-3`, …
 */
export function proposeFleetCheckoutBranch(base: string, taken: Iterable<string>): string {
	const used = new Set<string>();
	for (const name of taken) used.add(name);
	if (!used.has(base)) return base;
	for (let suffix = 2; suffix < 10_000; suffix += 1) {
		const candidate = `${base}-${suffix}`;
		if (!used.has(candidate)) return candidate;
	}
	return `${base}-${Date.now()}`;
}

/** A folder name for a new checkout, from its branch: `nina/fix-login` → `fix-login`. */
export function fleetCheckoutFolderName(branch: string): string {
	const last = branch.split('/').filter((part) => part.length > 0).pop() ?? branch;
	const slug = last
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^[-.]+/, '')
		.replace(/[-.]+$/, '')
		.slice(0, 80);
	return slug || 'checkout';
}

/** Evidence from the node, or null. */
export function parseFleetCheckoutChangesEvidence(value: unknown): FleetCheckoutChangesEvidence | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const uncommitted = count(raw.uncommitted);
	const unpushedCommits = count(raw.unpushedCommits);
	if (uncommitted === null || unpushedCommits === null) return null;
	return { uncommitted, unpushedCommits, hasLocks: raw.hasLocks === true };
}

/** A `checkouts.create` result, or null. */
export function parseFleetCheckoutsCreateResult(value: unknown): FleetCheckoutsCreateResult | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (!isCheckoutId(raw.checkoutId) || !isFleetCheckoutPath(raw.path)) return null;
	if (typeof raw.exitCode !== 'number' || !Number.isInteger(raw.exitCode)) return null;
	return {
		checkoutId: raw.checkoutId,
		path: raw.path,
		exitCode: raw.exitCode,
		stderrHead: boundedString(raw.stderrHead, FLEET_CHECKOUT_STDERR_HEAD_MAX_LENGTH),
		checkout: parseFleetNodeCheckoutRecord(raw.checkout)
	};
}

/** A `checkouts.delete` result, or null. */
export function parseFleetCheckoutsDeleteResult(value: unknown): FleetCheckoutsDeleteResult | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (!isFleetCheckoutPath(raw.path)) return null;
	const mode = raw.mode;
	if (mode !== 'preview' && !isFleetCheckoutDeleteMode(mode)) return null;
	const evidence = parseFleetCheckoutChangesEvidence(raw.evidence);
	if (!evidence) return null;
	return {
		path: raw.path,
		mode,
		evidence,
		removed: raw.removed === true,
		branchKept: boundedString(raw.branchKept, FLEET_CHECKOUT_REF_MAX_LENGTH)
	};
}
