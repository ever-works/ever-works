/**
 * Scoped push credentials and commit attribution (self-build slice AM,
 * EW-810) — the rules BOTH ends of the fleet share about how a node is
 * allowed to write to a remote, and whose name goes on the commit.
 *
 * ## The gap this module closes
 *
 * Until this slice a fleet node's `git push` was token-free by design:
 * the machine's own Git credential helper answered for it. In practice
 * that is a long-lived personal access token in the OS credential store
 * with write access to EVERY repository the service account can reach.
 * The platform could not scope it to one run, could not rotate it, could
 * not revoke it when a laptop was lost, and could not even observe that
 * it had been used. Six unattended machines each held one.
 *
 * What replaces it is a GitHub App INSTALLATION token, minted per job
 * over the node-authenticated job channel, narrowed to the repository
 * ids this job actually needs and to `contents: write` alone. It reaches
 * the node in one HTTPS response, lives in that process's memory for the
 * length of one commit-and-push, rides into `git` as an
 * `http.<url>.extraheader` carried in the CHILD ENVIRONMENT (never argv,
 * never a config file, never a remote URL), and is revoked at GitHub the
 * moment the run ends.
 *
 * ## Why the token is not on the payload
 *
 * Slice Y established that a value which reaches the job PAYLOAD reaches
 * the job row, the lease response, the job view and `fleet_jobs.result`.
 * So the payload carries no credential and no request for one: the node
 * asks for it on the authenticated channel, authorised — exactly as
 * slice Z's MCP credential is — by HOLDING THE LEASE.
 *
 * ## Attribution that cannot be forged
 *
 * Every fleet commit used to be authored `Ever Works Agent
 * <agent@ever.works>` on every machine, so Git history could not answer
 * WHICH node or WHICH agent produced a change. This module defines the
 * author/committer split (author = the Agent, committer = the node) and
 * a reserved `Ever-Works-` trailer namespace.
 *
 * The commit MESSAGE is payload-supplied and may contain newlines, so a
 * Task title could otherwise write trailer-shaped lines of its own and
 * claim a machine the run never used. {@link composeFleetPushCommitMessage}
 * REFUSES such a message rather than appending after it: a trailer a
 * reader cannot distinguish from ours is worse than no trailer at all.
 */

/**
 * Capability tag a node advertises when it can perform a SCOPED push:
 * `git` resolves and its version accepts environment-carried
 * configuration (`GIT_CONFIG_COUNT`, Git >= 2.31), which is the
 * mechanism the credential is installed through.
 *
 * It is a promise the node can keep, in the sense
 * `apps/node/src/core/capabilities.ts` means: the same fact that turns
 * the tag on is the fact the push depends on. A node without it is never
 * handed `agent-task` work, which is the point — the alternative is
 * twenty minutes of model time and then a refusal at the push.
 */
export const FLEET_PUSH_CAPABILITY = 'git-push';

/** Lowest Git that accepts `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>`. */
export const FLEET_PUSH_MIN_GIT_VERSION = '2.31.0';

/**
 * Basic-auth username GitHub expects alongside an installation access
 * token. Not a secret; pinned here so the node, the plugin and the
 * platform cannot disagree about it.
 */
export const FLEET_PUSH_CREDENTIAL_USERNAME = 'x-access-token';

/**
 * Where a node revokes its own installation token the instant the run
 * ends (`DELETE`, authenticated with the token itself).
 *
 * A CONSTANT rather than a field on the mint response, deliberately: the
 * response is the one place a write credential exists outside platform
 * memory, and giving it a caller-supplied destination for that credential
 * would be a redirect an attacker could aim. GitHub Enterprise hosts are
 * out of scope here for the same reason every other GitHub call in this
 * repository hardcodes `api.github.com`.
 */
export const FLEET_PUSH_CREDENTIAL_REVOKE_URL = 'https://api.github.com/installation/token';

/**
 * The ONE host a scoped push credential may ever be offered to.
 *
 * A GitHub App installation token is minted at `api.github.com` and is
 * meaningful to `github.com` and nowhere else, so any other host is at
 * best a wasted round trip and at worst a disclosure: Git sends an
 * `http.<url>.extraheader` on its VERY FIRST request, unprompted and
 * before any `401` challenge, so a remote merely POINTING somewhere else
 * is enough to hand that host a live `contents: write` credential for
 * the owner's repositories. A `404` from the attacker still gets the
 * token.
 *
 * This is why {@link fleetPushRemoteRepositoryId} compares `url.host`
 * and not just the path. `host` — not `hostname` — so a non-default
 * PORT is refused too: `https://github.com:8443/o/r` is somebody's proxy,
 * not GitHub. GitHub Enterprise is out of scope here for the same reason
 * {@link FLEET_PUSH_CREDENTIAL_REVOKE_URL} is a constant.
 */
