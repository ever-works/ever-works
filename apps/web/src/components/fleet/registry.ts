import type { ComponentType } from 'react';
import type { FleetActionFamily, FleetNodeView } from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';

/**
 * Fleet hub (FL-01) — the internal module registry the hub and the computer
 * page are assembled from (README D9, CONTRACTS §11.1).
 *
 * Every Fleet epic ships its own tab or block without touching another's:
 * it adds ONE registration file under `components/fleet/modules/` that
 * calls {@link registerHubTab}, {@link registerComputerTab} or
 * {@link registerOverviewBlock}, plus one import line in
 * `components/fleet/modules/index.ts`. Each registration carries a `load`
 * that dynamically imports its component, so a tab's bundle is fetched only
 * when the tab is shown (spec FR-18).
 *
 * The tab STRIPS are fixed here, in order, with the epic that owns each tab,
 * the flag it ships behind (CONTRACTS §9) and the consent it needs
 * (CONTRACTS §1.1). A tab nobody registered renders an honest placeholder
 * naming its epic — never a spinner, never an inert tab (FR-4) — and the
 * placeholder text derives from the registry, so a registered tab can never
 * show "arrives with".
 *
 * This is compile-time and internal; plugin-contributed web UI does not
 * exist and is not introduced here (D9).
 */

// ─── Flags ──────────────────────────────────────────────────────────────────

/** The per-epic flags of CONTRACTS §9 a tab can ride behind (all default off). */
export const FLEET_FEATURE_FLAGS = [
    'FLEET_NODE_LINK_ENABLED',
    'FLEET_HEALTH_HISTORY_ENABLED',
    'FLEET_SESSIONS_ENABLED',
    'FLEET_DESKTOP_ENABLED',
    'FLEET_MACHINE_FACTS_ENABLED',
    'FLEET_PORT_TUNNEL_ENABLED',
    'FLEET_COMMANDS_ENABLED',
    'FLEET_CHECKOUTS_ENABLED',
    'FLEET_VIRTUAL_ENABLED',
    'FLEET_CLOUD_ENABLED',
    'FLEET_ACTIONS_RUNNERS_ENABLED',
    'FLEET_USAGE_SCAN_ENABLED',
] as const;

export type FleetFeatureFlag = (typeof FLEET_FEATURE_FLAGS)[number];

/** Which flags are on, read on the server (`readFleetFeatureFlags`) and passed down. */
export type FleetFeatureFlags = Partial<Record<FleetFeatureFlag, boolean>>;

// ─── Consents ───────────────────────────────────────────────────────────────

/** The node-side consents a tab can need (CONTRACTS §1.1). */
export type FleetTabConsent = 'work' | 'attend' | 'manage';

/** The flag on the machine that grants a consent — what a placeholder tells the owner to run. */
export const FLEET_CONSENT_START_COMMANDS: Readonly<Record<FleetTabConsent, string>> = {
    work: 'ever-works-node start --work',
    attend: 'ever-works-node start --attend',
    manage: 'ever-works-node start --manage',
};

// ─── Tab strips ─────────────────────────────────────────────────────────────

interface FleetTabSlot {
    /** The epic that fills this tab (the placeholder names it). */
    epic: string;
    /** The epic's flag; absent = ships with the hub itself. */
    flag?: FleetFeatureFlag;
}

/** The six hub tabs, in order (FR-3). Each is a route of its own. */
export const FLEET_HUB_TABS = [
    { id: 'overview', epic: 'FL-01', href: ROUTES.DASHBOARD_FLEET },
    { id: 'computers', epic: 'FL-01', href: ROUTES.DASHBOARD_FLEET_COMPUTERS },
    {
        id: 'sessions',
        epic: 'FL-05',
        flag: 'FLEET_SESSIONS_ENABLED',
        href: ROUTES.DASHBOARD_FLEET_SESSIONS,
    },
    {
        id: 'checkouts',
        epic: 'FL-14',
        flag: 'FLEET_CHECKOUTS_ENABLED',
        href: ROUTES.DASHBOARD_FLEET_CHECKOUTS,
    },
    {
        id: 'commands',
        epic: 'FL-12',
        flag: 'FLEET_COMMANDS_ENABLED',
        href: ROUTES.DASHBOARD_FLEET_COMMANDS,
    },
    {
        id: 'usage',
        epic: 'FL-20',
        flag: 'FLEET_USAGE_SCAN_ENABLED',
        href: ROUTES.DASHBOARD_FLEET_USAGE,
    },
] as const satisfies ReadonlyArray<FleetTabSlot & { id: string; href: string }>;

export type FleetHubTabId = (typeof FLEET_HUB_TABS)[number]['id'];

export const FLEET_HUB_TAB_IDS: readonly FleetHubTabId[] = FLEET_HUB_TABS.map((tab) => tab.id);

