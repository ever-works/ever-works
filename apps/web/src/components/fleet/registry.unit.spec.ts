import { afterEach, describe, expect, it } from 'vitest';
import type { FleetNodeView } from '@ever-works/contracts';
import {
    FLEET_COMPUTER_TAB_IDS,
    FLEET_FEATURE_FLAGS,
    FLEET_HUB_TABS,
    FLEET_HUB_TAB_IDS,
    getOverviewBlocks,
    registerComputerTab,
    registerHubTab,
    registerOverviewBlock,
    resetFleetRegistryForTests,
    resolveComputerTab,
    resolveComputerTabId,
    resolveHubTab,
    type FleetConsentsRead,
} from './registry';
import { readNodeConsents } from './fleet-consents.shared';

/**
 * Fleet hub (FL-01) — the module registry (README D9, CONTRACTS §11.1):
 * fixed strips, registration, and the five tab states (spec U4–U6).
 */

const Panel = () => null;
const load = async () => ({ default: Panel });

const NONE: FleetConsentsRead = { work: false, attend: false, manage: false };
const ALL: FleetConsentsRead = { work: true, attend: true, manage: true };
const node = (kind: FleetNodeView['kind'] = 'node') => ({ kind });

afterEach(() => resetFleetRegistryForTests());

describe('tab strips', () => {
    it('has the six hub tabs in order (FR-3)', () => {
        expect(FLEET_HUB_TAB_IDS).toEqual([
            'overview',
            'computers',
            'sessions',
            'checkouts',
            'commands',
            'usage',
        ]);
        expect(FLEET_HUB_TABS.map((tab) => tab.href)).toEqual([
            '/fleet',
            '/fleet/computers',
            '/fleet/sessions',
            '/fleet/checkouts',
            '/fleet/commands',
            '/fleet/usage',
        ]);
    });

    it('names the epics that fill the four later hub tabs (ACC-FL01-02)', () => {
        expect(FLEET_HUB_TABS.slice(2).map((tab) => tab.epic)).toEqual([
            'FL-05',
            'FL-14',
            'FL-12',
            'FL-20',
        ]);
    });

    it('has the twelve computer tabs in order (FR-17)', () => {
        expect(FLEET_COMPUTER_TAB_IDS).toEqual([
            'overview',
            'sessions',
            'desktop',
            'logs',
            'services',
            'docker',
            'processes',
            'ports',
            'files',
            'schedules',
            'checkouts',
            'settings',
        ]);
    });

    it('selects a tab from ?tab=, defaulting to overview', () => {
        expect(resolveComputerTabId('logs')).toBe('logs');
        expect(resolveComputerTabId(['docker', 'logs'])).toBe('docker');
        expect(resolveComputerTabId('nope')).toBe('overview');
        expect(resolveComputerTabId(undefined)).toBe('overview');
    });

    it('lists the CONTRACTS §9 per-epic flags', () => {
        expect(FLEET_FEATURE_FLAGS).toContain('FLEET_MACHINE_FACTS_ENABLED');
        expect(FLEET_FEATURE_FLAGS).not.toContain('FLEET_HUB_ENABLED');
    });
});

