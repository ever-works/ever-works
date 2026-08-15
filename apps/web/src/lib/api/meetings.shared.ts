/**
 * Meetings — client-safe contract values.
 *
 * Pure unions and numeric bounds with NO server dependency, so they
 * live apart from `meetings.ts` (which is `server-only`). `'use client'`
 * components (`MeetingForm`, `MeetingDetailClient`) import them from
 * here directly; `meetings.ts` re-exports them so server-side callers
 * keep a single import site. Importing a VALUE (not just a type) from
 * `meetings.ts` in a client component pulls its `server-only` guard
 * into the client bundle and fails `next build` — this split avoids
 * that while keeping one canonical definition (same idiom as
 * `goals.shared.ts`).
 *
 * Mirrors of the API-side bounds:
 *   - sources          `MeetingSource` in packages/agent/src/entities/meeting.entity.ts
 *   - transcript cap   `MEETING_TRANSCRIPT_MAX_CHARS` in packages/agent/src/meetings/meetings.service.ts
 *   - field lengths    `apps/api/src/meetings/dto/meeting.dto.ts`
 */

/** Where a meeting row came from (closed set — the API 400s on others). */
export type MeetingSource = 'zoom' | 'google-meet' | 'manual' | 'import';

/** Every accepted source, in the order the pickers render them. */
export const MEETING_SOURCES: MeetingSource[] = ['manual', 'import', 'zoom', 'google-meet'];

/**
 * Sources a human can pick when capturing a meeting by hand.
 * Provider-synced meetings (`zoom`, `google-meet`) normally arrive
 * through the connector → ingest-spine path, but the API accepts them
 * on create too (e.g. pasting a transcript from a recording you already
 * have), so they stay selectable rather than being hidden.
 */
export const MEETING_CREATABLE_SOURCES: MeetingSource[] = MEETING_SOURCES;

/** Service-level transcript cap; the DTO enforces the same MaxLength. */
export const MEETING_TRANSCRIPT_MAX_CHARS = 200_000;

/** `CreateMeetingDto.title` / `UpdateMeetingDto.title` MaxLength. */
export const MEETING_TITLE_MAX_CHARS = 500;

/** `sourceUrl` MaxLength (recording / provider deep link). */
export const MEETING_SOURCE_URL_MAX_CHARS = 2048;

/** `externalId` MaxLength (provider meeting id / dedupe key). */
export const MEETING_EXTERNAL_ID_MAX_CHARS = 200;

/** `MeetingParticipantDto.name` MaxLength. */
export const MEETING_PARTICIPANT_NAME_MAX_CHARS = 200;

/** `MeetingParticipantDto.email` MaxLength. */
export const MEETING_PARTICIPANT_EMAIL_MAX_CHARS = 320;

/**
 * Defensive roster cap for the client-side parser. The API has no
 * explicit array bound, so the form refuses to post an unbounded
 * roster pasted from a spreadsheet.
 */
export const MEETING_PARTICIPANTS_MAX = 200;

/** One roster entry, matching the API's `MeetingParticipantDto`. */
export interface MeetingParticipant {
    name: string;
    email?: string;
}

/**
 * Loose e-mail shape check — one `@`, a dot in the domain, no spaces.
 *
 * Deliberately permissive: the API stores the address as an opaque
 * string, so this only has to catch the typo the user can see (a
 * missing `@`, a trailing comma), never adjudicate RFC 5322.
 */
export function isLikelyEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Parse a human-typed roster into `MeetingParticipant[]`.
 *
 * One participant per line, in any of:
 *   `Ada Lovelace <ada@example.com>`  → { name, email }
 *   `ada@example.com`                 → { name: email, email }
 *   `Grace`                           → { name }
 *
 * Blank lines are dropped and every field is truncated to the API's
 * MaxLength so a paste can never be rejected for length alone. Shared
 * with the unit spec, which is why it lives in the client-safe module.
 */
export function parseParticipants(raw: string): MeetingParticipant[] {
    const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, MEETING_PARTICIPANTS_MAX);

    return lines.map((line) => {
        const angled = /^(.*?)\s*<\s*([^>]+?)\s*>$/.exec(line);
        if (angled) {
            const email = angled[2].trim().slice(0, MEETING_PARTICIPANT_EMAIL_MAX_CHARS);
            const name = (angled[1].trim() || email).slice(0, MEETING_PARTICIPANT_NAME_MAX_CHARS);
            return { name, email };
        }
        if (isLikelyEmail(line)) {
            const email = line.slice(0, MEETING_PARTICIPANT_EMAIL_MAX_CHARS);
            return { name: email.slice(0, MEETING_PARTICIPANT_NAME_MAX_CHARS), email };
        }
        return { name: line.slice(0, MEETING_PARTICIPANT_NAME_MAX_CHARS) };
    });
}

/** Render a roster back into the textarea format `parseParticipants` reads. */
export function formatParticipants(participants: MeetingParticipant[]): string {
    return participants
        .map((p) => (p.email && p.email !== p.name ? `${p.name} <${p.email}>` : p.name))
        .join('\n');
}
