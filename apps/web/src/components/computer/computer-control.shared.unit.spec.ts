import { describe, expect, it } from 'vitest';
import type { ComputerControlStateView } from '@ever-works/contracts';
import {
    blockedShortcutLabels,
    controlRefusalKey,
    describeControlRefusal,
    formatCountdown,
    idleWarningMs,
    isControlStateView,
    keyEventToFrame,
    msUntil,
    pointerButtonsMask,
    pointerToPicture,
    serverClockOffsetMs,
    takeOverAvailability,
    wasReleasedAutomatically,
} from './computer-session.shared';

/**
 * The take-over decisions of the computer page, as pure functions: when Take
 * over is offered and why not, the countdowns on the platform's clock, where
 * a click lands in the picture, and which keys are never sent.
 */

const NOW = Date.parse('2026-09-14T09:00:00.000Z');

function state(patch: Partial<ComputerControlStateView> = {}): ComputerControlStateView {
    return {
        nodeId: 'node-1',
        sessionId: 'view-a',
        policy: 'owner',
        canControl: true,
        mode: 'watching',
        holder: null,
        request: null,
        lastRelease: null,
        serverTime: new Date(NOW).toISOString(),
        ...patch,
    };
}

const holder = (patch: Partial<NonNullable<ComputerControlStateView['holder']>> = {}) => ({
    userId: 'u1',
    sessionId: 'view-b',
    since: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 59 * 60_000).toISOString(),
    idleAt: new Date(NOW + 9 * 60_000).toISOString(),
    extended: false,
    you: true,
    thisView: false,
    ...patch,
});

describe('takeOverAvailability', () => {
    it('offers Take over only on a live screen the policy allows and nobody else holds', () => {
        expect(takeOverAvailability({ state: state(), channel: 'screen', live: true })).toBe(
            'available',
        );
        expect(takeOverAvailability({ state: state(), channel: 'terminal', live: true })).toBe(
            'terminal',
        );
        expect(takeOverAvailability({ state: state(), channel: 'screen', live: false })).toBe(
            'unavailable',
        );
        expect(takeOverAvailability({ state: null, channel: 'screen', live: true })).toBe(
            'unavailable',
        );
        expect(
            takeOverAvailability({
                state: state({ canControl: false }),
                channel: 'screen',
                live: true,
            }),
        ).toBe('denied');
        expect(
            takeOverAvailability({
                state: state({ holder: holder() }),
                channel: 'screen',
                live: true,
            }),
        ).toBe('held-elsewhere');
        expect(
            takeOverAvailability({
                state: state({ mode: 'controlling', holder: holder({ thisView: true }) }),
                channel: 'screen',
                live: true,
            }),
        ).toBe('controlling');
    });
});

describe('countdowns on the platform’s clock', () => {
    it('formats m:ss, rounding up, never negative', () => {
        expect(formatCountdown(57 * 60_000 + 4000)).toBe('57:04');
        expect(formatCountdown(29_001)).toBe('0:30');
        expect(formatCountdown(0)).toBe('0:00');
        expect(formatCountdown(-5000)).toBe('0:00');
    });

    it('reads deadlines through the offset between the platform and this browser', () => {
        const offset = serverClockOffsetMs(
            state({ serverTime: new Date(NOW + 5000).toISOString() }),
            NOW,
        );
        expect(offset).toBe(5000);
        expect(msUntil(new Date(NOW + 65_000).toISOString(), NOW, offset)).toBe(60_000);
        expect(msUntil(null, NOW, offset)).toBeNull();
        expect(serverClockOffsetMs(null, NOW)).toBe(0);
    });

    it('shows the idle warning only to the holder, only in the last 30 seconds', () => {
        const controlling = (idleInMs: number) =>
            state({
                mode: 'controlling',
                holder: holder({ thisView: true, idleAt: new Date(NOW + idleInMs).toISOString() }),
            });
        expect(idleWarningMs(controlling(30_001), NOW, 0)).toBeNull();
        expect(idleWarningMs(controlling(30_000), NOW, 0)).toBe(30_000);
        expect(idleWarningMs(controlling(-10), NOW, 0)).toBe(0);
        expect(
            idleWarningMs(
                state({ holder: holder({ idleAt: new Date(NOW + 1000).toISOString() }) }),
                NOW,
                0,
            ),
        ).toBeNull();
    });

    it('tells an automatic release apart from giving control back', () => {
        for (const reason of [
            'idle',
            'ceiling',
            'disconnected',
            'revoked',
            'session-ended',
        ] as const) {
            expect(wasReleasedAutomatically(state({ lastRelease: { reason, at: null } }))).toBe(
                true,
            );
        }
        for (const reason of ['given-back', 'handed-over'] as const) {
            expect(wasReleasedAutomatically(state({ lastRelease: { reason, at: null } }))).toBe(
                false,
            );
        }
        expect(wasReleasedAutomatically(null)).toBe(false);
    });
});

