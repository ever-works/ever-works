/**
 * Repository-declared commands — the admission rules (EW-807, slice AA).
 *
 * ## What this is
 *
 * A Repository Work wraps somebody's existing code repository, and that
 * repository knows how it wants to be verified far better than a Work
 * settings page does: `pnpm install --frozen-lockfile`, then `pnpm lint`,
 * `pnpm type-check`, `pnpm test`. `.works/works.yml` has had a place to
 * say so (`spec.tasks.checks`) since the Repository Work kind landed, and
 * nothing read it.
 *
 * ## Why it is not simply read
 *
 * A check is a COMMAND THE OWNER'S MACHINE RUNS. Not a container in a
 * hosted CI account — one of the fleet's enrolled PCs, holding the
 * owner's model-CLI login, their Git credential helper, their shell
 * history and, during a run, decrypted `.env` files. Until this module,
 * every command that reached a node was authored by a Work member with
 * settings or Task-edit rights, which is the only reason no command
 * filter ever existed: the authorization WAS the authorship.
 *
 * `spec.tasks.checks` breaks that, because the author set becomes
 * "anyone who can land a commit or a PR branch" — and, during a run,
 * the model itself, which has write access to the whole checkout.
 *
 * ## The admission chain, in order
 *
 * 1. **The Work owner opts in.** `Work.repoDeclaredCommands.mode` is
 *    `'off'` for every existing Work and every new one. Nothing a
 *    repository declares is even READ until an owner sets it to
 *    `'allowlist'`.
 * 2. **The Work owner lists the commands.** `allow` is an EXACT-match
 *    list. Not a prefix, not a glob, not a program name — the same
 *    doctrine `normalizeFleetRunEnvGrants` applies to env names, and for
 *    the same reason: a prefix rule is a rule whose blast radius nobody
 *    can enumerate. `pnpm test` on the list does not admit
 *    `pnpm test && curl …`. What it does NOT bound is whatever the
 *    repository's own `package.json` puts behind `test` — see below.
 * 3. **The command that is MATCHED is the command that is RUN.** Both
 *    sides go through {@link normalizeRepoDeclaredCommand} first, so the
 *    comparison cannot be defeated by padding, a tab, or a newline
 *    smuggling a second statement past a visually identical prefix.
 * 4. **The set is frozen at dispatch.** The platform resolves the
 *    declarations while it plans the run and seals them into the
 *    immutable job payload, exactly like the owner-authored checks. The
 *    node never opens `.works/works.yml`, so a model that rewrites it
 *    mid-run changes nothing about the run it is in.
 * 5. **Refusal, never a quiet drop.** A malformed declaration, or one
 *    the allow-list does not admit, fails the PLAN. Dropping it would
 *    report a green run that verified less than the repository asked
 *    for, which is the failure this whole slice exists to remove.
 * 6. **No run env grants.** A repository-declared command never receives
 *    the run's `envGrants` — see `withRunEnvGrants` in the node's
 *    `agent-task` executor. An owner binds a credential to a repository
 *    for THEIR OWN commands; see the `.npmrc` case below for why that
 *    distinction has to be enforced and not merely intended.
 *
 * ## WHAT THE ALLOW-LIST DOES NOT BOUND — read this before turning it on
 *
 * The list freezes the command STRING. It does not, and cannot, freeze
 * what that string DOES, because every command an owner would plausibly
 * list delegates its behaviour to files in the repository — files that are
 * NOT frozen and ARE read at execution time. Three concrete consequences,
 * all reachable with an entry that matches character for character:
 *
 *  - **Lifecycle scripts.** `pnpm install` (with or without
 *    `--frozen-lockfile`) executes `preinstall` / `install` / `postinstall`
 *    / `prepare` out of the repository's own `package.json`. An attacker
 *    who can land a commit adds a `postinstall` and the allow-listed
 *    install runs it — first thing in the run, before the model. Pass
 *    `--ignore-scripts` if that is not what you meant.
 *  - **A repository-committed `.npmrc`.** npm and pnpm expand `${VAR}`
 *    from the process environment, so `//host/:_authToken=${NPM_TOKEN}`
 *    beside a `registry=` line posts a token to whoever wrote the file.
 *    This is why rule 6 above exists: on the fleet the run's env grants
 *    do not reach a repository-declared command at all. If your install
 *    genuinely needs a private-registry token, author it as one of the
 *    WORK's own setup steps, where you are the author of both halves.
 *  - **The script the command dispatches to.** `pnpm test` runs whatever
 *    `package.json`'s `test` script says at the moment it runs — and the
 *    model has write access to the checkout for the whole run. Freezing
 *    the declaration set at dispatch stops the SET from widening mid-run;
 *    it does not stop a listed command's target from changing.
 *
 * The honest summary: this feature makes a repository able to say WHICH of
 * the owner's approved commands to run, in which repository, in which
 * phase. It does not make the repository's contents safe to execute, and
 * the mode is off by default because nothing can.
 *
 * Everything here is pure and dependency-free so the platform validator,
 * the API DTO and the tests share one set of rules.
 */

