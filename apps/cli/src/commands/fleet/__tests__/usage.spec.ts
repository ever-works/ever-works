import { describe, expect, it } from 'vitest';
import { FLEET_USAGE_PAYER_NOTE, type FleetUsageView } from '@ever-works/contracts';
import { parseFleetUsageDays, renderFleetUsage } from '../usage';

/** FL-20 T-19 — `ever-works fleet usage`: the periods, and the tab's object rendered with the payer sentence. */

const NOW = Date.parse('2026-10-21T12:00:00.000Z');

function view(overrides: Partial<FleetUsageView> = {}): FleetUsageView {
    return {
        days: 7,
        from: '2026-10-14T12:00:00.000Z',
        to: '2026-10-21T12:00:00.000Z',
        nodeId: null,
        model: null,
        totals: { costCents: 4120, tokens: { in: 1000, out: 2000, cacheRead: 18_000_000, cacheWrite: 400_000 }, requests: 1212, topModel: 'claude-sonnet-4-5' },
        byModel: [
            { model: 'claude-sonnet-4-5', provider: 'claude-code', tokens: { in: 1000, out: 2000, cacheRead: 0, cacheWrite: 0 }, requests: 912, costCents: 3140 },
            { model: 'local-7b', provider: 'codex', tokens: { in: 10, out: 10, cacheRead: 0, cacheWrite: 0 }, requests: 12, costCents: null },
        ],
        byNode: [
            {
                nodeId: 'n1',
                name: 'build-01',
                scan: { state: 'on', online: true, lastScanAt: '2026-10-21T11:56:00.000Z', backlogPct: 0, hint: null },
                costCents: 2210,
                tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
                requests: 10,
            },
            {
                nodeId: 'n2',
                name: 'design-mac',
                scan: { state: 'on', online: false, lastScanAt: '2026-10-19T12:00:00.000Z', backlogPct: 0, hint: null },
                costCents: 420,
                tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
                requests: 2,
            },
            {
                nodeId: 'n3',
                name: 'laptop',
                scan: {
                    state: 'off',
                    online: true,
                    lastScanAt: null,
                    backlogPct: null,
                    hint: 'Usage scan is off — run `ever-works-node start --usage-scan` on laptop',
                },
                costCents: null,
                tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
                requests: 0,
            },
        ],
        busiestCheckouts: [{ nodeId: 'n1', nodeName: 'build-01', path: '/home/me/code/api', checkoutId: null, costCents: 1830, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } }],
        sessions: { agents: [{ agentId: 'a1', name: 'Nina', sessions: 14, costCents: 900 }], owner: { sessions: 9, costCents: 100 }, other: { sessions: 7, costCents: 50 } },
        unknownModels: { models: ['local-7b'], requests: 12 },
        excluded: { nodes: 0, otherHidden: false },
        catchingUp: null,
        priceList: { version: 1, effectiveFrom: '2026-10-21', versionsUsed: [1] },
        note: FLEET_USAGE_PAYER_NOTE,
        ...overrides,
    };
}

// eslint-disable-next-line no-control-regex
const plain = (lines: string[]) => lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');

describe('fleet usage', () => {
    it('accepts only the four periods', () => {
        expect(parseFleetUsageDays(undefined)).toBe(7);
        expect(parseFleetUsageDays('30')).toBe(30);
        expect(parseFleetUsageDays('14')).toBeNull();
        expect(parseFleetUsageDays('abc')).toBeNull();
    });

    it('renders the totals, the payer sentence verbatim, unknown models as tokens only, and every computer', () => {
        const text = plain(renderFleetUsage(view(), NOW));
        expect(text).toContain('$41.20 at list price');
        expect(text).toContain(FLEET_USAGE_PAYER_NOTE);
        expect(text).toContain('Excludes 12 requests on unknown models (local-7b) — tokens only.');
        expect(text).toContain('scanned 4 min ago');
        expect(text).toContain('offline · scanned 2 d ago');
        expect(text).toContain('Usage scan is off — run `ever-works-node start --usage-scan` on laptop');
        expect(text).toContain('other (not started from Ever Works) 7');
        expect(text).toContain('/home/me/code/api on build-01 $18.30');
    });
});
