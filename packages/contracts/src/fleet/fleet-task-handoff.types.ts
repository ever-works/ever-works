/**
 * Fleet — Tasks on computers (FL-15, CONTRACTS §11.2 `/tasks/:taskId/handoff-options`, R-22).
 *
 * **Fix with an agent on this computer** hands a Task to an Agent session
 * (FL-04) on a computer the person picks, in a checkout they pick (FL-14),
 * with a first message prefilled from the Task. Nothing new is stored: a
 * Session knows its Run and its Checkout, a Run knows its Task, a Task knows
 * its pull request — this file only names the shapes the dialog, the Task
 * page and the tools read, and the pure rules both sides of the wire share so
 * the dialog and the server can never disagree on why a computer is not
 * selectable (plan §15, risk 1).
 *
 * Every union carries a `readonly` list and an `isX` guard (the house
 * pattern); every helper is pure and never throws.
 */

import { parseFleetRemote, type FleetCheckoutKind } from './fleet-checkout.types.js';
import type { FleetLinkErrorCode } from './fleet-link.types.js';
import {
	FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH,
	type FleetAgentSessionProvider,
	type FleetSessionState
} from './fleet-sessions.types.js';

// ─── Why a computer cannot take the Task (spec FR-2) ────────────────────────

/**
 * The closed set of reasons a computer is listed but not selectable (spec
 * FR-2), plus `no-access` (lane-log decision 8, owner question Q1): the
 * person is outside the computer's `sessions` audience, or the computer is
 * someone else's (an Agent session runs on its owner's own computers).
 */
export const FLEET_HANDOFF_REASONS = [
	'offline',
	'needs-work',
	'missing-cli',
	'no-slot',
	'not-pinned',
	'kill-switch',
	'no-access'
] as const;

export type FleetHandoffReason = (typeof FLEET_HANDOFF_REASONS)[number];

export function isFleetHandoffReason(value: unknown): value is FleetHandoffReason {
	return typeof value === 'string' && (FLEET_HANDOFF_REASONS as readonly string[]).includes(value);
}

/**
 * The reason FL-04's start refusal maps to. `busy` from the start rules is a
 * paused, disabled or enrolling computer — offline to the person picking one;
 * `unsupported_on_node` is a missing CLI or a session daemon that is not
 * running. Codes no start rule answers map to `null`.
 */
export function fleetHandoffReasonForRefusal(code: FleetLinkErrorCode): FleetHandoffReason | null {
	switch (code) {
		case 'kill_switch':
			return 'kill-switch';
		case 'consent_missing':
			return 'needs-work';
		case 'unreachable':
		case 'busy':
			return 'offline';
		case 'unsupported_on_node':
			return 'missing-cli';
		case 'limit_exceeded':
			return 'no-slot';
		case 'permission_denied':
		case 'not_found':
			return 'no-access';
		default:
			return null;
	}
}

/** What the hand-off knows about one computer before it judges it. */
export interface FleetHandoffComputerFacts {
	nodeId: string;
	nodeName: string;
	/** FL-04's start rules for an Agent session of this CLI on this computer (`null` = allowed). */
	refusal: { code: FleetLinkErrorCode; hint: string } | null;
	/** The computer the Agent is pinned to, or null (affinity, never written here — FR-3). */
	pinnedNodeId: string | null;
	pinnedNodeName: string | null;
	agentName: string;
	/** Live Agent sessions on the computer right now. */
	liveAgentSessions: number;
	/** Its concurrency (`effectiveMaxConcurrentJobs`), or null when unknown (no limit is judged). */
	slots: number | null;
}

/** The verdict on one computer: selectable, or the first reason it is not. */
export interface FleetHandoffVerdict {
	selectable: boolean;
	reason: FleetHandoffReason | null;
	hint: string | null;
}