/**
 * Whether a Work reads the commands its repository declares.
 *
 * - `off` — the default and the behaviour of every Work that existed
 *   before this feature. `.works/works.yml` is not consulted for
 *   commands at all; the run is graded by the owner-authored checks
 *   exactly as before.
 * - `allowlist` — declarations are read, and each one must appear
 *   verbatim in {@link WorkRepoDeclaredCommandPolicy.allow}.
 *
 * There is deliberately no `all` / `trust` mode. "Run whatever the
 * repository says" is remote code execution on the owner's desktop with
 * an extra step, and no configuration flag makes that a reasonable thing
 * to offer.
 */
export const WORK_REPO_DECLARED_COMMAND_MODES = ['off', 'allowlist'] as const;

export type WorkRepoDeclaredCommandMode = (typeof WORK_REPO_DECLARED_COMMAND_MODES)[number];

/** Ceiling on how many distinct commands one Work may admit. */
export const WORK_REPO_DECLARED_COMMAND_MAX_ALLOW = 32;

/**
 * Ceiling on one command's length, matching `REPO_CHECK_MAX_LENGTH` in
 * the works.yml schema so the two gates cannot disagree about what is
 * even representable.
 */
export const WORK_REPO_DECLARED_COMMAND_MAX_LENGTH = 500;

/** Ceiling on how many commands one repository may declare per phase. */
export const REPO_DECLARED_COMMANDS_MAX = 20;

/**
 * Id prefix stamped on every repository-declared command.
 *
 * `/` is OUTSIDE `ACCEPTANCE_CHECK_ID_PATTERN` (`[a-z0-9][a-z0-9-_]{0,40}`),
 * which is what owner-authored ids must match. That is the point: check
 * ids are the MERGE KEY between Work defaults and Task entries, so an id
 * a repository could choose freely would let a repository SUPPRESS or
 * REPLACE an owner-authored check by colliding with it. The suffix is
 * the declaration's position, never anything the repository wrote.
 *
 * It is therefore also a reliable AUTHORSHIP MARKER, and the fleet node
 * uses it as one: a command whose id carries this prefix is repository-
 * authored, so `withRunEnvGrants` withholds the run's env grants from it.
 * That inference is only sound because an owner cannot spell the prefix.
 */
export const REPO_DECLARED_COMMAND_ID_PREFIX = 'repo/';

/** The Work owner's decision about the commands its repository declares. */
export interface WorkRepoDeclaredCommandPolicy {
	mode: WorkRepoDeclaredCommandMode;
	/**
	 * Commands admitted verbatim, already normalized by
	 * {@link normalizeRepoDeclaredCommand}. Empty under `allowlist` means
	 * "read the file, admit nothing" — a valid, if pointless, state, and
	 * the one an owner lands in the moment they flip the mode on.
	 */
	allow: string[];
}

/** The policy every Work has until its owner says otherwise. */
export const DEFAULT_WORK_REPO_DECLARED_COMMAND_POLICY: WorkRepoDeclaredCommandPolicy = {
	mode: 'off',
	allow: []
};

/**
 * C0 control characters and DEL. A declared command is spliced into a
 * shell string; a NUL truncates it at the syscall boundary on POSIX and a
 * bare CR can hide the rest of a line in a terminal-rendered diff, so a
 * command carrying either is refused rather than sanitized. TAB, LF and
 * CR are handled by the whitespace collapse below and reach this test
 * already replaced.
 */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

