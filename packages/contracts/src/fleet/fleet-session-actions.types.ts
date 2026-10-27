/**
 * Fleet — Session git & actions (FL-06, CONTRACTS §4.7, §4.8, §10, §11.2, R-22, R-38).
 *
 * A session on a computer usually lives in a Checkout (FL-14). This file names
 * what every surface reads about that relationship — the session's git ref
 * (the checkout's git line, with the platform-resolved pull request), the
 * branch rule for a new session's worktree (`<prefix>/<slug>`, never reused),
 * the read-only Changes view, the seven action prompts with their relevance
 * rules, the ledger of actions sent and the platform-side pull request — and
 * the pure rules the dialog, the menu and the server share, so they can never
 * disagree on why an action is hidden.
 *
 * Nothing here is stored in a new column (CONTRACTS §13 has no FL-06 slot):
 * templates live in the platform defaults below and the Agent's own
 * `agent.yml` (`fleet.actions.<id>`), the pull request in the checkout's
 * `gitLine.pr`, an Agent session's ledger in its Run's log rows and an owner
 * session's in its `fleet_audit` rows (R-38).
 *
 * Every union carries a `readonly` list and an `isX` guard (the house
 * pattern); every helper is pure and never throws.
 */

import {
	FLEET_CHECKOUT_REF_MAX_LENGTH,
	isFleetCheckoutBranchName,
	isFleetCheckoutPath,
	proposeFleetCheckoutBranch,
	type FleetCheckoutCreatedBy,
	type FleetCheckoutIsolation,
	type FleetCheckoutKind,
	type FleetCheckoutState,
	type FleetGitLine,
	type FleetGitLinePullRequest
} from './fleet-checkout.types.js';
import type { FleetSessionKind, FleetSessionProvider, FleetSessionState } from './fleet-sessions.types.js';

// ─── The session's git ref (spec FR-1, FR-6) ────────────────────────────────

/**
 * The checkout a session works in, as every session surface reads it (the
 * card's `gitLine` / `prPill` / `cleanUp` slots, the detail header). Absent on
 * a session view when the session records no checkout (spec S9: "Not in a
 * checkout"), and on a platform that predates FL-06.
 */
export interface FleetSessionGitRef {
	checkoutId: string;
	/** Absolute path on the computer. */
	path: string;
	kind: FleetCheckoutKind;
	state: FleetCheckoutState;
	isolation: FleetCheckoutIsolation;
	createdBy: FleetCheckoutCreatedBy;
	/** `owner/repo` of the remote when it parses, else null. */
	repository: string | null;
	/** The row's last-known branch (the git line's when there is one). */
	branch: string | null;
	/** The checkout's git line (CONTRACTS §4.7), its `pr` resolved by the platform. */
	gitLine: FleetGitLine | null;
}

// ─── The branch rule for a session's worktree (spec FR-3 … FR-5, U9) ────────

/** Longest slug the branch rule makes (spec T-03: ≤ 40 characters, kebab-case). */
export const FLEET_SESSION_BRANCH_SLUG_MAX_LENGTH = 40;

/** Longest prefix (an Agent's slug or a person's handle). */
export const FLEET_SESSION_BRANCH_PREFIX_MAX_LENGTH = 30;

/** Where the proposed branch's slug came from. */
export const FLEET_SESSION_BRANCH_SOURCES = ['task', 'message', 'title', 'generated'] as const;

export type FleetSessionBranchSource = (typeof FLEET_SESSION_BRANCH_SOURCES)[number];

export function isFleetSessionBranchSource(value: unknown): value is FleetSessionBranchSource {
	return typeof value === 'string' && (FLEET_SESSION_BRANCH_SOURCES as readonly string[]).includes(value);
}

/**
 * A kebab-case slug of free text: diacritics folded, everything that is not
 * `[a-z0-9]` becomes one `-`, the first words kept up to `max` characters
 * (cut at a word boundary when one exists). Empty when nothing usable is left.
 */
export function fleetSessionBranchSlug(text: unknown, max: number = FLEET_SESSION_BRANCH_SLUG_MAX_LENGTH): string {
	if (typeof text !== 'string') return '';
	const folded = text.slice(0, 2000).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
	const words = folded.split(/[^a-z0-9]+/).filter((word) => word.length > 0);
	let out = '';
	for (const word of words) {
		const next = out ? `${out}-${word}` : word;
		if (next.length > max) {
			if (!out) out = word.slice(0, max);
			break;
		}
		out = next;
	}
	return out.replace(/^-+/, '').replace(/-+$/, '');
}