describe('resolveComputerTab (U4–U6, FR-18–FR-20)', () => {
    it('is not-shipped, naming the epic, when nothing registered the tab', () => {
        expect(resolveComputerTab('logs', { flags: {}, node: node(), consents: ALL })).toEqual({
            kind: 'not-shipped',
            epic: 'FL-08',
        });
    });

    it('is switched-off when the epic registered but its flag is off', () => {
        registerComputerTab({ id: 'logs', load });
        expect(resolveComputerTab('logs', { flags: {}, node: node(), consents: ALL })).toEqual({
            kind: 'switched-off',
            epic: 'FL-08',
        });
    });

    it('gives the exact --manage command when the computer did not opt in (ACC-FL01-10)', () => {
        registerComputerTab({ id: 'logs', load });
        expect(
            resolveComputerTab('logs', {
                flags: { FLEET_MACHINE_FACTS_ENABLED: true },
                node: node(),
                consents: { ...NONE, work: true },
            }),
        ).toEqual({
            kind: 'consent-missing',
            consent: 'manage',
            command: 'ever-works-node start --manage',
        });
    });

    it('says a desktop node cannot do it yet rather than asking for a flag it has no way to set (R-10)', () => {
        registerComputerTab({ id: 'logs', load });
        expect(
            resolveComputerTab('logs', {
                flags: { FLEET_MACHINE_FACTS_ENABLED: true },
                node: node('desktop-node'),
                consents: { ...NONE, work: true },
            }),
        ).toEqual({ kind: 'kind-cannot' });
    });

    it('renders a desktop node that does report the consent (after FL-02 parity)', () => {
        registerComputerTab({ id: 'logs', load });
        const state = resolveComputerTab('logs', {
            flags: { FLEET_MACHINE_FACTS_ENABLED: true },
            node: node('desktop-node'),
            consents: ALL,
        });
        expect(state.kind).toBe('ready');
    });

    it('is ready, with the registered loader, when everything is in place', () => {
        registerComputerTab({ id: 'desktop', load });
        const state = resolveComputerTab('desktop', {
            flags: { FLEET_DESKTOP_ENABLED: true },
            node: node(),
            consents: { ...NONE, attend: true },
        });
        expect(state).toEqual({ kind: 'ready', load });
    });

    it('never asks a consent of the tabs that need none', () => {
        registerComputerTab({ id: 'settings', load });
        expect(
            resolveComputerTab('settings', { flags: {}, node: node(), consents: NONE }).kind,
        ).toBe('ready');
    });

    it('refuses to register an unknown tab id (a typo would ship nothing)', () => {
        expect(() => registerComputerTab({ id: 'shell' as never, load })).toThrow(
            /Unknown Fleet computer tab/,
        );
        expect(() => registerHubTab({ id: 'machines' as never, load })).toThrow(
            /Unknown Fleet hub tab/,
        );
    });
});

describe('resolveHubTab', () => {
    it('is not-shipped for Sessions until FL-05 registers it, then follows its flag', () => {
        expect(resolveHubTab('sessions', { flags: {} })).toEqual({
            kind: 'not-shipped',
            epic: 'FL-05',
        });
        registerHubTab({ id: 'sessions', load });
        expect(resolveHubTab('sessions', { flags: {} })).toEqual({
            kind: 'switched-off',
            epic: 'FL-05',
        });
        expect(resolveHubTab('sessions', { flags: { FLEET_SESSIONS_ENABLED: true } }).kind).toBe(
            'ready',
        );
    });

    it('needs no flag for the hub’s own tabs', () => {
        registerHubTab({ id: 'computers', load });
        expect(resolveHubTab('computers', { flags: {} }).kind).toBe('ready');
    });
});

describe('getOverviewBlocks', () => {
    it('returns one surface’s blocks whose flag is on, in order', () => {
        registerOverviewBlock({
            id: 'fl-03.metrics',
            surface: 'computer',
            order: 10,
            epic: 'FL-03',
            load,
        });
        registerOverviewBlock({
            id: 'fl-18.jobs',
            surface: 'hub',
            order: 50,
            epic: 'FL-18',
            flag: 'FLEET_ACTIONS_RUNNERS_ENABLED',
            load,
        });
        registerOverviewBlock({
            id: 'fl-01.needs-a-look',
            surface: 'hub',
            order: 100,
            epic: 'FL-01',
            load,
        });

        expect(getOverviewBlocks('hub', {}).map((block) => block.id)).toEqual([
            'fl-01.needs-a-look',
        ]);
        expect(
            getOverviewBlocks('hub', { FLEET_ACTIONS_RUNNERS_ENABLED: true }).map(
                (block) => block.id,
            ),
        ).toEqual(['fl-18.jobs', 'fl-01.needs-a-look']);
        expect(getOverviewBlocks('computer', {}).map((block) => block.id)).toEqual([
            'fl-03.metrics',
        ]);
    });
});

describe('readNodeConsents', () => {
    it('trusts the heartbeat’s consents when the node reports them (FL-02)', () => {
        expect(
            readNodeConsents({
                capabilities: [],
                workerState: null,
                consents: { work: true, attend: false, manage: true, usageScan: false },
            }),
        ).toEqual({ work: true, attend: false, manage: true });
    });

    it('reads the existing tags otherwise, never treating unknown as granted', () => {
        expect(readNodeConsents({ capabilities: ['attended'], workerState: 'idle' })).toEqual({
            work: true,
            attend: true,
            manage: false,
        });
        expect(readNodeConsents({ capabilities: [], workerState: null })).toEqual(NONE);
    });
});
