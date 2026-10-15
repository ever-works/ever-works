/**
 * Trusted review bots (self-build fleet, finding R16) — the pure half of
 * the GitHub bridge's reviewer policy. No Nest, no I/O: everything here is
 * a function of a webhook body and the operator's allow-list, so the
 * bridge spec can pin each rule with the literal bodies the bots post.
 *
 * ## Why a class of reviewer rather than a boolean
 *
 * The bridge used to drop EVERY `user.type === 'Bot'` review and comment
 * on one principle: the loop must never treat its own output as human
 * feedback. That principle is right, and it filtered out the wrong
 * thing along with it — CodeRabbit, Copilot, Codex and Greptile verdicts
 * never became Task feedback, so a human had to relay every finding by
 * hand. The four classes below keep the security property (`self` wins
 * over everything, including an operator who lists the platform's own
 * login as trusted) while letting an allow-listed reviewer bot speak.
 *
 * ## Severity
 *
 * The house rule is "fix P2+ before declaring a PR clean". The bots each
 * mark severity differently, all on the FIRST line of a finding, so the
 * parser reads the head of the body only and maps every scale onto one:
 *
 *   * CodeRabbit  `_🗄️ Data Integrity & Integration_ | _🟠 Major_ | _🏗️ Heavy lift_`
 *                 (`_🔴 Critical_` / `_🟡 Minor_` are the other two);
 *   * Codex       `**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Title**`;
 *   * Greptile    `<a href="#"><img alt="P2" src="…/badges/p2.svg?v=9" align="top"></a> text`;
 *   * Copilot     plain prose, no marker → `null` ("severity unknown").
 *
 * `P1` (and `P0`) map to `critical`, `P2` to `major`, `P3` to `minor`, so
 * "P2+" is exactly `critical | major` on every bot.
 *
 * ## Which comments are findings
 *
 * Being allow-listed says who may speak, not that everything said is a
 * finding. {@link classifyReviewBotComment} decides whether one trusted
 * bot COMMENT is review feedback at all — CodeRabbit's "review in
 * progress" placeholder, its walkthrough summary, command
 * acknowledgements and limit notices are not, and each one recorded is a
 * full model run on a fleet PC.
 */

export type ReviewBotSeverity = 'critical' | 'major' | 'minor';

/**
 * Who submitted a review or comment, as far as the bridge cares:
 *
 *   * `human`         — not a bot account; today's behaviour, unchanged.
 *   * `self`          — the platform's own GitHub App identity. Dropped
 *                       unconditionally: the loop must not echo itself.
 *   * `trusted-bot`   — an allow-listed reviewer bot. Recorded as
 *                       rejection feedback, never reviewed.
 *   * `untrusted-bot` — any other bot (`dependabot[bot]`,
 *                       `github-actions[bot]`, …). Dropped.
 */
export type ReviewerClass = 'human' | 'trusted-bot' | 'self' | 'untrusted-bot';

export interface ReviewerIdentity {
    login?: string;
    type?: string;
}

/** Lower-cased login sets the bridge resolves once per delivery. */
export interface ReviewBotPolicy {
    readonly trusted: ReadonlySet<string>;
    readonly self: ReadonlySet<string>;
}

/**
 * Canonical form of a GitHub login for allow-list comparison: GitHub
 * logins are case-insensitive, and an operator pasting `@coderabbitai`
 * from a PR thread should not be punished for the `@`.
 */
export function normalizeReviewerLogin(login: string | null | undefined): string {
    return (login ?? '').trim().replace(/^@/, '').toLowerCase();
}

/**
 * Classify a review / comment author. `self` is checked BEFORE `trusted`
 * on purpose: that ordering is the security property. Adding the app's
 * own `<slug>[bot]` login to `GITHUB_TRUSTED_REVIEW_BOTS` changes nothing.
 */
export function classifyReviewer(
    user: ReviewerIdentity | null | undefined,
    policy: ReviewBotPolicy,
): ReviewerClass {
    if (!user || (user.type ?? '').toLowerCase() !== 'bot') return 'human';
    const login = normalizeReviewerLogin(user.login);
    // A bot with no login cannot be on any list, so it cannot be trusted.
    if (login.length === 0) return 'untrusted-bot';
    if (policy.self.has(login)) return 'self';
    if (policy.trusted.has(login)) return 'trusted-bot';
    return 'untrusted-bot';
}