/** The prefix of a proposed branch: the Agent's slug (Agent sessions) or the person's handle (owner sessions). */
export function fleetSessionBranchPrefix(name: unknown): string {
	return fleetSessionBranchSlug(name, FLEET_SESSION_BRANCH_PREFIX_MAX_LENGTH) || 'session';
}

/** A short generated slug when there is no Task, message or title: `session-k3x9`. */
export function fleetSessionGeneratedSlug(random: () => number = Math.random): string {
	const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
	let out = '';
	for (let index = 0; index < 4; index += 1) {
		const pick = Math.floor(Math.abs(random()) * alphabet.length) % alphabet.length;
		out += alphabet.charAt(pick);
	}
	return `session-${out}`;
}

export interface FleetSessionBranchProposalInput {
	/** The prefix ({@link fleetSessionBranchPrefix}). */
	prefix: string;
	/** A session started from a Task keeps the Task's branch (spec FR-4) — never suffixed. */
	taskBranch?: string | null;
	firstMessage?: string | null;
	title?: string | null;
	/** Names already used for this repository: on the remote, and by any checkout row, the bin included (FR-5). */
	taken: Iterable<string>;
	/** For specs: the generated name's randomness. */
	random?: () => number;
}

/** `GET /api/fleet/sessions/branch-proposal` and what the pure rule answers. */
export interface FleetSessionBranchProposal {
	/** The branch to create (or, for a Task, to use). */
	branch: string;
	/** What the rule proposed before the collision suffix. */
	base: string;
	/** True when `base` was taken and a `-2`, `-3`, … was added (spec U9). */
	suffixed: boolean;
	source: FleetSessionBranchSource;
	/**
	 * Why, in one sentence the dialog shows: "never used before on acme/api",
	 * "nina/fix-login exists — using nina/fix-login-2", "the Task's branch".
	 * Filled by the server (it knows the repository); empty from the pure rule.
	 */
	reason: string;
	/** `owner/repo` the uniqueness was checked against, when known. */
	repository?: string | null;
	/** False when the remote's branch names could not be read (the rows were still checked). */
	remoteChecked?: boolean;
}

/**
 * The branch rule (spec FR-3 … FR-5): the Task's branch when the session is
 * started from a Task; else `<prefix>/<slug>` with the slug from the first
 * message, else the title, else a short generated name — then a numeric
 * suffix when that name was ever used for the repository.
 */
export function proposeFleetSessionBranch(input: FleetSessionBranchProposalInput): FleetSessionBranchProposal {
	const taskBranch = typeof input.taskBranch === 'string' ? input.taskBranch.trim() : '';
	if (taskBranch && isFleetCheckoutBranchName(taskBranch)) {
		return { branch: taskBranch, base: taskBranch, suffixed: false, source: 'task', reason: '' };
	}
	const prefix = fleetSessionBranchPrefix(input.prefix);
	let source: FleetSessionBranchSource = 'generated';
	let slug = fleetSessionBranchSlug(input.firstMessage);
	if (slug) source = 'message';
	else {
		slug = fleetSessionBranchSlug(input.title);
		if (slug) source = 'title';
	}
	if (!slug) slug = fleetSessionGeneratedSlug(input.random);
	let base = `${prefix}/${slug}`.slice(0, FLEET_CHECKOUT_REF_MAX_LENGTH - 8);
	if (!isFleetCheckoutBranchName(base)) base = `${prefix}/${fleetSessionGeneratedSlug(input.random)}`;
	const branch = proposeFleetCheckoutBranch(base, input.taken);
	return { branch, base, suffixed: branch !== base, source, reason: '' };
}

// ─── The Changes view (spec FR-9, FR-10, U15; CONTRACTS §10) ────────────────

/** The whole diff shown at most (CONTRACTS §10 "Changes diff shown"). */
export const FLEET_CHANGES_MAX_BYTES = 1_048_576;

/** One file's patch shown at most. */
export const FLEET_CHANGES_MAX_FILE_BYTES = 65_536;

/** Most files one Changes reply lists (the rest are counted as omitted). */
export const FLEET_CHANGES_MAX_FILES = 500;

/** The Changes view refreshes this often while the session works (spec FR-10). */
export const FLEET_CHANGES_REFRESH_MS = 10_000;

/** Folders the Changes view never reads (plan §6: the node's own state and mounts). */
export const FLEET_CHANGES_EXCLUDED_DIRS: readonly string[] = ['.ever-works', '.mounts'];

/** What happened to one changed file (porcelain v2). */
export const FLEET_CHANGED_FILE_STATUSES = [
	'modified',
	'added',
	'deleted',
	'renamed',
	'copied',
	'untracked',
	'conflicted',
	'type-changed'
] as const;

export type FleetChangedFileStatus = (typeof FLEET_CHANGED_FILE_STATUSES)[number];

