/**
 * APW-05 T13 — why a Build failed, and the twenty lines that show it.
 *
 * Plan §4.9's table, in its order, evaluated on the FAILING job's log. The
 * order is the whole design: a log can carry several signals at once and the
 * first match wins, so the rows are arranged from "the member did something we
 * can name" down to "the infrastructure broke" down to `unknown`.
 *
 * Two orderings are load-bearing and each has its own case:
 *
 *  - **`outOfMemory` (5) beats `dockerfileError` (9).** A container killed for
 *    memory prints `exit code: 137` AND a failing `#12 [builder 3/7] RUN …`
 *    line, because the step that was running when the kernel killed it is the
 *    step BuildKit reports. Classifying that as a Dockerfile error sends the
 *    member to fix a `RUN` line that is fine; `outOfMemory` sends them to the
 *    runner size, which is the actual problem.
 *  - **`missingBuildValue` (1) beats everything.** The workflow's first step
 *    prints `EW_MISSING:<NAME>` and exits 78 before anything is built, so any
 *    other signal in the same log is noise from a previous attempt.
 *
 * ## The excerpt is bounded twice, and redacted twice
 *
 * Twenty lines ending at the MATCHED line — not the last twenty, which for a
 * long build are the teardown — each cut to 300 characters. Then `redact`, the
 * App Work's own redactor from APW-07, and then a secret-shaped mask on top of
 * it. Two passes because they catch different things: `redact` knows this
 * Work's actual values, and the mask catches the shapes nobody registered — a
 * token a build script printed, a connection string in an error message.
 *
 * A log excerpt is the one place build output reaches a database, so it is the
 * one place a value that was never supposed to leave the runner can.
 */

/** Plan §4.9's eleven classes, in the order they are evaluated. */
export const BUILD_FAILURE_CLASSES = [
	'missingBuildValue',
	'secretInImage',
	'timeout',
	'workflowInvalid',
	'outOfMemory',
	'diskFull',
	'registryPushDenied',
	'dependencyDownloadFailed',
	'dockerfileError',
	'verificationFailed',
	'unknown'
] as const;

export type BuildFailureClass = (typeof BUILD_FAILURE_CLASSES)[number];

/** Plan §4.9's excerpt bounds. */
export const EXCERPT_MAX_LINES = 20;
export const EXCERPT_MAX_LINE_CHARS = 300;

/** What the classifier was given to work with. */
export interface ClassifyFailureInput {
	/** The failing job's log, already fetched and split is not required. */
	readonly log: string;
	/** The failing job's conclusion, when GitHub reported one. */
	readonly jobConclusion?: string | null;
	/** The RUN's conclusion, for `workflowInvalid`. */
	readonly runConclusion?: string | null;
	/** How many jobs the run had; zero is itself `workflowInvalid`. */
	readonly jobCount?: number;
	/** The failing step's name, for the two rows that key off one. */
	readonly failingStepName?: string | null;
	/** The job's billable minutes, for `timeout`'s detail. */
	readonly minutes?: number;
	/** Failing smoke rows from the result artifact, for `verificationFailed`. */
	readonly verification?: { readonly failed: number; readonly total: number } | null;
}

/** One classification. */
export interface BuildFailure {
	readonly class: BuildFailureClass;
	readonly detail?: Record<string, unknown>;
	/** The bounded, redacted excerpt — see the file docstring. */
	readonly excerpt: string[];
}

/** `EW_MISSING:<NAME>` — the workflow's own first-step refusal. */
const MISSING_VALUE = /EW_MISSING:([A-Za-z0-9_]+)/g;
/** `EW_SECRET_IN_IMAGE:<NAME>` — §4.11's secret-in-image check. */
const SECRET_IN_IMAGE = /EW_SECRET_IN_IMAGE:([A-Za-z0-9_]+)/g;

/**
 * A git sha (40) or a sha256 digest (64), lowercase hex, and nothing else.
 *
 * Both survive {@link maskSecretShapes} — see its docstring for why they are
 * named rather than left to a length threshold.
 */
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** The BuildKit step line a Dockerfile failure names: `#12 [builder 3/7] RUN …`. */
const BUILDKIT_STEP = /^#\d+\s+\[([^\]]*?)\s+(\d+)\/(\d+)\]\s+(.*)$/;