export const FLEET_PUSH_CREDENTIAL_HOST = 'github.com';

/**
 * Reserved trailer namespace. Nothing a payload writes may start a line
 * with this: see the module header and
 * {@link containsReservedFleetPushTrailer}.
 */
export const FLEET_PUSH_TRAILER_NAMESPACE = 'Ever-Works-';

/**
 * The complete set of trailers a fleet commit carries. Fixed and small:
 * a trailer block that grows per slice becomes noise nobody reads, and
 * these four answer the question the whole slice exists for — which
 * machine, which agent, which job, which run.
 */
export const FLEET_PUSH_TRAILER_KEYS = [
	'Ever-Works-Node',
	'Ever-Works-Agent',
	'Ever-Works-Job',
	'Ever-Works-Run'
] as const;

/**
 * Upper bound on repositories one push credential may be scoped to: the
 * primary worktree plus the eight mounts `FLEET_TASK_WORKSPACE_MAX_MOUNTS`
 * allows. A request that resolves to more is refused rather than
 * truncated — a silently narrowed token fails at the push of whichever
 * repository fell off the end.
 */
export const FLEET_PUSH_CREDENTIAL_MAX_REPOSITORIES = 9;

/** The platform has no GitHub App configured, so it can mint nothing. */
export const FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON = 'push-credential-not-configured';

/**
 * The platform could not decide, from its OWN state, which installation
 * covers every repository this job writes to: no installation snapshot
 * names the repository, the installation was suspended or removed, it
 * belongs to somebody else, or the repositories span two installations.
 */
export const FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON = 'push-scope-unresolved';

/** The scope resolved but GitHub refused (or failed) the mint. */
export const FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON = 'push-credential-mint-failed';

/** Every stable refusal token this channel can answer with. */
export const FLEET_PUSH_CREDENTIAL_REASONS = [
	FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
	FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
	FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON
] as const;

export type FleetPushCredentialReason = (typeof FLEET_PUSH_CREDENTIAL_REASONS)[number];

/**
 * One operator-readable sentence per stable token.
 *
 * The node reports the TOKEN on the wire (so the string is never a
 * behavioural dependency) and renders this sentence into the run's
 * failure reason, because "push-scope-unresolved" on a Task page sends a
 * human hunting rather than to the page that fixes it.
 */
export function describeFleetPushCredentialRefusal(reason: string): string {
	switch (reason) {
		case FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON:
			return 'this deployment has no GitHub App configured, so no scoped push credential can be minted (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)';
		case FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON:
			return "no GitHub App installation this owner controls covers every repository this run writes to — install the Ever Works app on them, or re-sync the installation's repository list";
		case FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON:
			return 'GitHub refused to issue a scoped installation token for this run';
		default:
			return 'a scoped push credential could not be issued for this run';
	}
}

/**
 * True when `line` opens a trailer in the reserved namespace.
 *
 * Deliberately generous: leading whitespace is ignored and the match is
 * case-insensitive, because Git's own trailer parsing is case-insensitive
 * on the key and a reader skimming `git log` is more so. Anything that
 * could READ as one of our trailers counts as one.
 */
export function isFleetPushTrailerLine(line: string): boolean {
	if (typeof line !== 'string') return false;
	const trimmed = line.trimStart();
	if (!trimmed.toLowerCase().startsWith(FLEET_PUSH_TRAILER_NAMESPACE.toLowerCase())) return false;
	// A trailer is `Key: value`; a bare word that merely starts with the
	// namespace (a branch called `Ever-Works-main`) is prose, not a claim.
	return /^[A-Za-z0-9-]+[ \t]*:/.test(trimmed);
}

/** True when any line of `message` is trailer-shaped in the reserved namespace. */
export function containsReservedFleetPushTrailer(message: string): boolean {
	if (typeof message !== 'string') return false;
	return message.split(/\r\n|\r|\n/).some((line) => isFleetPushTrailerLine(line));
}

const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `owner/repo`, lower-cased, or null when the value is not one.
 *
 * Lower-cased because GitHub repository names are case-insensitive and
 * the comparison this feeds — "is the remote I am about to push to one
 * of the repositories the platform scoped this token to?" — must not
 * turn on the casing a payload happened to use.
 */
export function normalizeFleetPushRepositoryId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().replace(/\.git$/i, '');
	if (!REPOSITORY_ID_PATTERN.test(trimmed)) return null;
	return trimmed.toLowerCase();
}

