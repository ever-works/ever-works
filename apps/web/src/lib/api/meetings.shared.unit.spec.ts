// Meetings — pure-helper spec for the roster parser shared by the
// capture form and the detail page.

import { describe, expect, it } from 'vitest';
import {
    MEETING_PARTICIPANTS_MAX,
    MEETING_PARTICIPANT_EMAIL_MAX_CHARS,
    MEETING_PARTICIPANT_NAME_MAX_CHARS,
    MEETING_SOURCES,
    formatParticipants,
    parseParticipants,
} from './meetings.shared';

describe('MEETING_SOURCES', () => {
    it('mirrors the API closed set exactly', () => {
        expect([...MEETING_SOURCES].sort()).toEqual(
            ['google-meet', 'import', 'manual', 'zoom'].sort(),
        );
    });
});

describe('parseParticipants', () => {
    it('reads "Name <email>" into a name + email pair', () => {
        expect(parseParticipants('Ada Lovelace <ada@example.com>')).toEqual([
            { name: 'Ada Lovelace', email: 'ada@example.com' },
        ]);
    });

    it('treats a bare address as both the name and the email', () => {
        expect(parseParticipants('grace@example.com')).toEqual([
            { name: 'grace@example.com', email: 'grace@example.com' },
        ]);
    });

    it('keeps a bare name email-less rather than inventing an address', () => {
        const parsed = parseParticipants('Grace Hopper');
        expect(parsed).toEqual([{ name: 'Grace Hopper' }]);
        expect(parsed[0].email).toBeUndefined();
    });

    it('parses one participant per line and drops blank lines', () => {
        expect(parseParticipants('Ada Lovelace <ada@example.com>\n\n  \nGrace Hopper\n')).toEqual([
            { name: 'Ada Lovelace', email: 'ada@example.com' },
            { name: 'Grace Hopper' },
        ]);
    });

    it('falls back to the address when the display name is empty', () => {
        expect(parseParticipants('<ada@example.com>')).toEqual([
            { name: 'ada@example.com', email: 'ada@example.com' },
        ]);
    });

    it('truncates to the API MaxLength so a paste is never rejected for length', () => {
        const longName = 'n'.repeat(MEETING_PARTICIPANT_NAME_MAX_CHARS + 50);
        const longLocal = 'e'.repeat(MEETING_PARTICIPANT_EMAIL_MAX_CHARS + 50);
        const [parsed] = parseParticipants(`${longName} <${longLocal}@example.com>`);
        expect(parsed.name.length).toBe(MEETING_PARTICIPANT_NAME_MAX_CHARS);
        expect((parsed.email ?? '').length).toBe(MEETING_PARTICIPANT_EMAIL_MAX_CHARS);
    });

    it('caps an unbounded paste at the defensive roster limit', () => {
        const pasted = Array.from({ length: MEETING_PARTICIPANTS_MAX + 25 }, (_, i) => `P${i}`);
        expect(parseParticipants(pasted.join('\n')).length).toBe(MEETING_PARTICIPANTS_MAX);
    });

    it('returns nothing for an empty or whitespace-only roster', () => {
        expect(parseParticipants('')).toEqual([]);
        expect(parseParticipants('   \n\t\n')).toEqual([]);
    });

    it('handles CRLF line endings (pasted from a Windows client)', () => {
        expect(parseParticipants('Ada\r\nGrace')).toEqual([{ name: 'Ada' }, { name: 'Grace' }]);
    });
});

describe('formatParticipants', () => {
    it('round-trips a parsed roster back into the textarea format', () => {
        const raw = 'Ada Lovelace <ada@example.com>\nGrace Hopper';
        expect(formatParticipants(parseParticipants(raw))).toBe(raw);
    });

    it('does not duplicate an address that is also the display name', () => {
        expect(formatParticipants([{ name: 'ada@example.com', email: 'ada@example.com' }])).toBe(
            'ada@example.com',
        );
    });
});
