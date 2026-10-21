import {
    FLEET_NODE_UPGRADE_COMMAND,
    normalizeNeedsALookItem,
    type FleetNodeView,
} from '@ever-works/contracts';
import {
    NodeUpgradeRequiredProducer,
    computerSettingsRoute,
    nodeUpgradeRequiredItems,
} from '../needs-a-look/producers/node-upgrade-required.producer';
import { FL02_NEEDS_A_LOOK_PRODUCERS } from '../needs-a-look/producers';

const NOW = new Date('2026-10-21T09:41:00.000Z');
const CONTEXT = { now: NOW };
const RECENT_BEAT = '2026-10-21T09:40:12.000Z';

function node(overrides: Partial<FleetNodeView> & Record<string, unknown> = {}): FleetNodeView {
    return {
        id: 'n2',
        name: 'build-02',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '0.2.1',
        capabilities: [],
        lastHeartbeatAt: RECENT_BEAT,
        createdAt: '2026-10-01T00:00:00.000Z',
        persisted: true,
        upgradeRequired: true,
        minNodeVersion: '0.3.0',
        ...overrides,
    } as FleetNodeView;
}

/**
 * Fleet node link (FL-02, T-24, FR-36, spec S11) — one `info` item per
 * computer below the version floor, with a stable id, the exact command, and
 * the Settings tab (where the copy button is) as its action; none at or above
 * the floor.
 */
describe('node-upgrade-required producer', () => {
    it('raises one info item for a below-floor computer, naming its version, the floor and the command', () => {
        const items = nodeUpgradeRequiredItems([node()], CONTEXT);
        expect(items).toEqual([
            {
                id: 'node-upgrade-required:n2',
                nodeId: 'n2',
                severity: 'info',
                kind: 'node-upgrade-required',
                title: 'build-02 runs ever-works-node 0.2.1; this deployment needs 0.3.0 or newer. It takes no work until it is upgraded.',
                detail: `On build-02, run: ${FLEET_NODE_UPGRADE_COMMAND} — then restart the node service.`,
                action: { label: 'Show command', route: computerSettingsRoute('n2') },
                since: RECENT_BEAT,
            },
        ]);
        // Exactly CONTRACTS §4.6: the registry's own normaliser keeps it as is.
        expect(normalizeNeedsALookItem(items[0])).toEqual(items[0]);
    });

    it('keeps the same id across reads', () => {
        const first = nodeUpgradeRequiredItems([node()], CONTEXT)[0];
        const second = nodeUpgradeRequiredItems(
            [node({ lastHeartbeatAt: '2026-10-21T09:41:00.000Z' })],
            CONTEXT,
        )[0];
        expect(second.id).toBe(first.id);
    });

    it('says nothing for a computer at or above the floor, or one whose version could not be judged', () => {
        expect(
            nodeUpgradeRequiredItems([node({ upgradeRequired: false, version: '0.3.0' })], CONTEXT),
        ).toEqual([]);
        expect(nodeUpgradeRequiredItems([node({ upgradeRequired: undefined })], CONTEXT)).toEqual(
            [],
        );
    });

    it('skips an offline computer, a cluster row and an unsaved one', () => {
        expect(nodeUpgradeRequiredItems([node({ status: 'offline' })], CONTEXT)).toEqual([]);
        expect(
            nodeUpgradeRequiredItems(
                [node({ lastHeartbeatAt: '2026-10-20T00:00:00.000Z' })],
                CONTEXT,
            ),
        ).toEqual([]);
        expect(nodeUpgradeRequiredItems([node({ kind: 'k8s' })], CONTEXT)).toEqual([]);
        expect(nodeUpgradeRequiredItems([node({ persisted: false })], CONTEXT)).toEqual([]);
    });

    it('still reads when the version or the floor is missing', () => {
        const [item] = nodeUpgradeRequiredItems(
            [node({ version: null, minNodeVersion: null })],
            CONTEXT,
        );
        expect(item.title).toBe(
            'build-02 runs an older ever-works-node; this deployment needs a newer version. It takes no work until it is upgraded.',
        );
    });

    it('is registered as FL-02’s producer', () => {
        expect(FL02_NEEDS_A_LOOK_PRODUCERS).toEqual([NodeUpgradeRequiredProducer]);
        expect(new NodeUpgradeRequiredProducer().id).toBe('fl-02.node-upgrade-required');
        expect(
            new NodeUpgradeRequiredProducer().produce([node()], { ...CONTEXT, userId: 'u1' }),
        ).toHaveLength(1);
    });
});