export function isFleetChangedFileStatus(value: unknown): value is FleetChangedFileStatus {
	return typeof value === 'string' && (FLEET_CHANGED_FILE_STATUSES as readonly string[]).includes(value);
}

/** `checkouts.changes` params (CONTRACTS §3.3 `machine` vocabulary, rev 2). */
export interface FleetCheckoutChangesParams {
	/** The checkout's path on the node (the node's key, FL-14 decision 1). */
	path: string;
	/** Clamped on both sides to {@link FLEET_CHANGES_MAX_BYTES}. */
	maxBytes?: number;
	checkoutId?: string;
}

/** One changed file. The patch is plain text; no surface ever renders it as markup (FR-10). */
export interface FleetCheckoutChangedFile {
	/** Repository-relative path (forward slashes). */
	path: string;
	/** The old path of a rename or copy. */
	previousPath: string | null;
	status: FleetChangedFileStatus;
	/** Lines added / removed; null for a binary file. */
	added: number | null;
	removed: number | null;
	binary: boolean;
	/** The unified diff against HEAD (staged + unstaged), or null (binary, omitted, untracked too large). */
	patch: string | null;
	/** The patch was cut at {@link FLEET_CHANGES_MAX_FILE_BYTES}. */
	truncated: boolean;
}

/** `checkouts.changes` reply, and `GET /api/fleet/checkouts/:id/changes`. */
export interface FleetCheckoutChangesReply {
	path: string;
	files: FleetCheckoutChangedFile[];
	/** Something was left out (a file cut, files omitted, the total cap reached). */
	truncated: boolean;
	/** Files listed by status but without their patch (or not listed at all) because of a cap. */
	omittedFiles: number;
	/** Bytes of patch text not sent. */
	omittedBytes: number;
	/** Bytes of patch text sent. */
	totalBytes: number;
	/** When the node read it (ISO). */
	at: string;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** The `maxBytes` a Changes request may ask for: 4 KiB … 1 MiB, default 1 MiB. */
export function clampFleetChangesMaxBytes(value: unknown): number {
	return clampInt(value, 4096, FLEET_CHANGES_MAX_BYTES, FLEET_CHANGES_MAX_BYTES);
}

function count(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;
}

function relativePath(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	if (value.length === 0 || value.length > 4096 || value.includes('\0')) return null;
	if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
	return value;
}

/**
 * A Changes reply from the node, or null. Everything is re-bounded here: a
 * patch past the per-file cap is cut again, the running total past the cap
 * turns the rest into omissions — a node that ignored the caps cannot make
 * the platform hold or forward more than they allow.
 */
export function parseFleetCheckoutChangesReply(
	value: unknown,
	maxBytes: number = FLEET_CHANGES_MAX_BYTES
): FleetCheckoutChangesReply | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (!isFleetCheckoutPath(raw.path) || !Array.isArray(raw.files)) return null;
	const at = typeof raw.at === 'string' && Number.isFinite(Date.parse(raw.at)) ? raw.at : new Date(0).toISOString();
	const cap = clampFleetChangesMaxBytes(maxBytes);
	let omittedFiles = count(raw.omittedFiles) ?? 0;
	let omittedBytes = count(raw.omittedBytes) ?? 0;
	let totalBytes = 0;
	let truncated = raw.truncated === true;
	const files: FleetCheckoutChangedFile[] = [];
	for (const entry of raw.files) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
		const file = entry as Record<string, unknown>;
		const path = relativePath(file.path);
		if (!path || !isFleetChangedFileStatus(file.status)) continue;
		if (files.length >= FLEET_CHANGES_MAX_FILES) {
			omittedFiles += 1;
			truncated = true;
			continue;
		}
		const binary = file.binary === true;
		let patch = !binary && typeof file.patch === 'string' ? file.patch : null;
		let fileTruncated = file.truncated === true;
		if (patch !== null && patch.length > FLEET_CHANGES_MAX_FILE_BYTES) {
			omittedBytes += patch.length - FLEET_CHANGES_MAX_FILE_BYTES;
			patch = patch.slice(0, FLEET_CHANGES_MAX_FILE_BYTES);
			fileTruncated = true;
		}
		if (patch !== null && totalBytes + patch.length > cap) {
			omittedBytes += patch.length;
			omittedFiles += 1;
			patch = null;
			truncated = true;
		}
		if (patch !== null) totalBytes += patch.length;
		if (fileTruncated) truncated = true;
		files.push({
			path,
			previousPath: relativePath(file.previousPath),
			status: file.status,
			added: binary ? null : count(file.added),
			removed: binary ? null : count(file.removed),
			binary,
			patch: binary ? null : patch,
			truncated: fileTruncated
		});
	}
	if (omittedFiles > 0 || omittedBytes > 0) truncated = true;
	return { path: raw.path, files, truncated, omittedFiles, omittedBytes, totalBytes, at };
}