/**
 * The `owner/repo` an HTTPS remote URL points at, or null.
 *
 * Used by the node to check the worktree's ACTUAL `origin` against the
 * repositories the platform scoped the credential to, BEFORE the token is
 * handed to Git. Only `https:` is accepted: an installation token is an
 * HTTP Basic credential and cannot authenticate an SSH remote, and any
 * other scheme is a remote this credential has no business reaching. A
 * URL carrying userinfo is refused outright — the fleet's clone URLs are
 * token-free by contract, and one that is not has already gone wrong
 * somewhere upstream.
 *
 * THE HOST IS PART OF THE IDENTITY, and this is the whole point of the
 * function. An earlier version of this slice validated the scheme, the
 * userinfo, the query and the number of path segments but never read
 * `url.host`, so `https://evil.tld/ever-works/ever-works.git` and
 * `https://github.com.evil.tld/ever-works/ever-works` both answered
 * `ever-works/ever-works` — the identical value the legitimate URL
 * answers — and therefore passed the node's only scope check. Git then
 * put the credential in an `Authorization: Basic` header on its first
 * request to that host, unchallenged. `owner/repo` is not an identity
 * without the host in front of it: the scope check downstream compares
 * only this return value, so anything this function is willing to
 * collapse is a repository the credential can be aimed at.
 */
export function fleetPushRemoteRepositoryId(remoteUrl: unknown): string | null {
	if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) return null;
	let url: URL;
	try {
		url = new URL(remoteUrl.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'https:') return null;
	if (url.username || url.password) return null;
	if (url.search || url.hash) return null;
	// `host`, so a port is part of the comparison; `URL` has already
	// lower-cased it and dropped an explicit `:443`, so `HTTPS://GitHub.COM`
	// passes and `https://github.com:8443` does not.
	if (url.host !== FLEET_PUSH_CREDENTIAL_HOST) return null;
	const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
	if (segments.length !== 2) return null;
	return normalizeFleetPushRepositoryId(`${segments[0]}/${segments[1]}`);
}

/**
 * Free text that is about to become part of a Git identity or trailer.
 *
 * Replaces control characters (a newline here is a forged trailer) and
 * the delimiters our own forms use — `<`/`>` around an address, `(`/`)`
 * around the id — with spaces, folds whitespace, then caps the length.
 * Written as a code-point walk rather than a regular expression so the
 * source file itself contains no control characters.
 *
 * Returns `''` when nothing survives, and every caller treats that as
 * "fall back to the fixed default" rather than emitting an empty name.
 */
export function sanitizeFleetPushIdentityText(value: unknown, maxLength = 64): string {
	if (typeof value !== 'string') return '';
	let out = '';
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		const delimiter = char === '<' || char === '>' || char === '(' || char === ')';
		out += code < 0x20 || code === 0x7f || delimiter ? ' ' : char;
	}
	return out.replace(/\s+/g, ' ').trim().slice(0, Math.max(1, maxLength)).trim();
}

/** Raised when attribution cannot be composed. Never carries a credential. */
export class FleetPushAttributionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FleetPushAttributionError';
	}
}

/**
 * Who a fleet commit is by, resolved entirely from PLATFORM STATE and
 * handed to the node on the authenticated channel.
 *
 * Not from the payload: the payload is a place a Task title reaches, and
 * a run that could name its own machine is a run whose attribution means
 * nothing. The node additionally refuses an answer whose `nodeId` is not
 * its own, so even a platform bug cannot make one machine sign for
 * another.
 */
export interface FleetPushAttribution {
	/** The node the platform believes holds this job's lease. */
	readonly nodeId: string;
	/** Operator-chosen node name, already sanitized. May be empty. */
	readonly nodeName: string;
	/** The Agent that produced the change, when the job named one. */
	readonly agentId: string | null;
	readonly agentName: string | null;
	/** `agents.committerEmail`, or the `<slug>@agents.ever.works` convention. */
	readonly agentEmail: string | null;
	readonly jobId: string;
	readonly runId: string | null;
}

/**
 * The short-lived write credential itself. Present ONLY when this job's
 * plan actually pushes (the platform re-reads its own `git.push`), so a
 * commit-only run never causes a write token to exist.
 */
export interface FleetPushCredential {
	/**
	 * THE only place the raw credential exists outside the platform's
	 * process, and it exists there for exactly the length of one HTTPS
	 * response. Nothing recovers it afterwards: a node that loses it
	 * re-mints.
	 */
	readonly token: string;
	/** Always {@link FLEET_PUSH_CREDENTIAL_USERNAME}; sent so the node need not assume. */
	readonly username: string;
	/** ISO-8601 instant GitHub says the token stops working. */
	readonly expiresAt: string;
	/**
	 * The repositories this token can write, as normalized `owner/repo`.
	 * The node refuses to offer the credential to any other remote.
	 */
	readonly repositories: readonly string[];
}