/**
 * Judge one computer for a hand-off. First reason wins, in this order: the
 * kill switch (it stops everything), the pin (S2: a pinned Agent's computer
 * is the only selectable one), FL-04's own start rules, then a free slot
 * (U5). The order is the dialog's and the server's — both call this.
 */
export function judgeFleetHandoffComputer(facts: FleetHandoffComputerFacts): FleetHandoffVerdict {
	if (facts.refusal?.code === 'kill_switch') {
		return { selectable: false, reason: 'kill-switch', hint: facts.refusal.hint };
	}
	if (facts.pinnedNodeId && facts.pinnedNodeId !== facts.nodeId) {
		const pinned = facts.pinnedNodeName ?? 'another computer';
		return {
			selectable: false,
			reason: 'not-pinned',
			hint: `${facts.agentName} is pinned to ${pinned}. Change that on ${facts.agentName}'s Capabilities tab.`
		};
	}
	if (facts.refusal) {
		return {
			selectable: false,
			reason: fleetHandoffReasonForRefusal(facts.refusal.code) ?? 'offline',
			hint: facts.refusal.hint
		};
	}
	if (typeof facts.slots === 'number' && facts.slots > 0 && facts.liveAgentSessions >= facts.slots) {
		return {
			selectable: false,
			reason: 'no-slot',
			hint: `${facts.nodeName} is running ${facts.liveAgentSessions} of ${facts.slots} agent sessions`
		};
	}
	return { selectable: true, reason: null, hint: null };
}

// ─── The Agent's CLI (lane-log decision 9) ──────────────────────────────────

/**
 * The CLI an Agent drives in a session: an OpenAI provider → Codex, anything
 * else (Anthropic, a gateway, unset) → Claude Code. A computer without that
 * CLI is `missing-cli` (spec U6).
 */
export function fleetHandoffAgentCli(agent: { aiProviderId?: string | null }): FleetAgentSessionProvider {
	const provider = typeof agent.aiProviderId === 'string' ? agent.aiProviderId.trim().toLowerCase() : '';
	return provider === 'openai' || provider === 'codex' || provider.startsWith('openai-') ? 'codex' : 'claude-code';
}

// ─── Where the Task came from (spec FR-7, S3) ───────────────────────────────

export const FLEET_TASK_SOURCE_KINDS = ['issue', 'pull'] as const;

export type FleetTaskSourceKind = (typeof FLEET_TASK_SOURCE_KINDS)[number];

/** A GitHub issue or pull request a Task names (a Trigger writes the link into the description). */
export interface FleetTaskSourceLink {
	provider: 'github';
	kind: FleetTaskSourceKind;
	url: string;
	/** `owner/repo` as written in the link. */
	repository: string;
	number: number;
}

/**
 * The first GitHub issue or pull-request link in a text, or null. Bounded
 * quantifiers only (no backtracking on long input), and at most the first
 * 20 000 characters are read.
 */
export function parseFleetTaskSourceLink(text: unknown): FleetTaskSourceLink | null {
	if (typeof text !== 'string' || text.length === 0) return null;
	const match =
		/https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/(issues|pull)\/(\d{1,9})(?![0-9A-Za-z])/.exec(
			text.slice(0, 20_000)
		);
	if (!match) return null;
	const number = Number(match[4]);
	if (!Number.isSafeInteger(number) || number <= 0) return null;
	const repository = `${match[1]}/${match[2]}`;
	const kind: FleetTaskSourceKind = match[3] === 'pull' ? 'pull' : 'issue';
	return {
		provider: 'github',
		kind,
		url: `https://github.com/${repository}/${kind === 'pull' ? 'pull' : 'issues'}/${number}`,
		repository,
		number
	};
}

// ─── The first message (spec FR-7) ──────────────────────────────────────────

/** The description excerpt a first message carries, in characters (FR-7). */
export const FLEET_TASK_FIRST_MESSAGE_EXCERPT_MAX = 2_000;