// ─── The pull request beside the git line (spec FR-7, FR-8, U12) ───────────

/** Pull-request enrichment asks the provider at most this often per checkout (spec FR-7, NFR). */
export const FLEET_PR_ENRICHMENT_MIN_INTERVAL_MS = 60_000;

/** A checkout's pull request is kept fresh while a session uses it, or for this long after it was last seen. */
export const FLEET_PR_ENRICHMENT_RECENT_MS = 7 * 24 * 60 * 60_000;

/** A git line older than this reads as stale (spec §5.1: age in amber). */
export const FLEET_GIT_LINE_STALE_MS = 5 * 60_000;

/**
 * What the platform knows about a checkout's pull request — the CONTRACTS
 * §4.7 `pr` part (stored on the git line) plus the facts the relevance rules
 * read, which are NOT stored (plan §4: kept in the enrichment cache, 60 s).
 * `GET /api/fleet/checkouts/:id/pull-request`.
 */
export interface FleetCheckoutPullRequestFacts {
	checkoutId: string;
	pr: FleetGitLinePullRequest | null;
	/** Review comments still open on the pull request; null when unknown. */
	unresolvedComments: number | null;
	/** The provider's mergeability verdict; null while it is computing or unknown. */
	mergeable: boolean | null;
	/** The branch the pull request merges into (`main`), or the repository's default branch without one. */
	baseRef: string | null;
	/** The repository's default branch, when the provider said. */
	defaultBranch: string | null;
	/** When the provider last answered (ISO); null when it never did. */
	checkedAt: string | null;
	/** When the provider started failing (ISO) — the pill reads "PR: unknown (GitHub unreachable 3 min)". */
	unknownSince: string | null;
}

/** `fresh` within five minutes of the node's snapshot, else `stale` (spec §5.1). */
export function fleetGitLineFreshness(line: Pick<FleetGitLine, 'at'> | null, now: number): 'fresh' | 'stale' | 'none' {
	if (!line) return 'none';
	const at = Date.parse(line.at);
	if (!Number.isFinite(at)) return 'stale';
	return now - at > FLEET_GIT_LINE_STALE_MS ? 'stale' : 'fresh';
}

/** `origin/main` → `main`; any other ref as it is. */
export function fleetBranchWithoutRemote(ref: string | null | undefined): string | null {
	if (typeof ref !== 'string') return null;
	const trimmed = ref.trim();
	if (!trimmed) return null;
	return trimmed.startsWith('origin/') ? trimmed.slice('origin/'.length) || null : trimmed;
}

/**
 * Is the session on the repository's default branch? The provider's default
 * branch when the enrichment read it; else the git line's own base when the
 * branch tracks itself (`main` tracking `origin/main`); else `main` / `master`.
 */
export function isFleetSessionOnDefaultBranch(input: {
	branch: string | null;
	baseRef: string | null;
	defaultBranch?: string | null;
}): boolean {
	const branch = input.branch;
	if (!branch) return false;
	if (input.defaultBranch) return branch === input.defaultBranch;
	const base = fleetBranchWithoutRemote(input.baseRef);
	if (base) return base === branch;
	return branch === 'main' || branch === 'master';
}

// ─── The seven actions (spec FR-12 … FR-16) ─────────────────────────────────

export const FLEET_SESSION_ACTION_IDS = [
	'commit',
	'commitPush',
	'pullRequest',
	'review',
	'fixComments',
	'resolveConflicts',
	'recap'
] as const;

export type FleetSessionActionId = (typeof FLEET_SESSION_ACTION_IDS)[number];

export function isFleetSessionActionId(value: unknown): value is FleetSessionActionId {
	return typeof value === 'string' && (FLEET_SESSION_ACTION_IDS as readonly string[]).includes(value);
}

/** The placeholders a template may carry; anything else in braces is left as it is. */
export const FLEET_SESSION_ACTION_PLACEHOLDERS = ['branch', 'base', 'pull', 'task'] as const;

export type FleetSessionActionPlaceholder = (typeof FLEET_SESSION_ACTION_PLACEHOLDERS)[number];

/**
 * The platform's default text for every action (spec §1, §5.3). An Agent's
 * own `agent.yml` may override any of them (`fleet.actions.<id>`, FR-13).
 * The commit templates say what to do when the sandbox refuses a write to the
 * repository (spec §8b, Codex worktrees).
 */
