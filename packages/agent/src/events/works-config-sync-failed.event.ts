import { BaseEvent } from './base';
import type { WorksConfigSyncReason } from './works-config-sync-requested.event';
import { sanitizeDescription } from '../utils/sanitize.util';

// Security: max length for sanitized error messages stored in this event.
// Keeps payloads bounded and prevents leaking multi-kilobyte diagnostic blobs.
const ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * Security: strip credential-embedded URLs from git/network error messages
 * before they are stored in this event.  isomorphic-git and the GitHub API
 * client occasionally include the full remote URL — including OAuth tokens —
 * in thrown Error messages (e.g. "Failed to fetch:
 * https://ghp_xxx:x-oauth-basic@github.com/owner/repo").
 * Replace `userinfo@` with `[REDACTED]@` so the host/path context is
 * preserved for debugging while the secret is eliminated.
 */
function sanitizeErrorMessage(raw: string): string {
    // Replace credentials in URLs: https://user:secret@host → https://[REDACTED]@host
    const withoutUrlCredentials = raw.replace(
        /([a-zA-Z][a-zA-Z0-9+\-.]*:\/\/)[^/\s@:]+:[^/\s@]*@/g,
        '$1[REDACTED]@',
    );
    // sanitizeDescription: strips control chars, collapses whitespace, removes
    // newlines, and truncates to ERROR_MESSAGE_MAX_LENGTH.
    return sanitizeDescription(withoutUrlCredentials, ERROR_MESSAGE_MAX_LENGTH);
}

export class WorksConfigSyncFailedEvent extends BaseEvent {
    static EVENT_NAME = 'work.works_config.sync_failed';

    constructor(
        public readonly workId: string,
        public readonly userId: string,
        public readonly reason: WorksConfigSyncReason,
        public readonly repository: string,
        public readonly errorMessage: string,
    ) {
        super();
        // Security: sanitize before the message is stored or forwarded to
        // activity-log / notification consumers so raw git/network error
        // strings (which may contain OAuth tokens or internal URLs) are never
        // surfaced to users or written to persistent storage verbatim.
        (this as { errorMessage: string }).errorMessage = sanitizeErrorMessage(errorMessage);
    }
}