/** Every row's signal, in the plan's order. `null` means "this row needs more than the log". */
const SIGNALS: ReadonlyArray<{ readonly cls: BuildFailureClass; readonly patterns: readonly RegExp[] }> = [
	{ cls: 'timeout', patterns: [/exceeded the maximum execution time/i] },
	{
		cls: 'outOfMemory',
		patterns: [
			/exit code:\s*137/i,
			/^\s*Killed\s*$/im,
			/JavaScript heap out of memory/i,
			/Reached heap limit/i,
			/\bENOMEM\b/i
		]
	},
	{ cls: 'diskFull', patterns: [/No space left on device/i, /\bENOSPC\b/i] },
	{
		cls: 'dependencyDownloadFailed',
		patterns: [
			/\bETIMEDOUT\b/i,
			/\bECONNRESET\b/i,
			/\bEAI_AGAIN\b/i,
			/TLS handshake timeout/i,
			/429 Too Many Requests/i,
			/\btoomanyrequests\b/i
		]
	},
	{ cls: 'dockerfileError', patterns: [/ERROR: failed to solve/i, /dockerfile parse error/i] }
];

/** Every distinct capture of `pattern` in `log`, in order, without duplicates. */
function namesIn(log: string, pattern: RegExp): string[] {
	const names = new Set<string>();
	for (const match of log.matchAll(pattern)) {
		if (match[1]) names.add(match[1]);
	}
	return [...names];
}

/** The index of the first line matching `pattern`, or `-1`. */
function lineIndexOf(lines: readonly string[], patterns: readonly RegExp[]): number {
	for (let index = 0; index < lines.length; index += 1) {
		if (patterns.some((pattern) => pattern.test(lines[index]))) return index;
	}
	return -1;
}

/**
 * The twenty lines ending at `matchedIndex`, bounded and masked.
 *
 * `redact` runs first (it knows this Work's real values), then the shape mask
 * (it catches what nobody registered). Line truncation happens BEFORE masking
 * on purpose: a 4,000-character line with a token at the end would otherwise be
 * cut to 300 characters and the mask never see it — except the cut happens
 * first, so the token is gone with the rest of the line. Both orders are safe
 * here; this one is also cheaper.
 */
export function buildExcerpt(
	lines: readonly string[],
	matchedIndex: number,
	redact: (text: string) => string
): string[] {
	const end = matchedIndex >= 0 ? matchedIndex + 1 : lines.length;
	const start = Math.max(0, end - EXCERPT_MAX_LINES);
	return lines
		.slice(start, end)
		.map((line) => line.slice(0, EXCERPT_MAX_LINE_CHARS))
		.map((line) => maskSecretShapes(redact(line)));
}

/**
 * Mask what LOOKS like a credential, whatever it is.
 *
 * The shapes are the ones that appear in build output and can never be anything
 * else: GitHub's own token prefixes, a `Bearer` header, an
 * `AWS_SECRET_ACCESS_KEY`-style assignment, a URL with inline credentials, and
 * a long base64 run.
 *
 * ## The one exception, and why it is spelled out rather than approximated
 *
 * A **git sha** (40 lowercase hex) and a **sha256 digest** (64) are excluded by
 * name. Both are longer than the 40-character bound the base64 rule uses, so a
 * length threshold alone masks them — the first draft of this function claimed
 * "40 characters is conservative enough to spare git shas" and its own spec
 * disproved it on the first run. They are also the two most useful strings in a
 * build log: the commit that was built and the image that came out. A log
 * excerpt that masks both tells the member nothing.
 *
 * Neither is a credential: a sha is a public identifier of public content, and
 * a digest is what the registry itself publishes.
 */
export function maskSecretShapes(line: string): string {
	return line
		.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '***')
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***')
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 ***')
		.replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|APIKEY|API_KEY)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, '$1=***')
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s:/@]+@/gi, '$1***:***@')
		.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, (run) => (GIT_OBJECT_ID.test(run) ? run : '***'));
}

