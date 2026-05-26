/**
 * Secret-scan helper (architecture/security-agents-skills-tasks.md §6).
 *
 * Scans a candidate body string for known-credential patterns BEFORE
 * persisting it to:
 *   - Agent MD files (Phase 4 — AgentFileService.write).
 *   - Skill bodies (Phase 9 — SkillsService.upsert).
 *   - Task descriptions / chat messages (Phase 13 — TaskChatService.post).
 *
 * Two posture modes (per the spec):
 *   - `hard-reject`  → caller throws on any match (agent files,
 *                      skill bodies — deliberate authoring surfaces).
 *   - `redact`       → caller replaces matched spans with `[redacted
 *                      secret]` (task descriptions, chat — in-the-
 *                      moment input where rejecting is hostile).
 *
 * Patterns ride on the AI Conversation feature's existing regex plus
 * the additions explicitly listed in security spec §6:
 *
 *   - sk-…/key-…/token-…/Bearer … (generic OpenAI-ish + JWT-style)
 *   - AKIA…                (AWS access-key id)
 *   - ghp_…                (GitHub personal access token, classic)
 *   - gho_…                (GitHub OAuth token)
 *   - glpat-…              (GitLab personal access token)
 *   - xoxb-… / xoxp-…      (Slack bot / user tokens)
 *   - pat_…                (catch-all PAT prefix)
 *
 * The exact regexes are intentionally conservative (length floors) to
 * minimize false positives on prose that happens to contain "sk-" or
 * "token-". A real secret usually has ≥10 chars after the prefix.
 */

export interface SecretMatch {
    pattern: string;
    matched: string; // truncated for safe surfacing in error messages
    index: number;
}

const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
    {
        name: 'generic',
        re: /\b(sk-|key-|token-|Bearer\s+)[A-Za-z0-9_-]{10,}\b/g,
    },
    { name: 'aws_access_key', re: /\bAKIA[A-Z0-9]{16}\b/g },
    { name: 'github_pat_classic', re: /\bghp_[A-Za-z0-9]{36,}\b/g },
    { name: 'github_oauth', re: /\bgho_[A-Za-z0-9]{36,}\b/g },
    { name: 'gitlab_pat', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
    { name: 'slack_token', re: /\bxox[bp]-[A-Za-z0-9-]{10,}\b/g },
    { name: 'generic_pat', re: /\bpat_[A-Za-z0-9]{30,}\b/g },
];

/**
 * Scan `body` for secret patterns. Returns all matches across all
 * patterns; empty array means "clean".
 */
export function scanForSecrets(body: string): SecretMatch[] {
    if (!body) return [];
    const out: SecretMatch[] = [];
    for (const { name, re } of PATTERNS) {
        const r = new RegExp(re.source, re.flags); // fresh state per call
        let m: RegExpExecArray | null;
        while ((m = r.exec(body)) !== null) {
            out.push({
                pattern: name,
                matched: truncateForDisplay(m[0]),
                index: m.index,
            });
        }
    }
    return out;
}

/** True if any secret pattern matches. */
export function containsSecret(body: string): boolean {
    return scanForSecrets(body).length > 0;
}

/**
 * Hard-reject helper for the AgentFileService / SkillsService write
 * path: throws a precise error message that surfaces the pattern
 * name and (truncated) sample so the user can find + fix the
 * offending content without us leaking the full secret back.
 */
export function assertNoSecrets(body: string, fieldHint = 'body'): void {
    const hits = scanForSecrets(body);
    if (hits.length === 0) return;
    const first = hits[0];
    throw new Error(
        `Secret-like value (${first.pattern}: "${first.matched}") detected in ${fieldHint}. ` +
            `Remove it before saving — credentials must live in plugin settings, not in Agent files or Skill bodies.`,
    );
}

/**
 * Redact helper for chat / Task description writes — replaces every
 * matched span with `[redacted secret]`. Returns the cleaned body
 * AND the count of redactions so the caller can flag a toast.
 */
export function redactSecrets(body: string): { cleaned: string; redactions: number } {
    if (!body) return { cleaned: body, redactions: 0 };
    let cleaned = body;
    let count = 0;
    for (const { re } of PATTERNS) {
        const r = new RegExp(re.source, re.flags);
        cleaned = cleaned.replace(r, () => {
            count += 1;
            return '[redacted secret]';
        });
    }
    return { cleaned, redactions: count };
}

function truncateForDisplay(s: string): string {
    if (s.length <= 12) return s;
    return `${s.slice(0, 6)}…${s.slice(-3)}`;
}