export const FLEET_SESSION_ACTION_DEFAULTS: Readonly<Record<FleetSessionActionId, string>> = {
	commit:
		'Commit the current changes on {branch} with a clear message that explains why. Do not push. ' +
		'Tell me the commit you made. If a write to the repository is refused, say so and ask me what to do.',
	commitPush:
		'Commit the current changes on {branch} with a clear message that explains why, then push {branch} ' +
		'to origin. Tell me the commit and whether the push succeeded. If a write to the repository is ' +
		'refused, say so and ask me what to do.',
	pullRequest:
		'Make sure every change on {branch} is committed and pushed to origin. Then ask Ever Works to open ' +
		'or update the pull request from {branch} into {base} ({pull}) with the ' +
		'fleet_checkouts_open_pull_request tool: a short title and a body that says what changed and why. ' +
		'Do not open it any other way, and never merge it.',
	review:
		'Review the changes on {branch} against {base} as a careful reviewer: correctness, security, tests ' +
		'and anything unclear. Give a verdict and a list of findings. Do not change any code, do not commit ' +
		'and do not push.',
	fixComments:
		'Pull request {pull} on {branch} has unresolved review comments. Address each one, reply on its ' +
		'thread saying what you changed (or why not), then commit and push {branch}. Do not merge the pull ' +
		'request.',
	resolveConflicts:
		'{branch} cannot be merged cleanly into {base}. Merge {base} into {branch}, resolve every conflict, ' +
		'run the tests, and push {branch} only when they pass. Tell me what you resolved.',
	recap:
		'Write a short recap of this session for someone who was not here: what you were asked ({task}), ' +
		'what you did, what is left, and anything you need from me.'
};

/** Longest template an Agent may store, and longest prompt a person may send. */
export const FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH = 4000;

/** The values the placeholders render to (spec FR-13). */
export interface FleetSessionActionRenderContext {
	branch: string | null;
	base: string | null;
	/** The open pull request's number, when there is one. */
	pullNumber: number | null;
	/** `T-42` and its title, when the session works on a Task. */
	task: { slug: string; title: string } | null;
}

/** How each placeholder reads in the rendered prompt. */
export function fleetSessionActionPlaceholderValues(
	context: FleetSessionActionRenderContext
): Readonly<Record<FleetSessionActionPlaceholder, string>> {
	return {
		branch: context.branch || 'the current branch',
		base: context.base || 'the default branch',
		pull: context.pullNumber !== null ? `#${context.pullNumber}` : 'none is open yet',
		task: context.task ? `Task ${context.task.slug}: ${context.task.title}`.slice(0, 300) : 'no Task'
	};
}

/**
 * Render a template (spec FR-13): `{branch}`, `{base}`, `{pull}` and `{task}`
 * are replaced; any other `{word}` is left verbatim (plan §3). No template
 * engine, no expressions — a template is text.
 */
export function renderFleetSessionActionPrompt(template: string, context: FleetSessionActionRenderContext): string {
	if (typeof template !== 'string') return '';
	const values = fleetSessionActionPlaceholderValues(context);
	return template.replace(/\{([a-zA-Z]+)\}/g, (match, name: string) =>
		(FLEET_SESSION_ACTION_PLACEHOLDERS as readonly string[]).includes(name)
			? values[name as FleetSessionActionPlaceholder]
			: match
	);
}

/** Placeholders in braces a template names that the renderer does not know (the editor warns, FR-27). */
export function unknownFleetSessionActionPlaceholders(template: string): string[] {
	if (typeof template !== 'string') return [];
	const out: string[] = [];
	for (const match of template.matchAll(/\{([a-zA-Z]+)\}/g)) {
		const name = match[1];
		if (!(FLEET_SESSION_ACTION_PLACEHOLDERS as readonly string[]).includes(name) && !out.includes(name))
			out.push(name);
	}
	return out;
}

/**
 * The bytes typed into the session for a prompt (spec FR-14): newlines folded
 * into spaces (a terminal agent reads a bare Enter as "send"), control
 * characters dropped, then one Enter — exactly what a person typing it would
 * send. Never more than the template cap.
 */
export function fleetSessionActionInputBytes(prompt: string): string {
	const flat = String(prompt)
		.replace(/\r?\n+/g, ' ')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
		.replace(/ {2,}/g, ' ')
		.trim()
		.slice(0, FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH);
	return `${flat}\r`;
}

// ─── Relevance rules (spec FR-15, U5 … U8) ──────────────────────────────────

/** Why an action is not offered (the menu's note, the server's `invalid` hint names it). */
export const FLEET_SESSION_ACTION_HIDDEN_REASONS = [
	'shell-session',
	'ended',
	'not-in-checkout',
	'no-branch',
	'default-branch',
	'protected-branch',
	'no-open-pull-request',
	'no-unresolved-comments',
	'mergeable'
] as const;