/**
 * Classify one failing job.
 *
 * Every row is evaluated in the plan's order and the first match wins. The
 * excerpt always ends at the line that decided the class, so a member reading
 * it sees the evidence rather than the teardown — except for `unknown`, where
 * there is no matched line and the last twenty are the best available answer.
 */
export function classifyFailure(
	input: ClassifyFailureInput,
	redact: (text: string) => string = (text) => text
): BuildFailure {
	const log = input.log ?? '';
	const lines = log.split(/\r?\n/);

	// 1 · missingBuildValue — the workflow's first step, before anything built.
	const missing = namesIn(log, MISSING_VALUE);
	if (missing.length > 0) {
		return {
			class: 'missingBuildValue',
			detail: { names: missing },
			excerpt: buildExcerpt(lines, lineIndexOf(lines, [/EW_MISSING:/]), redact)
		};
	}

	// 2 · secretInImage — §4.11's check found a registered value in the image.
	const leaked = namesIn(log, SECRET_IN_IMAGE);
	if (leaked.length > 0) {
		return {
			class: 'secretInImage',
			detail: { names: leaked },
			excerpt: buildExcerpt(lines, lineIndexOf(lines, [/EW_SECRET_IN_IMAGE:/]), redact)
		};
	}

	// 3 · timeout — the conclusion, or the runner's own message.
	const timedOutByConclusion = input.jobConclusion === 'timed_out';
	const timedOutByMessage = lineIndexOf(lines, [/exceeded the maximum execution time/i]);
	if (timedOutByConclusion || timedOutByMessage >= 0) {
		return {
			class: 'timeout',
			...(typeof input.minutes === 'number' ? { detail: { minutes: input.minutes } } : {}),
			excerpt: buildExcerpt(lines, timedOutByMessage, redact)
		};
	}

	// 4 · workflowInvalid — the run never started, or produced no jobs at all.
	if (input.runConclusion === 'startup_failure' || input.jobCount === 0) {
		return { class: 'workflowInvalid', excerpt: buildExcerpt(lines, -1, redact) };
	}

	// 5-9 · the log signals, in the plan's order. `outOfMemory` deliberately
	// precedes `dockerfileError`: see the file docstring.
	for (const { cls, patterns } of SIGNALS) {
		if (cls === 'timeout') continue; // handled above, with its conclusion half
		const index = lineIndexOf(lines, patterns);
		if (index < 0) continue;

		if (cls === 'dockerfileError') {
			return {
				class: 'dockerfileError',
				detail: dockerfileDetail(lines),
				excerpt: buildExcerpt(lines, index, redact)
			};
		}
		return { class: cls, excerpt: buildExcerpt(lines, index, redact) };
	}

	// 10 · verificationFailed — the runner's own smoke rows, from the artifact.
	if (
		(input.failingStepName ?? '').toLowerCase().includes('verify in the runner') &&
		input.verification &&
		input.verification.failed > 0
	) {
		return {
			class: 'verificationFailed',
			detail: { failed: input.verification.failed, total: input.verification.total },
			excerpt: buildExcerpt(lines, -1, redact)
		};
	}

	// 11 · unknown — the last twenty lines, because there is no matched one.
	return { class: 'unknown', excerpt: buildExcerpt(lines, -1, redact) };
}

/** `#12 [builder 3/7] RUN npm ci` → `{ step: 3, total: 7, command: 'RUN npm ci', dockerfile: 'builder' }`. */
function dockerfileDetail(lines: readonly string[]): Record<string, unknown> {
	// The LAST BuildKit step line before the error is the failing one: BuildKit
	// prints each step as it starts, so the most recent one is the step that was
	// running when it gave up.
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const match = BUILDKIT_STEP.exec(lines[index].trim());
		if (!match) continue;
		return {
			dockerfile: match[1],
			step: Number(match[2]),
			total: Number(match[3]),
			command: match[4].slice(0, 120)
		};
	}
	return {};
}
