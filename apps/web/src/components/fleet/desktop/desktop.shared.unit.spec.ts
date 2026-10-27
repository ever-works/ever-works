import { describe, expect, it } from 'vitest';
import { FLEET_DESKTOP_BLOCKERS, type FleetDisplayView } from '@ever-works/contracts';
import en from '../../../../messages/en.json';
import {
    DESKTOP_BLOCKER_KEYS,
    desktopBlockerCommand,
    desktopBlockerRetries,
    desktopBlockerSettingsPath,
    displayPosition,
    displaySize,
    displayStorageKey,
} from './desktop.shared';

/** Desktop view & control (FL-07, T-23, spec §5.4) — the Desktop tab's pure half. */

const display = (id: string, extra: Partial<FleetDisplayView> = {}): FleetDisplayView => ({
    id,
    name: id,
    width: 1920,
    height: 1080,
    scale: 1,
    primary: false,
    virtual: false,
    ...extra,
});

describe('desktop.shared (FL-07)', () => {
    it('has a card (title and body) for every blocker, with camelCase keys', () => {
        const cards = (en as unknown as { fleet: { desktop: { unavailable: Record<string, { title?: string; body?: string }> } } })
            .fleet.desktop.unavailable;
        for (const blocker of FLEET_DESKTOP_BLOCKERS) {
            const key = DESKTOP_BLOCKER_KEYS[blocker];
            expect(key).toMatch(/^[a-z][A-Za-z]*$/);
            expect(cards[key]?.title).toBeTruthy();
            expect(cards[key]?.body).toBeTruthy();
        }
    });

    it('offers the exact command or settings path that fixes a blocker', () => {
        expect(desktopBlockerCommand('helper-missing')).toBe('ever-works-node helper install');
        expect(desktopBlockerCommand('helper-unadmitted')).toBe('ever-works-node helper admit');
        expect(desktopBlockerCommand('helper-untrusted')).toBe('ever-works-node helper status');
        expect(desktopBlockerCommand('consent-missing')).toBe('ever-works-node start --attend');
        expect(desktopBlockerCommand('offline')).toBeNull();
        expect(desktopBlockerSettingsPath('permission-screen-recording')).toContain('Screen Recording');
        expect(desktopBlockerSettingsPath('helper-missing')).toBeNull();
    });

    it('never offers "Try again" for what only the owner can change', () => {
        expect(desktopBlockerRetries('permission-denied')).toBe(false);
        expect(desktopBlockerRetries('kind-unsupported')).toBe(false);
        expect(desktopBlockerRetries('helper-unadmitted')).toBe(true);
    });

    it('labels displays in the machine order, 1-based', () => {
        const displays = [display('a', { primary: true }), display('b', { scale: 2, width: 3024, height: 1964 })];
        expect(displayPosition(displays, 'b')).toEqual({ index: 2, count: 2 });
        expect(displayPosition(displays, 'gone')).toEqual({ index: 1, count: 2 });
        expect(displayPosition([], null)).toEqual({ index: 1, count: 1 });
        expect(displaySize(displays[1])).toBe('3024 × 1964 @2×');
        expect(displaySize(displays[0])).toBe('1920 × 1080');
    });

    it('remembers the display per computer', () => {
        expect(displayStorageKey('n1')).toBe('ew:fleet:desktop:display:n1');
    });
});
