import { FLEET_MAX_CLI_VERSION_LENGTH, FLEET_MAX_MODEL_IDENTITY_LENGTH } from '@ever-works/contracts';
import type { CommandRunner } from './capabilities';
import type { ModelCliPaths } from './executors/model-cli';

/**
 * Node telemetry probes — the two facts the Fleet runner indicator shows
 * that the node did not previously report: which AGENT CLI is installed,
 * and how much disk is left.
 *
 * Both answer operational questions the existing fields cannot. The
 * node's `version` says whether the DAEMON is current; it says nothing
 * about the tool the daemon shells out to, which is what actually
 * executes an `agent-task` step — so "worked yesterday, fails today on
 * this one machine" had no visible cause. And a runner that is online,
 * idle and out of disk looks perfectly healthy right up to the moment
 * every job it takes fails.
 *
 * Design rules, both inherited from `gpu-probe.ts` and both load-bearing:
 *
 *   1. **A probe never fails the beat.** Every path swallows its own
 *      errors and returns null. A missing tool, an unreadable volume or
 *      a hung binary means a missing FIELD, not a missing heartbeat —
 *      and a heartbeat is the only thing keeping the node visible.
 *   2. **Everything is injected.** The command runner and the
 *      filesystem probe are parameters, so the whole matrix is
 *      unit-testable without touching the host.
 */

/**
 * Agent CLIs worth probing for, in preference order.
 *
 * The list is ORDERED, not exhaustive: the node reports the first one it
 * finds rather than enumerating everything installed, because the field
 * answers "what is this machine able to drive" for a human reading a
 * status popover — a comma-separated inventory would not fit the pill
 * and would not be more actionable.
 *
 * `claude` leads because the `claude-code` pipeline is the one the
 * platform ships with; the rest are the CLI-backed pipelines that also
 * exist as plugins (`codex`, `gemini`, `opencode`).
 */
export const AGENT_CLI_CANDIDATES: readonly string[] = ['claude', 'codex', 'gemini', 'opencode'];

/** Filesystem seam for the free-space probe. */
export interface DiskProbeIo {
	/**
	 * Free bytes available on the volume containing `path`, or null when
	 * the platform / runtime cannot answer.
	 */
	freeBytes(path: string): Promise<number | null> | number | null;
}

/**
 * Extract a version from a CLI's `--version` output.
 *
 * Deliberately permissive about the surrounding text and strict about
 * what it keeps: agent CLIs print anything from `1.2.3` to
 * `1.2.3 (Claude Code)` to a banner line, so the first dotted-numeric
 * token is the only reliably comparable part. Returns null when there is
 * no such token, because reporting a banner as a "version" would put
 * noise in a column operators scan for drift.
 */