describe('refusals and state bodies', () => {
    it('keeps the named reason and the state a refusal carried', () => {
        expect(
            describeControlRefusal(409, { reason: 'held', state: state({ holder: holder() }) }),
        ).toMatchObject({
            reason: 'held',
            state: { holder: { sessionId: 'view-b' } },
        });
        expect(describeControlRefusal(503, { reason: 'control-unavailable' })).toEqual({
            reason: 'unavailable',
            state: null,
        });
        expect(describeControlRefusal(500, 'boom')).toEqual({ reason: 'failed', state: null });
    });

    it('maps every refusal to a camelCase message key with no dots', () => {
        expect(controlRefusalKey('not-live')).toBe('notLive');
        expect(controlRefusalKey('already-extended')).toBe('alreadyExtended');
        expect(controlRefusalKey('policy')).toBe('policy');
        for (const reason of [
            'policy',
            'held',
            'not-live',
            'session-ended',
            'not-holder',
            'not-held',
            'already-requested',
            'no-request',
            'already-extended',
            'unavailable',
            'failed',
        ] as const) {
            expect(controlRefusalKey(reason)).toMatch(/^[a-z][A-Za-z]*$/);
        }
    });

    it('adopts only a real control state', () => {
        expect(isControlStateView(state())).toBe(true);
        expect(isControlStateView({})).toBe(false);
        expect(isControlStateView({ token: 'tok', wsUrl: 'ws://x' })).toBe(false);
        expect(isControlStateView(null)).toBe(false);
    });
});

describe('pointerToPicture', () => {
    const picture = { width: 800, height: 600 };

    it('maps a click in a letterboxed stage to picture pixels', () => {
        // A 1000×600 stage shows the 800×600 picture unscaled, centred with 100 px margins.
        const box = { left: 0, top: 0, width: 1000, height: 600 };
        expect(pointerToPicture({ clientX: 100, clientY: 0 }, box, picture)).toEqual({
            x: 0,
            y: 0,
        });
        expect(pointerToPicture({ clientX: 500, clientY: 300 }, box, picture)).toEqual({
            x: 400,
            y: 300,
        });
        expect(pointerToPicture({ clientX: 50, clientY: 300 }, box, picture)).toBeNull();
    });

    it('scales down a stage smaller than the picture', () => {
        const box = { left: 10, top: 20, width: 400, height: 300 };
        expect(pointerToPicture({ clientX: 210, clientY: 170 }, box, picture)).toEqual({
            x: 400,
            y: 300,
        });
    });

    it('pins a point off the picture to its nearest edge when asked to clamp', () => {
        const box = { left: 0, top: 0, width: 1000, height: 600 };
        expect(
            pointerToPicture({ clientX: 50, clientY: 300 }, box, picture, { clamp: true }),
        ).toEqual({ x: 0, y: 300 });
        expect(
            pointerToPicture({ clientX: 2000, clientY: -40 }, box, picture, { clamp: true }),
        ).toEqual({ x: 799, y: 0 });
        // A point on the picture is the same either way.
        expect(
            pointerToPicture({ clientX: 500, clientY: 300 }, box, picture, { clamp: true }),
        ).toEqual({ x: 400, y: 300 });
        expect(
            pointerToPicture(
                { clientX: 1, clientY: 1 },
                { left: 0, top: 0, width: 0, height: 0 },
                picture,
                { clamp: true },
            ),
        ).toBeNull();
    });

    it('refuses an empty stage or picture', () => {
        expect(
            pointerToPicture(
                { clientX: 1, clientY: 1 },
                { left: 0, top: 0, width: 0, height: 0 },
                picture,
            ),
        ).toBeNull();
        expect(
            pointerToPicture(
                { clientX: 1, clientY: 1 },
                { left: 0, top: 0, width: 10, height: 10 },
                { width: 0, height: 0 },
            ),
        ).toBeNull();
    });
});

describe('pointerButtonsMask', () => {
    it('keeps the held buttons a pointer event reports, and reads anything else as none', () => {
        expect(pointerButtonsMask(1)).toBe(1);
        expect(pointerButtonsMask(5)).toBe(5);
        expect(pointerButtonsMask(0)).toBe(0);
        expect(pointerButtonsMask(64 | 1)).toBe(1);
        for (const junk of [-1, 1.5, Number.NaN, '1', undefined, null]) {
            expect(pointerButtonsMask(junk)).toBe(0);
        }
    });
});

describe('keyEventToFrame', () => {
    const event = (patch: Partial<KeyboardEvent>) =>
        ({
            key: 'a',
            code: 'KeyA',
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            ...patch,
        }) as KeyboardEvent;

    it('carries the key, the physical code and the modifier bits', () => {
        expect(keyEventToFrame(event({ shiftKey: true, key: 'A' }), 'down')).toEqual({
            kind: 'key',
            action: 'down',
            key: 'A',
            code: 'KeyA',
            modifiers: 8,
        });
        expect(keyEventToFrame(event({ key: 'Enter', code: 'Enter' }), 'up')).toMatchObject({
            action: 'up',
            modifiers: 0,
        });
    });

    it('never sends clipboard, window or operating-system shortcuts, or composing keys', () => {
        expect(
            keyEventToFrame(event({ ctrlKey: true, key: 'v', code: 'KeyV' }), 'down'),
        ).toBeNull();
        expect(
            keyEventToFrame(event({ metaKey: true, key: 'c', code: 'KeyC' }), 'down'),
        ).toBeNull();
        expect(
            keyEventToFrame(event({ altKey: true, key: 'Tab', code: 'Tab' }), 'down'),
        ).toBeNull();
        expect(keyEventToFrame(event({ key: 'Process', code: '' }), 'down')).toBeNull();
        expect(
            keyEventToFrame(event({ ctrlKey: true, key: 'a', code: 'KeyA' }), 'down'),
        ).toMatchObject({
            modifiers: 2,
        });
    });

    it('lists each blocked shortcut once for the keyboard sheet', () => {
        const labels = blockedShortcutLabels();
        expect(labels).toContain('Ctrl/⌘+V');
        expect(new Set(labels).size).toBe(labels.length);
    });
});