/** The acceptance summary a first message carries, in characters. */
export const FLEET_TASK_FIRST_MESSAGE_CHECKS_MAX = 400;

export interface FleetTaskFirstMessageInput {
	slug: string;
	title: string;
	description?: string | null;
	/** The acceptance checks' names, when the Task declares any. */
	checks?: readonly string[] | null;
	source?: FleetTaskSourceLink | null;
	branch?: string | null;
	/** The Task has a repository: the message asks for a commit and a pull request. */
	hasRepository: boolean;
	/** A pull-request Task (P3, S4): review and address its comments instead of "fix". */
	review?: boolean;
}

function excerpt(text: string, max: number): string {
	const clean = text.replace(/\r\n?/g, '\n').trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The prefilled first message (spec FR-7): the Task title, the description
 * excerpt (≤ 2 000 characters), the acceptance checks summary, the source
 * link for a Trigger-made Task, and the hand-off line. Deterministic; always
 * within FL-04's first-message bound. The person can edit it before sending.
 */
export function buildFleetTaskFirstMessage(input: FleetTaskFirstMessageInput): string {
	const title = input.title.replace(/\s+/g, ' ').trim();
	const lines: string[] = [];
	if (input.review && input.source?.kind === 'pull') {
		lines.push(`Review and address the comments on #${input.source.number} for ${input.slug} "${title}".`);
	} else {
		lines.push(`Fix ${input.slug} "${title}".`);
	}
	if (input.source) lines.push(`Source: ${input.source.url}`);
	if (input.branch) lines.push(`Branch: ${input.branch}`);
	const description = typeof input.description === 'string' ? input.description.trim() : '';
	if (description.length > 0) {
		lines.push('', 'Description:', excerpt(description, FLEET_TASK_FIRST_MESSAGE_EXCERPT_MAX));
	}
	const checks = (input.checks ?? []).map((name) => name.replace(/\s+/g, ' ').trim()).filter(Boolean);
	if (checks.length > 0) {
		lines.push('', `Acceptance: ${excerpt(checks.join('; '), FLEET_TASK_FIRST_MESSAGE_CHECKS_MAX)}`);
	}
	lines.push(
		'',
		input.hasRepository ? 'When done, commit and open a pull request.' : 'When done, summarise what you changed.'
	);
	const message = lines.join('\n');
	return message.length <= FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH
		? message
		: `${message.slice(0, FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH - 1)}…`;
}

// ─── The checkout step (spec FR-5, U7) ──────────────────────────────────────

/**
 * `worktree` — a new worktree of a matching checkout, on the Task's branch;
 * `existing` — an existing checkout as it is; `clone` — a fresh clone of the
 * Task's repository; `none` — the home folder (a Task without a repository).
 */
export const FLEET_HANDOFF_CHECKOUT_MODES = ['worktree', 'existing', 'clone', 'none'] as const;

export type FleetHandoffCheckoutMode = (typeof FLEET_HANDOFF_CHECKOUT_MODES)[number];

export function isFleetHandoffCheckoutMode(value: unknown): value is FleetHandoffCheckoutMode {
	return typeof value === 'string' && (FLEET_HANDOFF_CHECKOUT_MODES as readonly string[]).includes(value);
}

/** One ready checkout on a computer the dialog can offer. */
export interface FleetHandoffCheckoutRef {
	checkoutId: string;
	path: string;
	kind: FleetCheckoutKind;
	branch: string | null;
	/** `owner/repo` of its remote, when it parses. */
	repository: string | null;
	/** It is a checkout of the Task's repository (or linked to the Task's Work). */
	matchesTask: boolean;
}

/** The checkout step for one computer. */
export interface FleetHandoffNodeCheckouts {
	nodeId: string;
	/** Ready, host-isolated checkouts of the Task's repository — the parents a new worktree is cut from. */
	matching: FleetHandoffCheckoutRef[];
	/** Every other ready, host-isolated checkout on the computer (U7 offers them for a repository-less Task). */
	others: FleetHandoffCheckoutRef[];
	/** The choice the dialog starts on (FR-5). */
	defaultMode: FleetHandoffCheckoutMode;
	/** Why this computer's checkouts could not be read (it is offline, the flag is off), or null. */
	stale: string | null;
}

/**
 * The default checkout choice (FR-5): a new worktree when a matching checkout
 * exists on that computer, else a fresh clone of the Task's repository, else
 * (no repository, U7) an existing checkout when there is one, else none.
 */
export function defaultFleetHandoffCheckoutMode(input: {
	hasRepository: boolean;
	matching: number;
	others: number;
}): FleetHandoffCheckoutMode {
	if (input.hasRepository) return input.matching > 0 ? 'worktree' : 'clone';
	return input.others > 0 || input.matching > 0 ? 'existing' : 'none';
}

// ─── The options answer (`GET /api/fleet/tasks/:taskId/handoff-options`) ────

/** One computer as the dialog lists it (FR-2). */
export interface FleetHandoffComputer {
	nodeId: string;
	name: string;
	online: boolean;
	lastSeenAt: string | null;
	/** `linux`, `darwin`, `win32`, … as the node reports its platform; null when unknown. */
	os: string | null;
	/** Agent CLIs the computer has (its capability tags). */
	clis: FleetAgentSessionProvider[];
	selectable: boolean;
	reason: FleetHandoffReason | null;
	/** The sentence under an unselectable row (the start rule's own hint, or the pin note). */
	hint: string | null;
	/** The Agent is pinned to this computer. */
	pinned: boolean;
	liveAgentSessions: number;
	slots: number | null;
}

/** Where an Agent candidate came from — the same tags **Run with agent** shows (FR-4). */
export const FLEET_HANDOFF_AGENT_SOURCES = ['assignee', 'task', 'work-default'] as const;

export type FleetHandoffAgentSource = (typeof FLEET_HANDOFF_AGENT_SOURCES)[number];

/** One Agent candidate (FR-4). */
export interface FleetHandoffCandidateAgent {
	id: string;
	name: string;
	slug: string | null;
	status: string | null;
	source: FleetHandoffAgentSource;
	/** The CLI it drives in a session. */
	cli: FleetAgentSessionProvider;
	/** Its model, for the cost sentence (FR-8), when set. */
	modelId: string | null;
	pinnedNodeId: string | null;
	pinnedNodeName: string | null;
}

/** The Task as the dialog reads it. */
export interface FleetHandoffTask {
	id: string;
	slug: string;
	title: string;
	status: string;
	workId: string | null;
	/** The branch a session works on (FL-06 FR-4: the Task's branch). */
	branch: string | null;
	/** `owner/repo` of the Task's repository, or null (U7). */
	repository: string | null;
	/** The clone URL of that repository, or null. */
	repoUrl: string | null;
	/** The issue or pull request the Task came from, when it names one. */
	source: FleetTaskSourceLink | null;
	/**
	 * P3 (spec FR-20, S4, U8): the pull request a Task was made from — its head
	 * branch is what the session checks out. Absent for every other Task.
	 */
	pullRequest?: FleetHandoffPullRequest | null;
}

/** A pull-request Task's head (spec FR-20). */
export interface FleetHandoffPullRequest {
	/** `owner/repo` of the pull request's base repository. */
	repository: string;
	number: number;
	/** The head branch; null when the event that made the Task did not carry it. */
	headRef: string | null;
	/** `owner/repo` the head branch lives in (a fork's, or the base repository). */
	headRepo: string | null;
	fork: boolean;
	maintainerCanModify: boolean;
	/** A fork's branch the session may not push to (no maintainer edits, U8). */
	readOnly: boolean;
}

/**
 * Read the pull request a `github.pr` event payload describes (FL-15 P3, the
 * intake's and the review bridge's shape), or null. A head repository other
 * than the base makes it a fork; a fork without maintainer edits is
 * read-only (spec FR-20, U8).
 */
export function fleetHandoffPullRequestFrom(payload: unknown): FleetHandoffPullRequest | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;
	const repository = typeof record.repoFullName === 'string' ? record.repoFullName.trim() : '';
	const number = typeof record.prNumber === 'number' && Number.isSafeInteger(record.prNumber) ? record.prNumber : NaN;
	if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repository) || !(number > 0)) return null;
	const headRef =
		typeof record.headRef === 'string' && record.headRef.trim() ? record.headRef.trim().slice(0, 255) : null;
	const headRepo =
		typeof record.headRepo === 'string' &&
		/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(record.headRepo.trim())
			? record.headRepo.trim()
			: null;
	const fork = record.fork === true || (headRepo !== null && headRepo.toLowerCase() !== repository.toLowerCase());
	const maintainerCanModify = record.maintainerCanModify === true;
	return { repository, number, headRef, headRepo, fork, maintainerCanModify, readOnly: fork && !maintainerCanModify };
}

