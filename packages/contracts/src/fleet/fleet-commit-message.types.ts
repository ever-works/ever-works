/**
 * Fleet commit messages (10-09 handover §3 item 7).
 *
 * Every fleet commit used to read `feat(task): T-2 agent run output` — the
 * same subject for a typo fix, a docs page and a new feature, which made the
 * history of a self-built repository unreadable and every release note a
 * guess. A commit message now says what the change IS:
 *
 *  - the subject comes from the Task TITLE, as a conventional commit whose
 *    type is read from the title (`Fix login redirect` → `fix: …`), or kept
 *    when the title already is one (`docs(api): …`);
 *  - the Task slug moves to the body (`Task: T-13`), where it is still
 *    searchable but no longer pretends to be the summary;
 *  - and once the change exists, the node RE-TYPES it from what was actually
 *    staged: a docs-only change is `docs`, a tests-only change is `test`,
 *    whatever the title said.
 *
 * Pure and dependency-free so the planner (which writes the message into the
 * job) and the node (which re-types it at commit time) share one rule.
 */

/** The conventional-commit types a fleet commit may carry. */
export const FLEET_COMMIT_TYPES = [
	'feat',
	'fix',
	'docs',
	'test',
	'refactor',
	'perf',
	'chore',
	'ci',
	'build',
	'style',
	'revert'
] as const;

export type FleetCommitType = (typeof FLEET_COMMIT_TYPES)[number];

/** Subject lines longer than this are cut at a word boundary. */
export const FLEET_COMMIT_SUBJECT_MAX_LENGTH = 72;

const CONVENTIONAL_SUBJECT = /^([a-z]+)(\([^)\n]{1,40}\))?(!)?:\s+(\S.*)$/;

/** Title keyword → type. First match wins; checked against the title's FIRST words. */
const TITLE_TYPE_RULES: ReadonlyArray<{ pattern: RegExp; type: FleetCommitType }> = [
	{ pattern: /^(?:fix(?:es|ed)?|bug ?fix|hot ?fix|repair|resolve[sd]?|correct)\b/i, type: 'fix' },
	{ pattern: /^(?:refactor|clean ?up|simplify|restructure|reorgani[sz]e|extract|rename)\b/i, type: 'refactor' },
	{ pattern: /^(?:docs?|document(?:ation)?|readme|write (?:the )?docs?)\b/i, type: 'docs' },
	{ pattern: /^(?:tests?|add (?:unit |e2e |integration )?tests?|cover|increase coverage)\b/i, type: 'test' },
	{ pattern: /^(?:perf|optimi[sz]e|speed up|improve performance)\b/i, type: 'perf' },
	{ pattern: /^(?:ci|pipeline|github actions?|workflow)\b/i, type: 'ci' },
	{ pattern: /^(?:build|bundle|packag(?:e|ing))\b/i, type: 'build' },
	{ pattern: /^(?:chore|bump|upgrade|update (?:deps|dependencies)|deps?)\b/i, type: 'chore' },
	{ pattern: /^(?:style|format|lint)\b/i, type: 'style' },
	{ pattern: /^revert\b/i, type: 'revert' },
	// Anywhere in the title, but only for the unmistakable ones.
	{ pattern: /\b(?:bug|crash(?:es|ing)?|broken|regression|fails?|failing)\b/i, type: 'fix' }
];

/** Type a Task title implies, `feat` when it implies nothing. */
export function fleetCommitTypeFromTitle(title: string | null | undefined): FleetCommitType {
	const clean = cleanText(title);
	if (!clean) return 'feat';
	const conventional = CONVENTIONAL_SUBJECT.exec(clean);
	if (conventional && isFleetCommitType(conventional[1])) return conventional[1];
	for (const rule of TITLE_TYPE_RULES) {
		if (rule.pattern.test(clean)) return rule.type;
	}
	return 'feat';
}

export function isFleetCommitType(value: unknown): value is FleetCommitType {
	return typeof value === 'string' && (FLEET_COMMIT_TYPES as readonly string[]).includes(value);
}

/**
 * The commit message a Task's run commits with:
 *
 * ```
 * fix: login redirect loses the return URL
 *
 * Task: T-13
 * ```
 *
 * A title that already is a conventional commit is kept as written (scope
 * included). Without a title the subject still says what it is — the run's
 * output for that Task — rather than inventing a summary.
 */
export function composeFleetTaskCommitMessage(input: { title?: string | null; slug?: string | null }): string {
	const slug = cleanText(input.slug).slice(0, 64);
	const title = cleanText(input.title);
	const conventional = title ? CONVENTIONAL_SUBJECT.exec(title) : null;
	let subject: string;
	if (conventional && isFleetCommitType(conventional[1])) {
		subject = `${conventional[1]}${conventional[2] ?? ''}${conventional[3] ?? ''}: ${conventional[4]}`;
	} else if (title) {
		const type = fleetCommitTypeFromTitle(title);
		subject = `${type}: ${toSubjectText(stripLeadingTypeWord(title, type))}`;
	} else {
		subject = `feat: agent run output${slug ? ` for ${slug}` : ''}`;
	}
	const body: string[] = [];
	if (slug) body.push(`Task: ${slug}`);
	return body.length > 0 ? `${cutSubject(subject)}\n\n${body.join('\n')}` : cutSubject(subject);
}

