import { describe, expect, it } from 'vitest';
import type { ComputerControlStateView } from '@ever-works/contracts';
import { sanitizeDesktopAnswerBody, sanitizeDesktopControlBody } from '@/lib/api/fleet-desktop-bff';
import { desktopControlStatus } from './desktop.shared';

/** Desktop view & control (FL-07 P2, T-33, FR-42) — the control strip's sentence and the control BFF's bodies. */

function state(patch: Partial<ComputerControlStateView>): ComputerControlStateView {
    return {
        nodeId: 'n1',
        sessionId: 'v1',
        policy: 'owner',
        canControl: true,
        mode: 'watching',
        holder: null,
        request: null,
        lastRelease: null,
        serverTime: '2026-10-27T05:00:00.000Z',
        ...patch,
    } as ComputerControlStateView;
}

const holder = (thisView: boolean) => ({
    userId: 'u1',
    sessionId: thisView ? 'v1' : 'v2',
    since: '2026-10-27T05:00:00.000Z',
    expiresAt: null,
    idleAt: null,
    extended: false,
    you: thisView,
    thisView,
});

describe('desktopControlStatus (FR-42)', () => {
    it('reads watching, controlling, or someone else', () => {
        expect(desktopControlStatus(null)).toBe('watching');
        expect(desktopControlStatus(state({}))).toBe('watching');
        expect(desktopControlStatus(state({ mode: 'controlling', holder: holder(true) }))).toBe(
            'controlling',
        );
        expect(desktopControlStatus(state({ holder: holder(false) }))).toBe('other');
    });
});

describe('control BFF bodies', () => {
    it('forwards only request / confirm, and only when true', () => {
        expect(
            sanitizeDesktopControlBody({ confirm: true, role: 'driver', mode: 'controlling' }),
        ).toEqual({ confirm: true });
        expect(sanitizeDesktopControlBody({ request: true })).toEqual({ request: true });
        expect(sanitizeDesktopControlBody({ confirm: 'yes' })).toEqual({});
    });

    it('forwards a hand-over answer only with a request id and a known decision', () => {
        const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        expect(sanitizeDesktopAnswerBody({ requestId, decision: 'hand-over', extra: 1 })).toEqual({
            requestId,
            decision: 'hand-over',
        });
        expect(sanitizeDesktopAnswerBody({ requestId: '../x', decision: 'keep' })).toBeNull();
        expect(sanitizeDesktopAnswerBody({ requestId, decision: 'give' })).toBeNull();
    });
});