/** `GET /api/fleet/tasks/:taskId/handoff-options?agentId=` (CONTRACTS §11.2). */
export interface FleetTaskHandoffOptions {
	task: FleetHandoffTask;
	agents: FleetHandoffCandidateAgent[];
	/** The Agent the computers were judged for: the asked `agentId`, else the first candidate, else null. */
	agentId: string | null;
	computers: FleetHandoffComputer[];
	checkouts: FleetHandoffNodeCheckouts[];
	/** The prefilled first message for the selected Agent (FR-7). */
	firstMessage: string;
	/** The fleet kill switch is on (U3): nothing is selectable. */
	killSwitch: boolean;
	/** A live session already working this Task with this Agent (U13: Open it), or null. */
	activeSessionId: string | null;
}

/** Order the dialog lists computers in: selectable first, then online, then by name. */
export function compareFleetHandoffComputers(left: FleetHandoffComputer, right: FleetHandoffComputer): number {
	if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
	if (left.selectable !== right.selectable) return left.selectable ? -1 : 1;
	if (left.online !== right.online) return left.online ? -1 : 1;
	return left.name.localeCompare(right.name);
}

/** `owner/repo` of a clone URL, when it parses (the Task's repository line). */
export function fleetHandoffRepositoryOf(url: unknown): string | null {
	const parsed = parseFleetRemote(url);
	return parsed ? `${parsed.owner}/${parsed.repo}` : null;
}

