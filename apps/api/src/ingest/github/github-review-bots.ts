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
 * Status chatter the bots post that carries no finding: rate-limit
 * notices, "too many files" refusals, usage-cap messages. Recording these
 * would seed a resumed run with an instruction to do nothing.
 */
const NOISE_MARKERS: readonly RegExp[] = [
    /rate limited by coderabbit\.ai/i,
    /^\s*>?\s*#{1,6}\s*Review limit reached/im,
    /<!--\s*greptile-status\s*-->/i,
    /Too many files changed for review/i,
    /reached your Codex usage limits/i,
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