export type FleetSessionActionHiddenReason = (typeof FLEET_SESSION_ACTION_HIDDEN_REASONS)[number];

export function isFleetSessionActionHiddenReason(value: unknown): value is FleetSessionActionHiddenReason {
	return typeof value === 'string' && (FLEET_SESSION_ACTION_HIDDEN_REASONS as readonly string[]).includes(value);
}

/** What the relevance rules read — one truth table for the menu and the server (plan §3). */
export interface FleetSessionActionContext {
	kind: FleetSessionKind;
	provider: FleetSessionProvider;
	state: FleetSessionState;
	hasCheckout: boolean;
	branch: string | null;
	baseRef: string | null;
	defaultBranch: string | null;
	/** The merge policy's protected branches (CONTRACTS merge-policy `protectedBranches`). */
	protectedBranches: readonly string[];
	pr: Pick<FleetGitLinePullRequest, 'number' | 'state'> | null;
	unresolvedComments: number | null;
	mergeable: boolean | null;
}

export interface FleetSessionActionAvailability {
	id: FleetSessionActionId;
	available: boolean;
	reason?: FleetSessionActionHiddenReason;
	/** `pullRequest` reads "Update the pull request #n" when one is open (FR-16). */
	update?: { number: number };
	/** An owner session's Commit and push on a protected branch: "This pushes straight to main" (U6). */
	warning?: 'pushes-protected';
	/** How many review comments are open (Fix the review comments, S6). */
	unresolvedComments?: number;
	/** The session is waiting on an answer: the prompt will be read as the answer (U7). */
	readAsAnswer?: boolean;
}

/** True when `branch` matches a protected-branch pattern (`main`, `release/*`). */
export function isFleetProtectedBranch(branch: string | null, patterns: readonly string[]): boolean {
	if (!branch) return false;
	for (const raw of patterns) {
		if (typeof raw !== 'string') continue;
		const pattern = raw.trim();
		if (!pattern) continue;
		if (pattern === branch) return true;
		if (pattern.includes('*')) {
			const escaped = pattern
				.split('*')
				.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
				.join('.*');
			if (new RegExp(`^${escaped}$`).test(branch)) return true;
		}
	}
	return false;
}

function isOpenPullRequest(pr: FleetSessionActionContext['pr']): pr is NonNullable<FleetSessionActionContext['pr']> {
	return pr !== null && (pr.state === 'open' || pr.state === 'draft');
}

/**
 * Which of the seven actions a session offers right now (spec FR-15, U5 …
 * U8), every one listed with why when it is not. Pure; the menu shows the
 * available ones, the server refuses the rest with `invalid` naming the rule.
 */
export function availableFleetSessionActions(context: FleetSessionActionContext): FleetSessionActionAvailability[] {
	const hide = (
		id: FleetSessionActionId,
		reason: FleetSessionActionHiddenReason
	): FleetSessionActionAvailability => ({
		id,
		available: false,
		reason
	});
	if (context.provider === 'shell') return FLEET_SESSION_ACTION_IDS.map((id) => hide(id, 'shell-session'));
	if (context.state === 'ended') return FLEET_SESSION_ACTION_IDS.map((id) => hide(id, 'ended'));
	const readAsAnswer = context.state === 'needs_you';
	const offer = (id: FleetSessionActionId, extra: Partial<FleetSessionActionAvailability> = {}) => ({
		id,
		available: true,
		...(readAsAnswer ? { readAsAnswer: true } : {}),
		...extra
	});
	if (!context.hasCheckout) {
		return FLEET_SESSION_ACTION_IDS.map((id) => (id === 'recap' ? offer(id) : hide(id, 'not-in-checkout')));
	}
	const onDefault = isFleetSessionOnDefaultBranch({
		branch: context.branch,
		baseRef: context.baseRef,
		defaultBranch: context.defaultBranch
	});
	const protectedBranch = isFleetProtectedBranch(context.branch, context.protectedBranches);
	const agent = context.kind === 'agent';
	const open = isOpenPullRequest(context.pr) ? context.pr : null;
	return FLEET_SESSION_ACTION_IDS.map((id): FleetSessionActionAvailability => {
		switch (id) {
			case 'commit':
			case 'review':
			case 'recap':
				return offer(id);
			case 'commitPush':
				if (!context.branch) return hide(id, 'no-branch');
				if (protectedBranch && agent) return hide(id, 'protected-branch');
				return offer(id, protectedBranch ? { warning: 'pushes-protected' } : {});
			case 'pullRequest':
				if (!context.branch) return hide(id, 'no-branch');
				if (onDefault) return hide(id, 'default-branch');
				if (protectedBranch && agent) return hide(id, 'protected-branch');
				return offer(id, open ? { update: { number: open.number } } : {});
			case 'fixComments':
				if (!context.branch) return hide(id, 'no-branch');
				if (onDefault) return hide(id, 'default-branch');
				if (!open) return hide(id, 'no-open-pull-request');
				if (!context.unresolvedComments || context.unresolvedComments < 1)
					return hide(id, 'no-unresolved-comments');
				return offer(id, { unresolvedComments: context.unresolvedComments });
			case 'resolveConflicts':
			default:
				if (!context.branch) return hide(id, 'no-branch');
				if (onDefault) return hide(id, 'default-branch');
				if (!open) return hide(id, 'no-open-pull-request');
				if (context.mergeable !== false) return hide(id, 'mergeable');
				return offer(id);
		}
	});
}