// ─── The Task on a session (spec FR-10, CONTRACTS R-22) ─────────────────────

// `FleetSessionTaskRef` (the session card's Task chip) lives beside `FleetSessionView` in `fleet-sessions.types.ts`.

/**
 * The Task page's **Computer** block (FR-9), as the web builds it from the
 * Task's latest session and that session's checkout. Kept as a type so the
 * tools and the web describe the same three links.
 */
export interface FleetTaskComputerBlock {
	session: {
		id: string;
		nodeId: string;
		nodeName: string | null;
		agentId: string | null;
		agentName: string | null;
		state: FleetSessionState;
		startedAt: string | null;
		endedAt: string | null;
	} | null;
	checkout: { id: string; path: string; branch: string | null } | null;
	pullRequest: { number: number; url: string; state: string | null } | null;
}

// ─── Git identity on a computer (P2, spec FR-12 … FR-16) ────────────────────

/** One git config value as the identity card reads it; `value` only for the computer's owner (FR-13). */
export interface FleetGitIdentityField {
	set: boolean;
	value?: string;
}

/** `GET /api/fleet/nodes/:id/git/identity` (CONTRACTS §11.2). */
export interface FleetGitIdentity {
	nodeId: string;
	name: FleetGitIdentityField;
	email: FleetGitIdentityField;
	helper: { present: boolean; value?: string };
	/** Ever Works can push for agents there: the `git-push` tag and an installation covering a repository. */
	canPushForAgents: { ok: boolean; reason?: string; repositories?: string[] };
	/** When the node answered (ISO). */
	readAt: string;
}