/**
 * The `author_association` values GitHub stamps on a review or comment
 * whose author can steer a fleet run: the repository owner, a member of
 * the owning organization, and an invited collaborator. Everyone else —
 * `CONTRIBUTOR` (a merged PR once), `FIRST_TIME_CONTRIBUTOR`,
 * `FIRST_TIMER`, `MANNEQUIN`, `NONE`, and a missing value — is an
 * outsider.
 */
export const STEERING_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set([
    'OWNER',
    'MEMBER',
    'COLLABORATOR',
]);

/**
 * Who wrote a review / comment, once the repository relationship of a
 * HUMAN author is known: {@link ReviewerClass}, plus `outside-human` for
 * a person with no write relationship to the repository.
 */
export type ReviewAuthorClass = ReviewerClass | 'outside-human';

/**
 * Classify the author of a `pull_request_review` (`body.review`) or of a
 * comment (`body.comment`) — both carry `user` and `author_association`.
 *
 * A public repository accepts a "Request changes" review, or a comment,
 * from ANY GitHub account. Before this, every non-bot was `human`, so a
 * stranger's review on a fleet-made pull request became rejection
 * feedback, and the CI-feedback / fix loop resumed the agent on the
 * owner's PC with that stranger's text as its instructions — a prompt
 * injection with somebody else's model bill attached. A human steers a
 * run only as an OWNER, MEMBER or COLLABORATOR of the repository; any
 * other association, or none at all, is `outside-human` (fail closed).
 *
 * Bot classification is untouched and comes first, so `self` still wins
 * over everything and a trusted reviewer bot (whose association is
 * typically `NONE`) is still a trusted reviewer bot.
 */
export function classifyReviewAuthor(
    author:
        | { user?: ReviewerIdentity | null; author_association?: string | null }
        | null
        | undefined,
    policy: ReviewBotPolicy,
): ReviewAuthorClass {
    const who = classifyReviewer(author?.user, policy);
    if (who !== 'human') return who;
    const association = (author?.author_association ?? '').trim().toUpperCase();
    return STEERING_AUTHOR_ASSOCIATIONS.has(association) ? 'human' : 'outside-human';
}

/** Severity markers sit on the first line; this is more than enough of it. */
const SEVERITY_SCAN_CHARS = 600;

/** CodeRabbit: `_🟠 Major_` — an italic cell, optionally led by an emoji. */
const CODERABBIT_SEVERITY = /_\s*(?:\S+\s+)?(critical|major|minor)\s*_/i;

/** Codex: a shields.io badge image named `P<n> Badge`. */
const CODEX_SEVERITY = /!\[P([0-3]) Badge\]/i;

/** Greptile: an `<img alt="P<n>">` badge. */
const GREPTILE_SEVERITY = /<img\b[^>]*\balt="P([0-3])"/i;

function priorityToSeverity(priority: string): ReviewBotSeverity | null {
    switch (priority) {
        case '0':
        case '1':
            return 'critical';
        case '2':
            return 'major';
        case '3':
            return 'minor';
        default:
            return null;
    }
}

/**
 * The severity a reviewer bot tagged a finding with, or `null` when the
 * body carries no recognisable marker. Never guesses from prose.
 */
export function parseReviewBotSeverity(body: string | null | undefined): ReviewBotSeverity | null {
    const head = (body ?? '').slice(0, SEVERITY_SCAN_CHARS);
    const coderabbit = CODERABBIT_SEVERITY.exec(head);
    if (coderabbit) return coderabbit[1].toLowerCase() as ReviewBotSeverity;
    const codex = CODEX_SEVERITY.exec(head);
    if (codex) return priorityToSeverity(codex[1]);
    const greptile = GREPTILE_SEVERITY.exec(head);
    if (greptile) return priorityToSeverity(greptile[1]);
    return null;
}

/**
 * The review / usage LIMIT notices among the status chatter below, named
 * on their own so {@link classifyReviewBotComment} can say which kind of
 * chatter it saw. {@link NOISE_MARKERS} spreads this list, so the two
 * cannot drift apart.
 */
const RATE_LIMIT_MARKERS: readonly RegExp[] = [
    /rate limited by coderabbit\.ai/i,
    // `[ \t]` and an optional `>` GROUP, never `\s*>?\s*`: `\s` crosses
    // newlines and the two adjacent `\s*` split any whitespace run every
    // possible way, so a body of a few thousand blank lines took MINUTES
    // to test (4 000 chars: 58 s, measured) — on the webhook path, which
    // blocks the event loop. Same matches on every real notice.
    /^[ \t]*(?:>[ \t]*)?#{1,6}[ \t]*Review limit reached/im,
    /reached your Codex usage limits/i,
];