/**
 * The twelve computer-page tabs, in order (FR-17, CONTRACTS §11.1), with the
 * consent each needs on the machine and the action family it reads under.
 */
export const FLEET_COMPUTER_TABS = [
    { id: 'overview', epic: 'FL-01', family: 'view' },
    { id: 'sessions', epic: 'FL-04', flag: 'FLEET_SESSIONS_ENABLED', family: 'sessions' },
    {
        id: 'desktop',
        epic: 'FL-07',
        flag: 'FLEET_DESKTOP_ENABLED',
        consent: 'attend',
        family: 'desktop',
    },
    {
        id: 'logs',
        epic: 'FL-08',
        flag: 'FLEET_MACHINE_FACTS_ENABLED',
        consent: 'manage',
        family: 'logs',
    },
    {
        id: 'services',
        epic: 'FL-09',
        flag: 'FLEET_MACHINE_FACTS_ENABLED',
        consent: 'manage',
        family: 'services',
    },
    {
        id: 'docker',
        epic: 'FL-09',
        flag: 'FLEET_MACHINE_FACTS_ENABLED',
        consent: 'manage',
        family: 'docker',
    },
    {
        id: 'processes',
        epic: 'FL-09',
        flag: 'FLEET_MACHINE_FACTS_ENABLED',
        consent: 'manage',
        family: 'processes',
    },
    {
        id: 'ports',
        epic: 'FL-10',
        flag: 'FLEET_MACHINE_FACTS_ENABLED',
        consent: 'manage',
        family: 'ports',
    },
    {
        id: 'files',
        epic: 'FL-11',
        flag: 'FLEET_MACHINE_FACTS_ENABLED',
        consent: 'manage',
        family: 'files',
    },
    {
        id: 'schedules',
        epic: 'FL-13',
        flag: 'FLEET_COMMANDS_ENABLED',
        consent: 'manage',
        family: 'schedules',
    },
    {
        id: 'checkouts',
        epic: 'FL-14',
        flag: 'FLEET_CHECKOUTS_ENABLED',
        consent: 'manage',
        family: 'checkouts',
    },
    { id: 'settings', epic: 'FL-01', family: 'view' },
] as const satisfies ReadonlyArray<
    FleetTabSlot & { id: string; consent?: FleetTabConsent; family: FleetActionFamily }
>;

export type FleetComputerTabId = (typeof FLEET_COMPUTER_TABS)[number]['id'];

export const FLEET_COMPUTER_TAB_IDS: readonly FleetComputerTabId[] = FLEET_COMPUTER_TABS.map(
    (tab) => tab.id,
);

export function isFleetComputerTabId(value: unknown): value is FleetComputerTabId {
    return (
        typeof value === 'string' && (FLEET_COMPUTER_TAB_IDS as readonly string[]).includes(value)
    );
}

/** The tab a `?tab=` value selects: a known id, else Overview (FR-17). */
export function resolveComputerTabId(value: unknown): FleetComputerTabId {
    const raw = Array.isArray(value) ? value[0] : value;
    return isFleetComputerTabId(raw) ? raw : 'overview';
}

// ─── Registrations ──────────────────────────────────────────────────────────

/** What a computer-page tab component receives. */
export interface FleetComputerTabProps {
    node: FleetNodeView;
    flags: FleetFeatureFlags;
}

/** What a hub tab component receives. */
export interface FleetHubTabProps {
    nodes: FleetNodeView[];
    flags: FleetFeatureFlags;
}

/** What an Overview block receives (the hub's Overview, or one computer's). */
export interface FleetOverviewBlockProps {
    /** Every computer the viewer may see (hub), or exactly one (computer page). */
    nodes: FleetNodeView[];
    flags: FleetFeatureFlags;
}

type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

export interface FleetComputerTabRegistration {
    id: FleetComputerTabId;
    load: Loader<FleetComputerTabProps>;
}

export interface FleetHubTabRegistration {
    id: FleetHubTabId;
    load: Loader<FleetHubTabProps>;
}

export interface FleetOverviewBlockRegistration {
    /** Unique block id, e.g. `fl-03.health-metrics`. */
    id: string;
    /** Which Overview the block sits on. */
    surface: 'hub' | 'computer';
    /** Lower renders first. FL-01's own "needs a look" block is 100. */
    order: number;
    /** The epic that ships it. */
    epic: string;
    /** Rendered only while this flag is on. */
    flag?: FleetFeatureFlag;
    load: Loader<FleetOverviewBlockProps>;
}

const computerTabs = new Map<FleetComputerTabId, FleetComputerTabRegistration>();
const hubTabs = new Map<FleetHubTabId, FleetHubTabRegistration>();
const overviewBlocks = new Map<string, FleetOverviewBlockRegistration>();