/** The sentence a refusal names for a hidden action (the server's `invalid` hint, spec U5). */
export function fleetSessionActionHiddenHint(
	id: FleetSessionActionId,
	reason: FleetSessionActionHiddenReason,
	context: { branch: string | null; nodeName?: string }
): string {
	const label = FLEET_SESSION_ACTION_LABELS[id];
	switch (reason) {
		case 'shell-session':
			return 'a shell session has no agent to prompt';
		case 'ended':
			return 'the session has ended; restart it first';
		case 'not-in-checkout':
			return 'This session is not in a checkout';
		case 'no-branch':
			return `${label} needs a branch; the checkout is not on one`;
		case 'default-branch':
			return `${label} is not available on ${context.branch ?? 'the default branch'}`;
		case 'protected-branch':
			return `${context.branch ?? 'this branch'} is protected; an Agent never pushes to it`;
		case 'no-open-pull-request':
			return `${label} needs an open pull request`;
		case 'no-unresolved-comments':
			return 'the pull request has no unresolved review comments';
		case 'mergeable':
		default:
			return 'the pull request can be merged cleanly';
	}
}

/** English labels for logs, audit rows and hints (the web reads `fleet.sessionGit.actions.*`). */
export const FLEET_SESSION_ACTION_LABELS: Readonly<Record<FleetSessionActionId, string>> = {
	commit: 'Commit',
	commitPush: 'Commit and push',
	pullRequest: 'Open a pull request',
	review: 'Review the changes',
	fixComments: 'Fix the review comments',
	resolveConflicts: 'Resolve conflicts',
	recap: 'Write a recap'
};

// ─── Sending, the ledger, rates (spec FR-21 … FR-24; CONTRACTS §10, R-38) ───

/** CONTRACTS §10 "Action prompts per session — 10 per minute, 2 s spacing". */
export const FLEET_SESSION_ACTION_RATE = { perMinute: 10, minSpacingMs: 2000 } as const;

/** A send whose delivery is not confirmed within this long is "not delivered" (plan §1). */
export const FLEET_SESSION_ACTION_DELIVERY_TIMEOUT_MS = 5000;

/** Longest redacted preview of a prompt kept on its audit row (plan §11). */
export const FLEET_SESSION_ACTION_PREVIEW_MAX_LENGTH = 200;

/** The step name of an Agent session's ledger rows on its Run's log (plan §4). */
export const FLEET_SESSION_ACTION_LOG_STEP = 'fleet.action';

/** Where a template came from (the sheet says "Nina's own template"). */
export const FLEET_SESSION_ACTION_TEMPLATE_SOURCES = ['default', 'agent'] as const;

export type FleetSessionActionTemplateSource = (typeof FLEET_SESSION_ACTION_TEMPLATE_SOURCES)[number];

export interface FleetSessionActionTemplate {
	text: string;
	source: FleetSessionActionTemplateSource;
}

/** `GET /api/fleet/sessions/:id/actions`. */
export interface FleetSessionActionsResponse {
	sessionId: string;
	actions: FleetSessionActionAvailability[];
	/** Every action's RENDERED prompt and where its template came from. */
	templates: Record<FleetSessionActionId, FleetSessionActionTemplate>;
	/** The values the placeholders rendered to. */
	context: {
		branch: string | null;
		base: string | null;
		pullNumber: number | null;
		taskSlug: string | null;
		/** The Agent's name, for "Nina's own template". */
		agentName: string | null;
		protectedBranch: boolean;
		/** The computer can be reached right now (U1). */
		reachable: boolean;
		/** The fleet kill switch is on (U3). */
		killSwitch: boolean;
	};
	/** Why the whole menu is disabled, when it is (offline, consent, permission). */
	disabled: { code: string; hint: string } | null;
}