/** Response body of `POST /api/fleet/jobs/:id/push-credential`. */
export interface FleetJobPushCredentialResponse {
	readonly attribution: FleetPushAttribution;
	/** Null when this job's plan commits but does not push. */
	readonly push: FleetPushCredential | null;
}

/** The four Git identity fields a fleet commit is made with. */
export interface FleetPushCommitIdentity {
	readonly authorName: string;
	readonly authorEmail: string;
	readonly committerName: string;
	readonly committerEmail: string;
}

/** Fallbacks — the literals every fleet commit carried before this slice. */
export const FLEET_PUSH_DEFAULT_AUTHOR_NAME = 'Ever Works Agent';
export const FLEET_PUSH_DEFAULT_AUTHOR_EMAIL = 'agent@ever.works';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function requireIdentifier(value: unknown, field: string): string {
	if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
		throw new FleetPushAttributionError(`Push attribution ${field} is not a usable identifier`);
	}
	return value;
}

/**
 * AUTHOR is the Agent, COMMITTER is the node.
 *
 * That split is the whole answer to "which machine and which agent
 * produced this change": `git log --format='%an <%ae> / %cn <%ce>'` reads
 * it directly, and every hosting UI shows the author while recording the
 * committer. A single identity carrying both would have to lose one.
 *
 * Falls back to the pre-slice literals for a job that named no Agent —
 * there is nobody to attribute to, and inventing one would be the lie
 * this slice removes. The COMMITTER never falls back: a commit with no
 * node identity is exactly the state we are leaving.
 */
export function fleetPushCommitIdentity(attribution: FleetPushAttribution): FleetPushCommitIdentity {
	const nodeId = requireIdentifier(attribution?.nodeId, 'nodeId');
	const nodeName = sanitizeFleetPushIdentityText(attribution?.nodeName, 48);
	const hasAgent = typeof attribution?.agentId === 'string' && attribution.agentId.length > 0;
	const agentName = sanitizeFleetPushIdentityText(attribution?.agentName, 48);
	const agentEmail = typeof attribution?.agentEmail === 'string' ? attribution.agentEmail.trim() : '';
	return {
		authorName: hasAgent && agentName ? agentName : FLEET_PUSH_DEFAULT_AUTHOR_NAME,
		authorEmail: hasAgent && EMAIL_PATTERN.test(agentEmail) ? agentEmail : FLEET_PUSH_DEFAULT_AUTHOR_EMAIL,
		committerName: `Ever Works node ${nodeName || nodeId}`,
		committerEmail: `node-${nodeId}@nodes.ever.works`
	};
}

/**
 * The commit message a fleet run actually commits: the payload's message,
 * then a blank line, then the reserved trailer block.
 *
 * REFUSES a payload message that already contains a reserved trailer. The
 * alternative — appending ours after theirs — produces two blocks a reader
 * cannot tell apart, and Git's own `--parse` reads only the LAST
 * paragraph, so the forged one would be the one a human sees at the top of
 * `git log`. Failing the run with a named reason is the cheaper loss: the
 * message comes from a Task title, and renaming a Task is a fix an owner
 * can make.
 */
export function composeFleetPushCommitMessage(input: { message: string; attribution: FleetPushAttribution }): string {
	const message = typeof input?.message === 'string' ? input.message.trim() : '';
	if (!message) {
		throw new FleetPushAttributionError('Commit message is empty');
	}
	if (containsReservedFleetPushTrailer(message)) {
		throw new FleetPushAttributionError(
			`Commit message contains a reserved '${FLEET_PUSH_TRAILER_NAMESPACE}' trailer, which only the platform may write`
		);
	}
	const attribution = input.attribution;
	const nodeId = requireIdentifier(attribution?.nodeId, 'nodeId');
	const jobId = requireIdentifier(attribution?.jobId, 'jobId');
	const nodeName = sanitizeFleetPushIdentityText(attribution?.nodeName, 48);
	const trailers: string[] = [`Ever-Works-Node: ${nodeName ? `${nodeName} (${nodeId})` : nodeId}`];
	if (attribution?.agentId) {
		const agentId = requireIdentifier(attribution.agentId, 'agentId');
		const agentName = sanitizeFleetPushIdentityText(attribution.agentName, 48);
		trailers.push(`Ever-Works-Agent: ${agentName ? `${agentName} (${agentId})` : agentId}`);
	}
	trailers.push(`Ever-Works-Job: ${jobId}`);
	if (attribution?.runId) {
		trailers.push(`Ever-Works-Run: ${requireIdentifier(attribution.runId, 'runId')}`);
	}
	return `${message}\n\n${trailers.join('\n')}`;
}