/**
 * Status chatter the bots post that carries no finding: rate-limit
 * notices, "too many files" refusals, usage-cap messages. Recording these
 * would seed a resumed run with an instruction to do nothing.
 */
const NOISE_MARKERS: readonly RegExp[] = [
    ...RATE_LIMIT_MARKERS,
    /<!--\s*greptile-status\s*-->/i,
    /Too many files changed for review/i,
];

/** `**Actionable comments posted: 0**` with nothing else left to say. */
const NOTHING_ACTIONABLE = /^\**\s*Actionable comments posted:\s*0\s*\**$/i;

export function isReviewBotNoise(body: string | null | undefined): boolean {
    const text = body ?? '';
    if (NOISE_MARKERS.some((marker) => marker.test(text))) return true;
    return NOTHING_ACTIONABLE.test(stripReviewBotMarkup(text));
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * One `<details>` block that contains no nested `<details>`. Applied until
 * nothing changes so nested blocks (CodeRabbit nests its static-analysis
 * logs two deep) unwind from the inside out.
 */
const INNERMOST_DETAILS = /<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/gi;

/** `![P1 Badge](https://…)` — pure decoration once the severity is parsed. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

/**
 * Presentation tags the bots wrap findings in. Deliberately a fixed list
 * rather than "any tag": `Promise<void>` in a code sample must survive.
 */
const HTML_TAG =
    /<\/?(?:a|img|sub|sup|br|hr|p|div|span|h[1-6]|b|i|strong|em|blockquote|summary|table|thead|tbody|tr|td|th|kbd|picture|source)\b[^>]*>/gi;

/**
 * Reduce a bot body to the words a Task can act on. CodeRabbit's inline
 * findings carry up to ~33 KB of collapsed static-analysis output; the
 * 4000-character feedback cap would otherwise be spent entirely on that
 * and never reach the finding itself.
 */
export function stripReviewBotMarkup(body: string | null | undefined): string {
    let text = (body ?? '').replace(HTML_COMMENT, '');
    let previous: string;
    do {
        previous = text;
        text = text.replace(INNERMOST_DETAILS, '');
    } while (text !== previous);
    text = text.replace(MARKDOWN_IMAGE, '').replace(HTML_TAG, '');
    return text
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Label an inline (diff-anchored) finding with where it points, so the
 * resumed run can open the file instead of guessing which of its changes
 * the reviewer meant. `line` is the position on the CURRENT diff;
 * `original_line` is the fallback GitHub keeps when the line moved.
 */
export function formatInlineFinding(
    comment: { path?: string; line?: number | null; original_line?: number | null },
    text: string,
): string {
    const body = text.trim();
    if (body.length === 0) return '';
    const path = (comment.path ?? '').trim();
    if (path.length === 0) return body;
    const line = comment.line ?? comment.original_line;
    const location = typeof line === 'number' ? `${path}:${line}` : path;
    return `${location} — ${body}`;
}

/**
 * Why a trusted reviewer bot's COMMENT was not recorded as rejection
 * feedback (and must not wake the fix loop). See
 * {@link classifyReviewBotComment}.
 *
 *   * `not-created`        — an `edited` / `deleted` delivery. A finding is
 *                            new exactly once, when it is created; the bots
 *                            edit the SAME comment over and over (CodeRabbit
 *                            rewrites its summary on every push), and each
 *                            edit recorded would be a duplicate row and a
 *                            duplicate model run.
 *   * `in-progress`        — CodeRabbit's "Currently processing new
 *                            changes" placeholder.
 *   * `nothing-actionable` — "No actionable comments were generated".
 *   * `rate-limited`       — a review / usage limit notice.
 *   * `command-ack`        — CodeRabbit acknowledging an `@coderabbitai`
 *                            command ("Review finished", "Review rate
 *                            limited", "Already reviewed the last commit").
 *   * `summary`            — a walkthrough / summary / test-run digest that
 *                            carries no finding of its own.
 *   * `status`             — other status chatter (review skipped, too many
 *                            files, the bot's own failure notice).
 *   * `empty`              — nothing left once presentation markup is
 *                            stripped.
 */
export type ReviewBotCommentIgnoreReason =
    | 'not-created'
    | 'in-progress'
    | 'nothing-actionable'
    | 'rate-limited'
    | 'command-ack'
    | 'summary'
    | 'status'
    | 'empty';

export type ReviewBotCommentVerdict =
    | { readonly kind: 'findings' }
    | { readonly kind: 'ignore'; readonly reason: ReviewBotCommentIgnoreReason };

/**
 * Every structural marker below must START a line (optionally inside a
 * `>` block quote), which is where the bots print them. A finding that
 * QUOTES a marker — in a code span, mid-sentence, as a reviewer of this
 * very file would — therefore stays a finding instead of being mistaken
 * for the chatter it names.
 */
const LINE_START = '^[ \\t]*(?:>[ \\t]*)?';

/**
 * A fenced code block (```` ``` ```` or `~~~`, optionally inside a `>`
 * block quote), up to its closing fence or the end of the body. Removed
 * before any marker is matched, so a marker QUOTED on a line of its own
 * inside a code sample is not mistaken for the real one either. The bots'
 * own markers never sit inside a fence (CodeRabbit's placeholder carries
 * an ```` ```ascii ```` banner, but its markers are outside it).
 *
 * As in CommonMark, a block closes only on a fence of the SAME character,
 * at least as long as the opener, with nothing but whitespace after it —
 * one alternative per character, so a ```` ```~~~ ```` line inside a
 * backtick block does not close it early.
 */
const FENCED_CODE_BLOCK =
    /^[ \t]*(?:>[ \t]*)?(?:(`{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*(?:>[ \t]*)?\1`*[ \t]*$|(?![\s\S]))|(~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*(?:>[ \t]*)?\2~*[ \t]*$|(?![\s\S])))/gm;

/**
 * CodeRabbit stamps every machine-generated block with an HTML comment of
 * the form `<!-- This is an auto-generated comment: <kind> by coderabbit.ai -->`.
 * Those markers — not the prose around them, which CodeRabbit rewords
 * freely — are what the classifier keys on.
 */
function coderabbitMarker(kind: string): RegExp {
    return new RegExp(
        `${LINE_START}<!--\\s*This is an auto-generated comment: ${kind} by coderabbit\\.ai\\s*-->`,
        'im',
    );
}

/** The per-PR summary comment CodeRabbit creates once and edits forever. */
const CODERABBIT_SUMMARY = coderabbitMarker('summarize');

/** Its first revision: the "review in progress" placeholder. */
const CODERABBIT_IN_PROGRESS = coderabbitMarker('review in progress');

/**
 * …and the visible sentence inside it, should the marker ever be dropped —
 * matched only in the exact shape CodeRabbit prints: the first line of a
 * `> [!NOTE]` callout. A finding that QUOTES the sentence — mid-line, in
 * its own `>` block quote, or in a code sample — is therefore not
 * mistaken for the placeholder.
 */
const CODERABBIT_IN_PROGRESS_TEXT = new RegExp(
    `${LINE_START}\\[!NOTE\\][ \\t]*\\r?\\n${LINE_START}Currently processing new changes in this PR\\b`,
    'im',
);

/** A review skipped on purpose (draft PR, non-default base branch, …). */
const CODERABBIT_SKIPPED = coderabbitMarker('skip review');

/** The summary's verdict when the review produced nothing to fix. */
const CODERABBIT_NOTHING_ACTIONABLE = /\bNo actionable comments were generated\b/i;

/**
 * A plan-level limit notice posted as a reply instead of a review
 * ("Your [plan](…) includes PR reviews subject to [rate limits](…)").
 * Line-anchored for the same reason as the placeholder sentence.
 */
const CODERABBIT_PLAN_LIMIT = new RegExp(
    `${LINE_START}Your \\[?plan\\]?(?:\\([^)\\n]*\\))? includes PR reviews subject to \\[?rate limits\\b`,
    'im',
);

/**
 * CodeRabbit answering a command collapses its verdict into
 * `<summary>✅ Action performed</summary>` or
 * `<summary>⚠️ Action not completed</summary>`.
 */
const CODERABBIT_COMMAND_ACK = new RegExp(
    `${LINE_START}<summary>[^<\\n]*\\bAction (?:performed|not completed)[ \\t]*</summary>`,
    'im',
);

/**
 * A chat answer that actually reasoned about the code carries a
 * `<summary>🧩 Analysis chain</summary>` block; it may END with a command
 * acknowledgement, and it is still an answer, so it is never an ack.
 */
const CODERABBIT_ANALYSIS = new RegExp(
    `${LINE_START}<summary>[^<\\n]*\\bAnalysis chain[ \\t]*</summary>`,
    'im',
);

/** Greptile's per-PR summary comment (edited on every review). */
const GREPTILE_SUMMARY = new RegExp(`${LINE_START}<!--\\s*greptile_summary\\s*-->`, 'im');

/** Greptile's TREX (test-run) summary comment. */
const GREPTILE_TREX_SUMMARY = new RegExp(`${LINE_START}<!--\\s*greptile_trex_summary\\s*-->`, 'im');

/** A TREX run that found nothing to fix, or could not run at all. */
const GREPTILE_TREX_NOTHING = /\b(?:found no issues|No flows tested)\b/i;

/**
 * A Greptile finding badge anywhere in the body (`<img alt="P1" …>`). The
 * scan inside the tag is bounded so a run of unclosed `<img` stays linear.
 */
const GREPTILE_FINDING_BADGE = /<img\b[^>]{0,1000}\balt="P[0-3]"/i;

/**
 * Does this trusted reviewer bot's COMMENT carry a review finding?
 *
 * The bridge used to record every allow-listed bot comment that survived
 * the status-chatter filter, and on 2026-10-09 the first fleet-made PR
 * (ever-works/ever-works#2575) paid for it: CodeRabbit's automatic
 * "Currently processing new changes in this PR" placeholder became a
 * rejection row, the fix loop resumed the agent on a fleet PC, and the
 * agent correctly concluded there was nothing to do. A full model run for
 * a progress bar — and Greptile's "safe to merge" summary on the same PR
 * was the same shape.
 *
 * So the rule is the other way round now: a bot comment is feedback only
 * when it is a NEW comment that is not one of the bots' own machine
 * shapes. Everything below was read off this repository's PR history with
 * `gh api` (issue comments, inline comments, and the GraphQL
 * `userContentEdits` history of the #2575 summary); the fixture corpus in
 * `__fixtures__/review-bot-comments.json` is the literal set.
 *
 * What is deliberately NOT here: a guess from prose. An inline finding
 * that happens to say "walkthrough" or "rate limit" is still a finding —
 * only the bots' machine markers, and a handful of fixed sentences they
 * print verbatim, can make a comment chatter. Unknown shapes from a
 * trusted bot stay findings, exactly as before.
 *
 * Pure: a function of the delivery's `action` and the comment body.
 */
export function classifyReviewBotComment(input: {
    action?: string | null;
    body?: string | null;
}): ReviewBotCommentVerdict {
    const ignore = (reason: ReviewBotCommentIgnoreReason): ReviewBotCommentVerdict => ({
        kind: 'ignore',
        reason,
    });

    // A finding is new once. Every later delivery for the same comment
    // id is an edit of something already seen (or never worth seeing).
    if ((input.action ?? '').trim().toLowerCase() !== 'created') return ignore('not-created');

    const raw = input.body ?? '';
    // Every marker below is matched OUTSIDE fenced code: a finding that
    // shows a marker on a line of its own inside a ``` sample is quoting
    // it, not being it.
    const body = raw.replace(FENCED_CODE_BLOCK, '');

    // The placeholder is checked FIRST: its first revision also carries
    // the summary marker, and "in progress" is the more precise reason.
    if (CODERABBIT_IN_PROGRESS.test(body) || CODERABBIT_IN_PROGRESS_TEXT.test(body)) {
        return ignore('in-progress');
    }
    if (
        RATE_LIMIT_MARKERS.some((marker) => marker.test(body)) ||
        CODERABBIT_PLAN_LIMIT.test(body)
    ) {
        return ignore('rate-limited');
    }
    if (CODERABBIT_COMMAND_ACK.test(body) && !CODERABBIT_ANALYSIS.test(body)) {
        return ignore('command-ack');
    }
    if (CODERABBIT_SUMMARY.test(body)) {
        if (CODERABBIT_NOTHING_ACTIONABLE.test(body)) return ignore('nothing-actionable');
        if (CODERABBIT_SKIPPED.test(body)) return ignore('status');
        // A walkthrough, a pre-merge check table, a merge-risk note, a
        // tool-failure appendix: CodeRabbit's findings arrive as review
        // comments, never inside this one.
        return ignore('summary');
    }
    // Greptile's summary restates its inline findings with a P-badge each
    // (and those inline comments are recorded on their own); one with no
    // badge at all is a "safe to merge" digest.
    if (GREPTILE_SUMMARY.test(body) && !GREPTILE_FINDING_BADGE.test(body)) {
        return ignore('summary');
    }
    if (GREPTILE_TREX_SUMMARY.test(body) && GREPTILE_TREX_NOTHING.test(body)) {
        return ignore('summary');
    }
    if (isReviewBotNoise(body)) {
        return NOTHING_ACTIONABLE.test(stripReviewBotMarkup(body))
            ? ignore('nothing-actionable')
            : ignore('status');
    }
    // The RAW body here: a finding that is nothing but a code sample is
    // still a finding.
    if (stripReviewBotMarkup(raw).length === 0) return ignore('empty');
    return { kind: 'findings' };
}