export function parseCliVersion(stdout: string): string | null {
	if (typeof stdout !== 'string') return null;
	const match = /\b(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(stdout);
	return match ? match[1] : null;
}

/**
 * Find the first installed agent CLI and report `"<name> <version>"`.
 *
 * Returns null when none of the candidates answers `--version` with exit
 * code 0 — which is the normal state of a machine enrolled purely for
 * visibility, and must therefore read as "nothing installed" rather than
 * as an error.
 */
export async function detectAgentCliVersion(
	runner: CommandRunner,
	candidates: readonly string[] = AGENT_CLI_CANDIDATES
): Promise<string | null> {
	for (const command of candidates) {
		try {
			const result = await runner.run(command, ['--version']);
			if (result.code !== 0) continue;
			const version = parseCliVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
			if (!version) continue;
			return `${command} ${version}`.slice(0, FLEET_MAX_CLI_VERSION_LENGTH);
		} catch {
			// A spawn failure is an absent tool, not a probe failure.
			continue;
		}
	}
	return null;
}

/**
 * Free bytes on the volume holding `path`.
 *
 * Non-finite, negative and fractional readings all collapse to null: the
 * server refuses those anyway (it will not store a nonsense figure), and
 * sending one would only produce a rejected field plus a misleading log
 * line on both sides.
 */
export async function detectDiskFreeBytes(io: DiskProbeIo, path: string): Promise<number | null> {
	try {
		const free = await io.freeBytes(path);
		if (typeof free !== 'number' || !Number.isFinite(free) || free < 0) return null;
		return Math.floor(free);
	} catch {
		return null;
	}
}

// ─── Model identity (fleet cost accounting, EW-777) ─────────────────────────

/**
 * How long one identity reading is reused before the CLI is asked again.
 *
 * The heartbeat re-probes its telemetry on every beat (30s by default),
 * and `claude auth status` is a full CLI start-up — cheap on one machine,
 * pointless six times a minute across a fleet whose logins change once a
 * month. Five minutes keeps a re-login visible within the same window the
 * offline sweep already uses, without spawning the CLI per beat.
 */
export const MODEL_IDENTITY_CACHE_TTL_MS = 5 * 60_000;

/**
 * Build the label for Claude Code out of `claude auth status --json`.
 *
 * WHITELISTED fields only — `loggedIn`, `authMethod`, `email`, `orgName`,
 * `subscriptionType`. The raw document is never forwarded and never
 * logged: it is a credential-adjacent surface, and a future CLI version
 * printing a token next to the email must not turn a telemetry field into
 * a leak. Every field is optional; an unexpected shape reads as "logged
 * in, details unknown" rather than as a throw.
 */
export function parseClaudeAuthStatus(stdout: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const status = parsed as Record<string, unknown>;
	if (status.loggedIn !== true) return 'claude-code: not logged in';
	const email = compactString(status.email);
	const org = compactString(status.orgName);
	const plan = compactString(status.subscriptionType);
	const method = compactString(status.authMethod);
	const who = email ?? (method ? `${method} login` : 'logged in');
	const details = [org, plan].filter((part): part is string => part !== null);
	return `claude-code: ${who}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

/**
 * Build the label for Codex out of `codex login status`, which prints
 * prose ("Logged in using ChatGPT", "Logged in using an API key", "Not
 * logged in") rather than JSON and never names the account.
 */
export function parseCodexLoginStatus(stdout: string): string | null {
	const text = stdout.trim().toLowerCase();
	if (!text) return null;
	if (text.includes('not logged in')) return 'codex: not logged in';
	if (text.includes('chatgpt')) return 'codex: chatgpt';
	if (text.includes('api key')) return 'codex: api-key';
	if (text.includes('logged in')) return 'codex: logged in';
	return null;
}

/** One line, no control characters, so the label renders in a table cell. */
function compactString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const cleaned = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
	return cleaned ? cleaned : null;
}

/**
 * Which account / seat the node's agent CLI is logged in as.
 *
 * Probes the SAME binaries the `agent-task` step spawns (`paths`, as
 * resolved by `resolveModelCliPaths`), so the identity reported is the
 * identity that will be billed; a bare `claude` / `codex` on PATH is only
 * consulted when no path was resolved. Claude Code leads, like
 * {@link detectAgentCliVersion}: it is the provider the platform ships
 * with. Returns null when neither CLI answers — a probe never fails the
 * beat, and an absent field leaves the stored reading alone server-side.
 *
 * The label says WHO pays. It deliberately does not decide whether that
 * should be a dedicated seat per PC or the owner's own login — that is
 * the founder's call, recorded as open in
 * `docs/internal/feat-fleet-cost-accounting-notes.md`.
 */
export async function detectModelIdentity(runner: CommandRunner, paths: ModelCliPaths = {}): Promise<string | null> {
	const candidates: Array<{ command: string; args: string[]; parse: (stdout: string) => string | null }> = [
		{ command: paths['claude-code'] || 'claude', args: ['auth', 'status', '--json'], parse: parseClaudeAuthStatus },
		{ command: paths.codex || 'codex', args: ['login', 'status'], parse: parseCodexLoginStatus }
	];
	for (const candidate of candidates) {
		try {
			const result = await runner.run(candidate.command, candidate.args);
			const stdout = result.stdout ?? '';
			const stderr = result.stderr ?? '';
			// `codex login status` exits non-zero when logged out and still
			// says so — on stdout or stderr; the parser is the judge, not the
			// exit code. stdout is tried on its own FIRST: a deprecation
			// warning on stderr next to a valid JSON document must not turn
			// the Claude seat into "unparseable" and fall through to codex.
			const label = candidate.parse(stdout) ?? candidate.parse(`${stdout}\n${stderr}`);
			if (label) return label.slice(0, FLEET_MAX_MODEL_IDENTITY_LENGTH);
		} catch {
			// A spawn failure is an absent tool, not a probe failure.
			continue;
		}
	}
	return null;
}

/**
 * Memoise a probe for {@link MODEL_IDENTITY_CACHE_TTL_MS}.
 *
 * A null reading is cached too: a machine with no CLI would otherwise
 * spawn two failing processes per beat, forever. `now` is injectable so
 * the expiry is testable without waiting five minutes.
 */
export function cacheProbe<T>(
	probe: () => Promise<T | null>,
	ttlMs: number = MODEL_IDENTITY_CACHE_TTL_MS,
	now: () => number = Date.now
): () => Promise<T | null> {
	let value: T | null = null;
	let expiresAt = Number.NEGATIVE_INFINITY;
	let inFlight: Promise<T | null> | null = null;
	return async () => {
		if (now() < expiresAt) return value;
		if (inFlight) return inFlight;
		inFlight = probe()
			.then((fresh) => {
				value = fresh;
				expiresAt = now() + ttlMs;
				return fresh;
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	};
}