/** How long the platform keeps a computer's identity read (plan §10). */
export const FLEET_GIT_IDENTITY_CACHE_MS = 60_000;

/** Identity reads and sets per person per minute (CONTRACTS §10.1). */
export const FLEET_GIT_IDENTITY_PER_MINUTE = 10;

/** Where **Use my Ever Works identity** takes the email from (spec FR-14). */
export type FleetGitIdentityEmailSource = 'github-noreply' | 'account';

/** `POST /api/fleet/nodes/:id/git/identity` answer: the re-read identity and what was set. */
export interface FleetGitIdentitySetResult extends FleetGitIdentity {
	fields: Array<'user.name' | 'user.email'>;
	emailSource: FleetGitIdentityEmailSource;
}

/** GitHub's no-reply address for a linked account: `<id>+<login>@users.noreply.github.com`. */
export function fleetGithubNoReplyEmail(githubUserId: string | number, githubLogin: string): string | null {
	const id = String(githubUserId).trim();
	const login = typeof githubLogin === 'string' ? githubLogin.trim() : '';
	if (!/^\d{1,20}$/.test(id) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return null;
	return `${id}+${login}@users.noreply.github.com`;
}

function readIdentityField(raw: unknown): FleetGitIdentityField {
	if (typeof raw !== 'object' || raw === null) return { set: false };
	const record = raw as Record<string, unknown>;
	if (record.set !== true) return { set: false };
	return typeof record.value === 'string' && record.value.length > 0
		? { set: true, value: record.value.slice(0, 200) }
		: { set: true };
}

/** The node's `git.identity` / `git.setIdentity` reply, read defensively (the node is another release). */
export function parseFleetGitIdentityReply(
	raw: unknown
): Pick<FleetGitIdentity, 'name' | 'email' | 'helper'> & { readAt: string | null } {
	const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
	const helperRaw =
		typeof record.helper === 'object' && record.helper !== null ? (record.helper as Record<string, unknown>) : {};
	return {
		name: readIdentityField(record.name),
		email: readIdentityField(record.email),
		helper:
			helperRaw.present === true
				? typeof helperRaw.value === 'string' && helperRaw.value
					? { present: true, value: helperRaw.value.slice(0, 200) }
					: { present: true }
				: { present: false },
		readAt: typeof record.readAt === 'string' ? record.readAt : null
	};
}

/**
 * What a viewer may read of an identity (spec FR-13): the computer's owner
 * reads the values; everyone else reads set / unset only.
 */
export function maskFleetGitIdentity(identity: FleetGitIdentity, viewerIsOwner: boolean): FleetGitIdentity {
	if (viewerIsOwner) return identity;
	return {
		...identity,
		name: { set: identity.name.set },
		email: { set: identity.email.set },
		helper: { present: identity.helper.present }
	};
}

/** The identity needs the fix: name or email unset (the dialog offers it inline, FR-16). */
export function fleetGitIdentityIncomplete(identity: Pick<FleetGitIdentity, 'name' | 'email'>): boolean {
	return !identity.name.set || !identity.email.set;
}

// ─── The GitHub "for me" audience (P3, spec FR-18) ──────────────────────────

/** Review requested from me · assigned to me · pull requests I opened. */
export const FLEET_GITHUB_AUDIENCES = ['review-requested', 'assigned', 'authored'] as const;

export type FleetGithubAudience = (typeof FLEET_GITHUB_AUDIENCES)[number];

export function isFleetGithubAudience(value: unknown): value is FleetGithubAudience {
	return typeof value === 'string' && (FLEET_GITHUB_AUDIENCES as readonly string[]).includes(value);
}