/** What a set of changed paths is, for re-typing. */
export type FleetChangeClass = 'docs' | 'test' | 'mixed' | 'none';

/**
 * `docs` when every changed path is documentation, `test` when every one is a
 * test, `mixed` otherwise, `none` for no paths.
 */
export function classifyFleetChangedPaths(paths: readonly string[] | null | undefined): FleetChangeClass {
	const list = (paths ?? []).map((path) => path.replace(/\\/g, '/').trim()).filter(Boolean);
	if (list.length === 0) return 'none';
	if (list.every(isDocsPath)) return 'docs';
	if (list.every(isTestPath)) return 'test';
	return 'mixed';
}

/**
 * Re-type a conventional commit message from what was actually staged: a
 * docs-only change becomes `docs`, a tests-only change `test`. Only the type
 * token of the first line changes — scope, `!`, subject, body and trailers
 * are kept byte-for-byte. A message that is not conventional, or a mixed
 * change, is returned unchanged.
 */
export function retypeFleetCommitMessage(message: string, changedPaths: readonly string[] | null | undefined): string {
	if (typeof message !== 'string' || !message) return message;
	const newline = message.indexOf('\n');
	const firstLine = newline === -1 ? message : message.slice(0, newline);
	const rest = newline === -1 ? '' : message.slice(newline);
	const parsed = CONVENTIONAL_SUBJECT.exec(firstLine);
	if (!parsed) return message;
	const change = classifyFleetChangedPaths(changedPaths);
	const type: string | null = change === 'docs' ? 'docs' : change === 'test' ? 'test' : null;
	if (!type || parsed[1] === type) return message;
	return `${type}${firstLine.slice(parsed[1].length)}${rest}`;
}

// ─── internals ──────────────────────────────────────────────────────────

function cleanText(value: string | null | undefined): string {
	if (typeof value !== 'string') return '';
	// eslint-disable-next-line no-control-regex
	return value
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** `Fix login redirect` read as `fix:` → `login redirect`, so the type is not said twice. */
function stripLeadingTypeWord(title: string, type: FleetCommitType): string {
	if (type === 'feat') return title;
	const stripped = title.replace(
		/^(?:fix(?:es|ed)?|bug ?fix|hot ?fix|docs?|tests?|refactor|perf|chore|ci|build|style)(?: ?[:\-–—])? /i,
		''
	);
	return stripped || title;
}

function toSubjectText(text: string): string {
	// Trailing `.` / `!` / whitespace trimmed by hand: `/[.!\s]+$/` is
	// polynomial on a long inner run of whitespace (CodeQL).
	let end = text.length;
	while (end > 0 && '.! \t'.includes(text[end - 1]!)) end -= 1;
	let subject = text.slice(0, end);
	// Lower-case the first letter unless it starts an acronym / identifier ("API", "iOS").
	if (/^[A-Z][a-z]/.test(subject)) subject = subject.charAt(0).toLowerCase() + subject.slice(1);
	return subject || text;
}

function cutSubject(subject: string): string {
	const points = Array.from(subject);
	if (points.length <= FLEET_COMMIT_SUBJECT_MAX_LENGTH) return subject;
	const head = points.slice(0, FLEET_COMMIT_SUBJECT_MAX_LENGTH - 1).join('');
	const space = head.lastIndexOf(' ');
	return `${(space > 20 ? head.slice(0, space) : head).trimEnd()}…`;
}

const DOC_EXTENSIONS = /\.(?:md|mdx|markdown|rst|adoc|txt)$/i;
const DOC_DIRECTORY = /(?:^|\/)(?:docs?|documentation)\//i;
const DOC_FILENAMES =
	/(?:^|\/)(?:readme|changelog|contributing|license|licence|notice|authors|code_of_conduct)(?:\.[a-z]+)?$/i;

function isDocsPath(path: string): boolean {
	return DOC_EXTENSIONS.test(path) || DOC_DIRECTORY.test(path) || DOC_FILENAMES.test(path);
}

const TEST_FILE = /(?:^|[./_-])(?:spec|test|tests|e2e)\.[cm]?[jt]sx?$|_test\.(?:go|py|rb)$|(?:^|\/)test_[^/]+\.py$/i;
const TEST_DIRECTORY = /(?:^|\/)(?:__tests__|__snapshots__|__mocks__|__fixtures__|tests?|e2e|spec|fixtures)\//i;

function isTestPath(path: string): boolean {
	return TEST_FILE.test(path) || TEST_DIRECTORY.test(path) || /\.snap$/i.test(path);
}