/**
 * Put a command into the ONE form both the allow-list and the matcher
 * use: trimmed, with every run of whitespace collapsed to a single
 * space.
 *
 * Why normalize at all: the comparison in
 * {@link isRepoDeclaredCommandAllowed} is exact, and an exact comparison
 * over raw strings is defeated by anything invisible. `"pnpm test "`,
 * `"pnpm\ttest"` and `"pnpm test\nrm -rf ~"` all LOOK like the entry an
 * owner allow-listed in a review diff; only the first two are. Collapsing
 * first makes the first two match and the third not — and, critically,
 * the normalized string is what the runner is handed, so the string that
 * was matched is the string that is executed.
 *
 * Returns `null` for anything that cannot be a command: a non-string, an
 * empty or whitespace-only value, one carrying a control character, or
 * one longer than {@link WORK_REPO_DECLARED_COMMAND_MAX_LENGTH} once
 * normalized.
 */
export function normalizeRepoDeclaredCommand(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const collapsed = value.replace(/\s+/g, ' ').trim();
	if (!collapsed) return null;
	if (collapsed.length > WORK_REPO_DECLARED_COMMAND_MAX_LENGTH) return null;
	if (CONTROL_CHARACTER_PATTERN.test(collapsed)) return null;
	return collapsed;
}

/**
 * Read a `Work.repoDeclaredCommands` column into a policy.
 *
 * FAILS CLOSED and never throws: the column is `simple-json`, so a
 * hand-edited row, a restored backup or an account import can hold any
 * JSON at all, and this function sits on the path that decides whether a
 * repository's commands run on somebody's PC. Anything it does not
 * recognise resolves to `off`, which is the state every Work is in today
 * and grades a run by the owner's own checks — never to `allowlist`,
 * and never to a wider `allow` list than the column literally spelled
 * out.
 *
 * Entries are normalized, de-duplicated, and capped at
 * {@link WORK_REPO_DECLARED_COMMAND_MAX_ALLOW}; an entry that does not
 * normalize is DROPPED here (it could never match anything anyway, since
 * a declaration is normalized by the same function before comparison),
 * which is a narrowing, not a widening.
 */
export function normalizeWorkRepoDeclaredCommandPolicy(raw: unknown): WorkRepoDeclaredCommandPolicy {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ...DEFAULT_WORK_REPO_DECLARED_COMMAND_POLICY };
	}
	const source = raw as Record<string, unknown>;
	const mode = (WORK_REPO_DECLARED_COMMAND_MODES as readonly string[]).includes(source.mode as string)
		? (source.mode as WorkRepoDeclaredCommandMode)
		: 'off';
	if (mode === 'off') return { mode: 'off', allow: [] };

	const allow: string[] = [];
	const seen = new Set<string>();
	for (const entry of Array.isArray(source.allow) ? source.allow : []) {
		const normalized = normalizeRepoDeclaredCommand(entry);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		allow.push(normalized);
		if (allow.length >= WORK_REPO_DECLARED_COMMAND_MAX_ALLOW) break;
	}
	return { mode, allow };
}

/**
 * Does this policy admit this command?
 *
 * EXACT match on the normalized form, case-sensitive. Case-sensitive
 * because shells are: `PNPM TEST` is not `pnpm test` on the machines
 * where it would matter, and folding case would admit a command an owner
 * never wrote.
 *
 * A command that does not normalize is never admitted, whatever the
 * list says.
 */
export function isRepoDeclaredCommandAllowed(
	command: unknown,
	policy: WorkRepoDeclaredCommandPolicy | null | undefined
): boolean {
	if (!policy || policy.mode !== 'allowlist') return false;
	const normalized = normalizeRepoDeclaredCommand(command);
	if (!normalized) return false;
	return policy.allow.includes(normalized);
}

/**
 * The id a repository-declared command is reported under.
 *
 * Derived from the phase and the declaration's ORDINAL, never from
 * anything the repository wrote — see
 * {@link REPO_DECLARED_COMMAND_ID_PREFIX}.
 */
export function repoDeclaredCommandId(phase: 'setup' | 'check', index: number): string {
	return `${REPO_DECLARED_COMMAND_ID_PREFIX}${phase}-${index + 1}`;
}
