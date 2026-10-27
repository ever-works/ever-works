import { describe, expect, it } from 'vitest';
import {
    createDetachChord,
    DETACH_KEY,
    DETACH_PREFIX,
    SESSION_CLI_EXIT,
    sessionSocketUrl,
} from '../session/attach.shared';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('fleet session attach — the detach chord (FL-04 P2, FR-53)', () => {
    it('passes ordinary keys through untouched', () => {
        const chord = createDetachChord();
        expect(chord(bytes(0x6c, 0x73, 0x0d))).toEqual({
            forward: bytes(0x6c, 0x73, 0x0d),
            detach: false,
        });
    });

    it('detaches on Ctrl-] then d, sending neither key', () => {
        const chord = createDetachChord();
        expect(chord(bytes(0x61, DETACH_PREFIX, DETACH_KEY))).toEqual({
            forward: bytes(0x61),
            detach: true,
        });
    });

    it('detaches across two reads', () => {
        const chord = createDetachChord();
        expect(chord(bytes(DETACH_PREFIX))).toEqual({ forward: bytes(), detach: false });
        expect(chord(bytes(DETACH_KEY))).toEqual({ forward: bytes(), detach: true });
    });

    it('sends one Ctrl-] for two, and Ctrl-] plus any other key as typed', () => {
        const chord = createDetachChord();
        expect(chord(bytes(DETACH_PREFIX, DETACH_PREFIX)).forward).toEqual(bytes(DETACH_PREFIX));
        expect(chord(bytes(DETACH_PREFIX, 0x78)).forward).toEqual(bytes(DETACH_PREFIX, 0x78));
    });

    it('builds the socket URL from the API base', () => {
        expect(sessionSocketUrl('https://api.ever.works/api', '/ws/fleet/session/x')).toBe(
            'wss://api.ever.works/ws/fleet/session/x',
        );
        expect(sessionSocketUrl('http://localhost:3100', '/ws/fleet/session/x')).toBe(
            'ws://localhost:3100/ws/fleet/session/x',
        );
    });

    it('exits 0 / 1 / 2', () => {
        expect(SESSION_CLI_EXIT).toEqual({ ok: 0, refused: 1, usage: 2 });
    });
});