function assertKnown(kind: string, id: string, known: readonly string[]): void {
    if (!known.includes(id)) {
        // A typo here would silently ship nothing; fail at import time instead.
        throw new Error(`Unknown Fleet ${kind} "${id}"; expected one of: ${known.join(', ')}`);
    }
}

/** Fill one of the twelve computer-page tabs. Registering a tab twice keeps the last (hot reload). */
export function registerComputerTab(registration: FleetComputerTabRegistration): void {
    assertKnown('computer tab', registration.id, FLEET_COMPUTER_TAB_IDS);
    computerTabs.set(registration.id, registration);
}

/** Fill one of the six hub tabs. */
export function registerHubTab(registration: FleetHubTabRegistration): void {
    assertKnown('hub tab', registration.id, FLEET_HUB_TAB_IDS);
    hubTabs.set(registration.id, registration);
}

/** Add a block to the hub's Overview or to every computer page's Overview tab. */
export function registerOverviewBlock(registration: FleetOverviewBlockRegistration): void {
    overviewBlocks.set(registration.id, registration);
}

/** The Overview blocks for one surface whose flag is on, in render order. */
export function getOverviewBlocks(
    surface: FleetOverviewBlockRegistration['surface'],
    flags: FleetFeatureFlags,
): FleetOverviewBlockRegistration[] {
    return [...overviewBlocks.values()]
        .filter((block) => block.surface === surface && (!block.flag || flags[block.flag] === true))
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** For tests only: forget every registration. */
export function resetFleetRegistryForTests(): void {
    computerTabs.clear();
    hubTabs.clear();
    overviewBlocks.clear();
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * What one tab renders, decided once from the registry, the flags and the
 * computer (spec U4–U6, FR-18–FR-20), in this order:
 *
 *  1. `not-shipped`    — nothing registered it: "Logs arrive with FL-08."
 *  2. `switched-off`   — registered, its flag is off: "… switched off on this deployment."
 *  3. `kind-cannot`    — this kind of computer cannot give the consent yet (R-10).
 *  4. `consent-missing`— the computer did not opt in: the exact command, copyable.
 *  5. `ready`          — render the registered component.
 */
export type FleetTabState<P> =
    | { kind: 'ready'; load: Loader<P> }
    | { kind: 'not-shipped'; epic: string }
    | { kind: 'switched-off'; epic: string }
    | { kind: 'kind-cannot' }
    | { kind: 'consent-missing'; consent: FleetTabConsent; command: string };

/** The consents a computer reports, as far as this build can tell. */
export type FleetConsentsRead = Readonly<Record<FleetTabConsent, boolean>>;

/**
 * Kinds of computer that cannot give a consent yet whatever they report:
 * `apps/desktop-node` has no `--attend` or `--manage` wiring until FL-02's
 * last phase (README D3, R-10).
 */
const KIND_CANNOT: Readonly<Partial<Record<FleetNodeView['kind'], readonly FleetTabConsent[]>>> = {
    'desktop-node': ['attend', 'manage'],
    k8s: ['work', 'attend', 'manage'],
};

function resolveSlot<P>(
    slot: FleetTabSlot & { consent?: FleetTabConsent },
    registered: { load: Loader<P> } | undefined,
    context: {
        flags: FleetFeatureFlags;
        node?: Pick<FleetNodeView, 'kind'>;
        consents?: FleetConsentsRead;
    },
): FleetTabState<P> {
    if (!registered) return { kind: 'not-shipped', epic: slot.epic };
    if (slot.flag && context.flags[slot.flag] !== true)
        return { kind: 'switched-off', epic: slot.epic };
    const consent = slot.consent;
    if (consent && context.node) {
        const granted = context.consents?.[consent] === true;
        if (!granted && KIND_CANNOT[context.node.kind]?.includes(consent))
            return { kind: 'kind-cannot' };
        if (!granted) {
            return {
                kind: 'consent-missing',
                consent,
                command: FLEET_CONSENT_START_COMMANDS[consent],
            };
        }
    }
    return { kind: 'ready', load: registered.load };
}

/** What a computer-page tab renders for this computer. */
export function resolveComputerTab(
    id: FleetComputerTabId,
    context: {
        flags: FleetFeatureFlags;
        node: Pick<FleetNodeView, 'kind'>;
        consents: FleetConsentsRead;
    },
): FleetTabState<FleetComputerTabProps> {
    const slot = FLEET_COMPUTER_TABS.find((tab) => tab.id === id) ?? FLEET_COMPUTER_TABS[0];
    return resolveSlot(slot, computerTabs.get(slot.id), context);
}

/** What a hub tab renders. */
export function resolveHubTab(
    id: FleetHubTabId,
    context: { flags: FleetFeatureFlags },
): FleetTabState<FleetHubTabProps> {
    const slot = FLEET_HUB_TABS.find((tab) => tab.id === id) ?? FLEET_HUB_TABS[0];
    return resolveSlot(slot, hubTabs.get(slot.id), context);
}
