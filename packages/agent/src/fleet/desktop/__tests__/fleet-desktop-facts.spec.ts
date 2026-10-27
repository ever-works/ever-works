import {
    applyReportedDesktop,
    fleetNodeDesktopViewOf,
    helperEventAudit,
} from '../fleet-desktop-facts';

/**
 * Desktop view & control (FL-07, T-17, T-20, FR-16, FR-18, U3) — a beat's
 * desktop fields on the row, and one audit row per admission event id.
 */

const AT = new Date('2026-10-26T04:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('applyReportedDesktop', () => {
    it('leaves the stored facts alone when the beat says nothing about the desktop', () => {
        expect(
            applyReportedDesktop({ helperTrust: 'hash-pinned', desktopFacts: null }, {}, AT),
        ).toBeNull();
    });

    it('stores the trust, the facts and the receipt time, re-normalised', () => {
        const applied = applyReportedDesktop(
            { helperTrust: 'none', desktopFacts: null },
            {
                helperTrust: 'hash-pinned',
                helper: {
                    trust: 'hash-pinned',
                    present: true,
                    admitted: true,
                    fingerprintPrefix: 'abcdef12',
                    sha256: 'f'.repeat(64),
                },
                displays: [
                    { id: 'DP-1', width: 1920, height: 1080, primary: true },
                    { id: 'bad id', width: 1, height: 1 },
                ],
                desktopReasons: ['permission-accessibility', 'nonsense'],
                helperEvents: [],
            },
            AT,
        );
        expect(applied?.patch.helperTrust).toBe('hash-pinned');
        expect(applied?.patch.desktopFacts).toEqual({
            helper: {
                trust: 'hash-pinned',
                present: true,
                admitted: true,
                version: null,
                fingerprintPrefix: 'abcdef12',
                verifiedAt: null,
                published: null,
            },
            displays: [
                {
                    id: 'DP-1',
                    name: 'DP-1',
                    width: 1920,
                    height: 1080,
                    scale: 1,
                    primary: true,
                    virtual: false,
                },
            ],
            reasons: ['permission-accessibility'],
            reportedAt: AT.toISOString(),
            seenEventIds: [],
        });
        expect(JSON.stringify(applied)).not.toContain('f'.repeat(64));
    });

    it('reads an unknown trust as none (fail-closed)', () => {
        expect(
            applyReportedDesktop(
                { helperTrust: 'signed', desktopFacts: null },
                { helperTrust: 'trusted' },
                AT,
            )?.patch.helperTrust,
        ).toBe('none');
    });

    it('returns only the events not audited before, and remembers them', () => {
        const first = applyReportedDesktop(
            { helperTrust: 'none', desktopFacts: null },
            {
                helperTrust: 'hash-pinned',
                helperEvents: [
                    {
                        id: id(1),
                        kind: 'admit',
                        at: '2026-10-26T03:00:00Z',
                        level: 'hash-pinned',
                        fingerprintPrefix: 'abcdef12',
                    },
                ],
            },
            AT,
        )!;
        expect(first.newEvents.map((event) => event.id)).toEqual([id(1)]);
        const second = applyReportedDesktop(
            { helperTrust: 'hash-pinned', desktopFacts: first.patch.desktopFacts! },
            {
                helperTrust: 'none',
                helperEvents: [
                    { id: id(1), kind: 'admit', at: '2026-10-26T03:00:00Z' },
                    {
                        id: id(2),
                        kind: 'verify-failed',
                        at: '2026-10-26T03:30:00Z',
                        reason: 'helper-untrusted',
                    },
                ],
            },
            AT,
        )!;
        expect(second.newEvents.map((event) => event.id)).toEqual([id(2)]);
        expect(second.patch.desktopFacts?.seenEventIds).toEqual([id(1), id(2)]);
    });
});

describe('fleetNodeDesktopViewOf', () => {
    it('never exposes the audited ids', () => {
        const view = fleetNodeDesktopViewOf({
            desktopFacts: {
                helper: null,
                displays: [],
                reasons: ['helper-missing'],
                reportedAt: AT.toISOString(),
                seenEventIds: [id(1)],
            },
        });
        expect(view).toEqual({
            helper: null,
            displays: [],
            reasons: ['helper-missing'],
            reportedAt: AT.toISOString(),
        });
        expect(fleetNodeDesktopViewOf({ desktopFacts: null })).toBeNull();
    });
});

describe('helperEventAudit', () => {
    it('names the action and keeps only facts a redactor will not eat', () => {
        const row = helperEventAudit({
            id: id(3),
            kind: 'verify-failed',
            at: '2026-10-26T03:30:00Z',
            reason: 'helper-untrusted',
            fingerprintPrefix: 'abcdef12',
        });
        expect(row.action).toBe('node.helper.verify-failed');
        expect(row.extra).toMatchObject({
            family: 'desktop',
            requestedBy: 'system:node',
            confirmationClass: 'plain',
            outcome: 'refused',
            reason: 'helper-untrusted',
            fingerprintPrefix: 'abcdef12',
        });
        for (const key of Object.keys(row.extra)) {
            expect(key).not.toMatch(
                /secret|token|credential|password|passphrase|hash|apikey|api_key/i,
            );
        }
        expect(
            helperEventAudit({ id: id(4), kind: 'admit', at: '2026-10-26T03:00:00Z' }).action,
        ).toBe('node.helper.admit');
        expect(
            helperEventAudit({ id: id(5), kind: 'revoke', at: '2026-10-26T03:00:00Z' }).extra
                .outcome,
        ).toBe('done');
    });
});