/** `POST /api/fleet/sessions/:id/actions`. */
export interface FleetSessionActionSendRequest {
	actionId: FleetSessionActionId;
	/** The prompt as the person edited it (the rendered template when unchanged). */
	prompt: string;
}

export const FLEET_SESSION_ACTION_DELIVERY_STATES = ['pending', 'delivered', 'undelivered'] as const;

export type FleetSessionActionDeliveryState = (typeof FLEET_SESSION_ACTION_DELIVERY_STATES)[number];

export function isFleetSessionActionDeliveryState(value: unknown): value is FleetSessionActionDeliveryState {
	return typeof value === 'string' && (FLEET_SESSION_ACTION_DELIVERY_STATES as readonly string[]).includes(value);
}

/** `202` answer of a send or a resend. */
export interface FleetSessionActionSendResponse {
	ledgerId: string;
	delivery: FleetSessionActionDeliveryState;
}

/** One action sent (spec FR-22): `GET /api/fleet/sessions/:id/actions/ledger`. */
export interface FleetSessionActionLedgerEntry {
	/** The Run log row's id (Agent sessions) or the audit row's id (owner sessions). */
	id: string;
	actionId: FleetSessionActionId;
	sentAt: string;
	/** `user:<id>` or `agent:<id>`. */
	sentBy: string;
	delivery: FleetSessionActionDeliveryState;
	deliveredAt: string | null;
	/** The pull request the action produced, when it did. */
	prNumber: number | null;
	prUrl: string | null;
	/** Tokens attributed to the turn by the usage scan (FL-20); null = "unknown" until then. */
	tokens: number | null;
	costCents: number | null;
	/** `action` — this turn's own cost (Agent sessions); `session-total` — owner sessions show the session's total only (R-38). */
	costScope: 'action' | 'session-total';
}

export interface FleetSessionActionLedgerResponse {
	sessionId: string;
	entries: FleetSessionActionLedgerEntry[];
	/** Owner sessions (R-38): the session's total cost once FL-20 fills it, else null. */
	sessionCostCents: number | null;
}

// ─── The platform-side pull request (spec FR-16 … FR-20) ────────────────────

/** Longest pull-request title (spec §5.4: ≤ 70 characters). */
export const FLEET_PULL_REQUEST_TITLE_MAX_LENGTH = 70;

/** Longest pull-request body (plan §5). */
export const FLEET_PULL_REQUEST_BODY_MAX_LENGTH = 20_000;

/** `POST /api/fleet/checkouts/:id/pull-request` (and the Agent's `fleet_checkouts_open_pull_request`). */
export interface FleetOpenPullRequestRequest {
	title: string;
	body?: string;
	draft?: boolean;
	/** The session asking (the ledger row the pull request is credited to). */
	sessionId?: string;
}

/** Its answer. Never a merge: no FL-06 path merges anything (FR-20). */
export interface FleetOpenPullRequestResponse {
	number: number;
	url: string;
	state: FleetGitLinePullRequest['state'];
	/** True when an open pull request for the branch was updated instead of a second one opened (FR-16). */
	updated: boolean;
	/** The Task the pull request was recorded on (FR-19), when the session works on one. */
	taskId: string | null;
}

/** What the owner's pull-request dialog is prefilled with (spec §5.4). */
export interface FleetPullRequestDraft {
	checkoutId: string;
	branch: string | null;
	base: string | null;
	title: string;
	body: string;
	/** The branch is on the remote (else U10 "branch is not pushed yet"). */
	pushed: boolean;
	existing: FleetGitLinePullRequest | null;
}

// ─── The Agent's own templates (spec FR-13, FR-27, S12; P3) ─────────────────

/** `GET /api/fleet/agents/:agentId/action-templates` — the editor's Fleet actions section. */
export interface FleetAgentActionTemplates {
	agentId: string;
	agentName: string;
	/** The Agent's prefix override (null: the default — its slug). */
	branchPrefix: { value: string | null; default: string };
	/** Each action: the Agent's own text (null: the platform default) beside the default. */
	actions: Record<FleetSessionActionId, { value: string | null; default: string }>;
	/** Why the `fleet` block could not be read (it is then shown as all defaults), or null. */
	error: string | null;
	/** The whole `agent.yml` after a write (the editor's buffer), and its etag. */
	agentYml: string;
	hash: string;
}

/** `PUT /api/fleet/agents/:agentId/action-templates` — an empty text clears the override. */
export interface FleetAgentActionTemplatesUpdate {
	branchPrefix?: string | null;
	actions?: Partial<Record<FleetSessionActionId, string | null>>;
	/** The editor's last-known etag: a concurrent edit is refused, never overwritten. */
	expectedHash?: string;
}
