import { afterEach, describe, expect, it } from 'vitest';
import { desktopHasConsentWiring } from './fleet-consents.shared';
import {
    registerComputerTab,
    resetFleetRegistryForTests,
    resolveComputerTab,
    type FleetConsentsRead,
} from './registry';

/**
 * Fleet node link (FL-02 T-26, CONTRACTS R-10, spec S13, FR-40) — once the
 * desktop app ships its consents (wizard, tray, the node link), the hub stops
 * saying "not available on this kind of computer yet" for it and points its
 * owner at the tray instead of a command line. A desktop app that has not
 * shown the wiring (no link, nothing beyond work) keeps the old sentence.
 */

const Panel = () => null;
const load = async () => ({ default: Panel });
const WORK_ONLY: FleetConsentsRead = { work: true, attend: false, manage: false };
const idle = { since: null, linkGeneration: null, bytesIn: 0, bytesOut: 0, openChannels: 0 };

afterEach(() => resetFleetRegistryForTests());

describe('desktopHasConsentWiring', () => {
    it('is true for a desktop app that linked, or reports attend / manage', () => {
        expect(
            desktopHasConsentWiring({ kind: 'desktop-node', link: { state: 'connected' } }),
        ).toBe(true);
        expect(
            desktopHasConsentWiring({ kind: 'desktop-node', link: { state: 'reconnecting' } }),
        ).toBe(true);
        expect(
            desktopHasConsentWiring({
                kind: 'desktop-node',
                consents: { work: true, attend: false, manage: true, usageScan: false },
            }),
        ).toBe(true);
    });

    it('is false for an older desktop app and for every other kind', () => {
        expect(
            desktopHasConsentWiring({ kind: 'desktop-node', link: { state: 'unsupported-kind' } }),
        ).toBe(false);
        expect(
            desktopHasConsentWiring({
                kind: 'desktop-node',
                consents: { work: true, attend: false, manage: false, usageScan: false },
            }),
        ).toBe(false);
        expect(desktopHasConsentWiring({ kind: 'node', link: { state: 'connected' } })).toBe(false);
    });
});

describe('resolveComputerTab — the desktop app after parity', () => {
    it('asks for the tray, not a flag, once the desktop app has linked', () => {
        registerComputerTab({ id: 'logs', load });
        expect(
            resolveComputerTab('logs', {
                flags: { FLEET_MACHINE_FACTS_ENABLED: true },
                node: { kind: 'desktop-node', link: { state: 'connected', ...idle } },
                consents: WORK_ONLY,
            }),
        ).toEqual({
            kind: 'consent-missing',
            consent: 'manage',
            command: 'ever-works-node start --manage',
            via: 'tray',
        });
    });

    it('keeps "not available on this kind of computer yet" for a desktop app without the wiring', () => {
        registerComputerTab({ id: 'logs', load });
        expect(
            resolveComputerTab('logs', {
                flags: { FLEET_MACHINE_FACTS_ENABLED: true },
                node: { kind: 'desktop-node', link: { state: 'unsupported-kind', ...idle } },
                consents: WORK_ONLY,
            }),
        ).toEqual({ kind: 'kind-cannot' });
    });
});
