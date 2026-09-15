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
 * The pattern table and the three pure helpers (`scanForSecrets`,
 * `containsSecret`, `redactSecrets`) live in `@ever-works/contracts`
 * (`secret/secret-patterns.ts`), so the node app — which depends on the
 * contracts package and never on this one — scans with the IDENTICAL
 * definition before anything it captures leaves a user's machine. They
 * are re-exported here unchanged, so every existing importer of this
 * module keeps working without an edit. Only `assertNoSecrets` stays
 * local: it is the one helper that needs NestJS.
 */

import { BadRequestException } from '@nestjs/common';
import { scanForSecrets } from '@ever-works/contracts';

export { containsSecret, redactSecrets, scanForSecrets } from '@ever-works/contracts';
export type { SecretMatch } from '@ever-works/contracts';

/**
 * Hard-reject helper for the AgentFileService / SkillsService write
 * path: throws a precise error message that surfaces the pattern
 * name and (truncated) sample so the user can find + fix the
 * offending content without us leaking the full secret back.
 *
 * Security (EW-716 follow-up): throws BadRequestException, NOT a plain
 * Error — a plain Error is unmapped by Nest's exception layer and
 * surfaced as an HTTP 500 to every caller endpoint (task-chat POST/
 * PATCH, agent-file writes, skill bodies, agent import), which both
 * mislabels a user-input rejection as a server fault and risks raw-
 * message/stack exposure through generic 500 handling. The message is
 * already safe to return: the sample is display-truncated upstream.
 */
export function assertNoSecrets(body: string, fieldHint = 'body'): void {
    const hits = scanForSecrets(body);
    if (hits.length === 0) return;
    const first = hits[0];
    throw new BadRequestException(
        `Secret-like value (${first.pattern}: "${first.matched}") detected in ${fieldHint}. ` +
            `Remove it before saving — credentials must live in plugin settings, not in Agent files or Skill bodies.`,
    );
}
