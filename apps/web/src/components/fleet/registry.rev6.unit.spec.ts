import { afterEach, describe, expect, it } from 'vitest';
import type { FleetNodeView } from '@ever-works/contracts';
import {
    computerActionAllowed,
    computerActionProps,
    getAddComputerItems,
    getComputerActions,
    registerAddComputerItem,
    registerComputerAction,
    registerSessionPage,
    resetFleetRegistryForTests,
    resolveSessionPage,
    type FleetComputerActionRegistration,
} from './registry';

/**
 * Fleet hub (FL-01, CONTRACTS §11.1 revision 6) — the registry hooks FL-04,
 * FL-07, FL-16 and FL-17 fill without editing FL-01's files: "Add computer ▾"
 * entries (`registerAddComputerItem`), header and ⋯ menu acts
 * (`registerComputerAction`) and the one session page
 * (`registerSessionPage`), plus the page's mirror of the family check every
 * registered act receives.
 */

const Panel = () => null;
const load = async () => ({ default: Panel });

const viewed = (over: Partial<FleetNodeView> = {}): FleetNodeView =>
    ({
        id: 'n1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        capabilities: [],
        persisted: true,
        controlPolicy: 'owner',
        controlPolicyFamilies: null,
        ...over,
    }) as FleetNodeView;

const action = (
    over: Partial<FleetComputerActionRegistration> & Pick<FleetComputerActionRegistration, 'id'>,
): FleetComputerActionRegistration => ({
    placement: 'menu',
    order: 10,
    epic: 'FL-16',
    family: 'machines',
    load,
    ...over,
});

afterEach(() => resetFleetRegistryForTests());

describe('registerAddComputerItem / getAddComputerItems', () => {
    it('lists the entries whose flag is on, by order then id', () => {
        registerAddComputerItem({
            id: 'fl-17.cloud',
            order: 40,
            epic: 'FL-17',
            flag: 'FLEET_CLOUD_ENABLED',
            labelKey: 'fleet.cloud.addItem',
            href: '/fleet/computers?add=cloud',
            icon: 'cloud',
        });
        registerAddComputerItem({
            id: 'fl-16.virtual',
            order: 30,
            epic: 'FL-16',
            flag: 'FLEET_VIRTUAL_ENABLED',
            labelKey: 'fleet.virtual.addItem',
            href: '/fleet/computers?add=virtual',
            icon: 'virtual',
        });
        registerAddComputerItem({
            id: 'fl-99.b',
            order: 50,
            epic: 'FL-99',
            labelKey: 'fleet.x.b',
            href: '/fleet/b',
        });
        registerAddComputerItem({
            id: 'fl-99.a',
            order: 50,
            epic: 'FL-99',
            labelKey: 'fleet.x.a',
            href: '/fleet/a',
        });

        expect(getAddComputerItems({}).map((item) => item.id)).toEqual(['fl-99.a', 'fl-99.b']);
        expect(
            getAddComputerItems({ FLEET_CLOUD_ENABLED: true, FLEET_VIRTUAL_ENABLED: true }).map(
                (item) => item.id,
            ),
        ).toEqual(['fl-16.virtual', 'fl-17.cloud', 'fl-99.a', 'fl-99.b']);
        // A flag that is present but not `true` keeps the entry hidden.
        expect(getAddComputerItems({ FLEET_CLOUD_ENABLED: false }).map((item) => item.id)).toEqual([
            'fl-99.a',
            'fl-99.b',
        ]);
    });

    it.each([
        'https://example.com/add',
        '//example.com/add',
        'fleet/add',
        '/fleet/add computer',
        '/fleet\\add',
    ])('refuses an entry that does not link to an app route (%s)', (href) => {
        expect(() =>
            registerAddComputerItem({ id: 'bad', order: 1, epic: 'FL-99', labelKey: 'k', href }),
        ).toThrow(/must link to an app route/);
        expect(getAddComputerItems({})).toEqual([]);
    });

    it('keeps the last registration of one id (hot reload)', () => {
        const entry = { id: 'fl-16.virtual', order: 30, epic: 'FL-16', labelKey: 'k' };
        registerAddComputerItem({ ...entry, href: '/fleet/one' });
        registerAddComputerItem({ ...entry, href: '/fleet/two' });
        expect(getAddComputerItems({}).map((item) => item.href)).toEqual(['/fleet/two']);
    });
});

describe('registerComputerAction / getComputerActions', () => {
    it('answers one placement at a time, flag-gated, by order then id', () => {
        registerComputerAction(action({ id: 'fl-16.stop-vm', order: 20 }));
        registerComputerAction(
            action({ id: 'fl-17.destroy', order: 30, flag: 'FLEET_CLOUD_ENABLED' }),
        );
        registerComputerAction(action({ id: 'fl-16.b', order: 20 }));
        registerComputerAction(
            action({
                id: 'fl-04.new-session',
                placement: 'header',
                order: 10,
                epic: 'FL-04',
                family: 'sessions',
                flag: 'FLEET_SESSIONS_ENABLED',
                replaces: 'new-session',
            }),
        );

        expect(getComputerActions('menu', {}).map((entry) => entry.id)).toEqual([
            'fl-16.b',
            'fl-16.stop-vm',
        ]);
        expect(
            getComputerActions('menu', { FLEET_CLOUD_ENABLED: true }).map((entry) => entry.id),
        ).toEqual(['fl-16.b', 'fl-16.stop-vm', 'fl-17.destroy']);
        expect(getComputerActions('header', {})).toEqual([]);
        expect(
            getComputerActions('header', { FLEET_SESSIONS_ENABLED: true }).map((entry) => entry.id),
        ).toEqual(['fl-04.new-session']);
    });

    it('refuses `replaces` on a menu entry — only the header has placeholders', () => {
        expect(() =>
            registerComputerAction(action({ id: 'fl-99.menu', replaces: 'desktop' })),
        ).toThrow(/only a header action can/);
        expect(getComputerActions('menu', {})).toEqual([]);
    });

    it('refuses a second action taking a placeholder already taken, keeping the first', () => {
        registerComputerAction(
            action({ id: 'fl-07.desktop', placement: 'header', replaces: 'desktop' }),
        );
        expect(() =>
            registerComputerAction(
                action({ id: 'fl-99.desktop', placement: 'header', replaces: 'desktop' }),
            ),
        ).toThrow(/already taken by "fl-07.desktop"/);
        expect(getComputerActions('header', {}).map((entry) => entry.id)).toEqual([
            'fl-07.desktop',
        ]);
    });

    it('lets the same action register again (hot reload)', () => {
        const desktop = action({ id: 'fl-07.desktop', placement: 'header', replaces: 'desktop' });
        registerComputerAction(desktop);
        expect(() => registerComputerAction({ ...desktop, order: 5 })).not.toThrow();
        expect(getComputerActions('header', {}).map((entry) => entry.order)).toEqual([5]);
    });

    it('lets two header actions sit after the placeholders without replacing any', () => {
        registerComputerAction(action({ id: 'fl-10.ports', placement: 'header', order: 20 }));
        registerComputerAction(action({ id: 'fl-08.logs', placement: 'header', order: 10 }));
        expect(getComputerActions('header', {}).map((entry) => entry.id)).toEqual([
            'fl-08.logs',
            'fl-10.ports',
        ]);
    });
});

describe('computerActionAllowed / computerActionProps (the page mirrors the server)', () => {
    it('always admits the owner, and a row without a role is the owner’s', () => {
        expect(computerActionAllowed(viewed({ viewerRole: 'owner' }), 'machines')).toBe(true);
        expect(computerActionAllowed(viewed({ viewerRole: undefined }), 'docker')).toBe(true);
    });

    it('admits an organisation role only where the family’s audience includes it', () => {
        const shared = viewed({
            viewerRole: 'org-admin',
            controlPolicyFamilies: {
                view: 'org-members',
                machines: 'org-admins',
            } as FleetNodeView['controlPolicyFamilies'],
        });
        expect(computerActionAllowed(shared, 'machines')).toBe(true);
        expect(computerActionAllowed(shared, 'docker')).toBe(false);
        expect(computerActionAllowed({ ...shared, viewerRole: 'org-member' }, 'machines')).toBe(
            false,
        );
    });

    it('never admits a stranger to an act', () => {
        expect(computerActionAllowed(viewed({ viewerRole: 'stranger' }), 'machines')).toBe(false);
    });

    it('hands a registered action the node, the flags, the role and the verdict', () => {
        const node = viewed({ viewerRole: 'org-member' });
        const flags = { FLEET_VIRTUAL_ENABLED: true };
        expect(computerActionProps(node, flags, { family: 'machines' })).toEqual({
            node,
            flags,
            viewerRole: 'org-member',
            allowed: false,
        });
        expect(computerActionProps(viewed(), {}, { family: 'machines' })).toMatchObject({
            viewerRole: 'owner',
            allowed: true,
        });
    });
});

describe('registerSessionPage / resolveSessionPage', () => {
    it('names FL-04 until the page is registered', () => {
        expect(resolveSessionPage({})).toEqual({ kind: 'not-shipped', epic: 'FL-04' });
    });

    it('is switched off until its flag is on, then ready', () => {
        registerSessionPage({ epic: 'FL-04', flag: 'FLEET_SESSIONS_ENABLED', load });
        expect(resolveSessionPage({})).toEqual({ kind: 'switched-off', epic: 'FL-04' });
        expect(resolveSessionPage({ FLEET_SESSIONS_ENABLED: false }).kind).toBe('switched-off');
        const ready = resolveSessionPage({ FLEET_SESSIONS_ENABLED: true });
        expect(ready.kind).toBe('ready');
        expect(ready.kind === 'ready' && ready.load).toBe(load);
    });
});

describe('resetFleetRegistryForTests', () => {
    it('forgets the revision 6 registrations too', () => {
        registerAddComputerItem({ id: 'x', order: 1, epic: 'FL-99', labelKey: 'k', href: '/x' });
        registerComputerAction(action({ id: 'y' }));
        registerSessionPage({ epic: 'FL-04', flag: 'FLEET_SESSIONS_ENABLED', load });
        resetFleetRegistryForTests();
        expect(getAddComputerItems({})).toEqual([]);
        expect(getComputerActions('menu', {})).toEqual([]);
        expect(resolveSessionPage({ FLEET_SESSIONS_ENABLED: true }).kind).toBe('not-shipped');
    });
});
