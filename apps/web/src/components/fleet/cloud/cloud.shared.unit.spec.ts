import { describe, expect, it } from 'vitest';
import type { FleetCloudOptionsView, FleetNodeCloudView } from '@ever-works/contracts';
import {
    changedPriceOf,
    cloudDisplayState,
    cloudPowerChoice,
    cloudRemoveAvailability,
    createLabelPrice,
    formatSince,
    initialCloudForm,
    sizesForRegion,
    withOptionDefaults,
} from './cloud.shared';

/** Cloud computers (FL-17, T-16) — the pure decisions behind the row, the block and the dialog. */

const NOW = Date.parse('2026-10-21T12:00:00.000Z');

function cloud(overrides: Partial<FleetNodeCloudView> = {}): FleetNodeCloudView {
    return {
        providerPluginId: 'machines-plugin',
        providerName: 'Provider',
        regionId: 'nyc3',
        regionLabel: 'New York 3',
        sizeId: 's-2',
        sizeLabel: '2 CPU · 4 GB · 80 GB',
        vcpus: 2,
        memoryMiB: 4096,
        diskGiB: 80,
        hourlyRateCents: 3.571,
        monthlyPriceCents: 2400,
        currency: 'USD',
        billsWhileOff: true,
        imageLabel: null,
        createdAt: '2026-10-21T11:00:00.000Z',
        machineCreatedAt: '2026-10-21T11:00:00.000Z',
        phase: 'online',
        phaseAt: '2026-10-21T11:05:00.000Z',
        powerState: 'running',
        powerStateAt: '2026-10-21T11:05:00.000Z',
        pending: null,
        error: null,
        ipv4: null,
        software: ['docker'],
        idlePolicy: { mode: 'tell-me', afterHours: 3 },
        idleSince: null,
        cost: { hourlyCents: 3.571, monthToDateCents: 3.6, sinceCreatedCents: 3.6, projectedMonthCents: 2400, computedAt: '' },
        goneAt: null,
        hasMachine: true,
        removable: false,
        ...overrides,
    };
}

const OPTIONS: FleetCloudOptionsView = {
    pluginId: 'machines-plugin',
    providerName: 'Provider',
    regions: [
        { id: 'old1', label: 'Retired', available: false },
        { id: 'nyc3', label: 'New York 3', available: true },
    ],
    sizes: [
        { id: 's-1', label: '1', vcpus: 1, memoryMiB: 2048, diskGiB: 50, priceHourlyCents: 1.786, priceMonthlyCents: 1200, regions: ['nyc3'], available: true },
        { id: 's-2', label: '2', vcpus: 2, memoryMiB: 4096, diskGiB: 80, priceHourlyCents: 3.571, priceMonthlyCents: 2400, regions: ['nyc3'], available: true },
        { id: 's-4', label: '4', vcpus: 4, memoryMiB: 8192, diskGiB: 160, priceHourlyCents: 7.143, priceMonthlyCents: 4800, regions: ['nyc3'], available: true },
        { id: 's-fra', label: 'fra', vcpus: 2, memoryMiB: 4096, diskGiB: 80, priceHourlyCents: 3.571, priceMonthlyCents: 2400, regions: ['fra1'], available: true },
    ],
    software: [{ id: 'docker', default: true }],
    billsWhileOff: true,
    currency: 'USD',
    account: { label: 'acme' },
    imageLabel: null,
    fetchedAt: '',
    limits: { maxPerOwner: 10, used: 0 },
};

describe('cloud.shared (FL-17)', () => {
    it('reads the display state from the row', () => {
        expect(cloudDisplayState({ status: 'online' }, cloud(), NOW)).toBe('running');
        expect(cloudDisplayState({ status: 'offline' }, cloud({ powerState: 'off' }), NOW)).toBe('off');
        expect(cloudDisplayState({ status: 'enrolling' }, cloud({ phase: 'booting', machineCreatedAt: '2026-10-21T11:55:00.000Z' }), NOW)).toBe('creating');
        // Ten minutes after the provider's create and still enrolling: needs a look (FR-11).
        expect(cloudDisplayState({ status: 'enrolling' }, cloud({ phase: 'installing' }), NOW)).toBe('unenrolled');
        expect(cloudDisplayState({ status: 'enrolling' }, cloud({ phase: 'failed' }), NOW)).toBe('failed');
        expect(cloudDisplayState({ status: 'online' }, cloud({ pending: 'powering-off' }), NOW)).toBe('poweringOff');
        expect(cloudDisplayState({ status: 'offline' }, cloud({ powerState: 'gone' }), NOW)).toBe('gone');
    });

    it('offers the power act that fits', () => {
        expect(cloudPowerChoice('running')).toBe('off');
        expect(cloudPowerChoice('off')).toBe('on');
        expect(cloudPowerChoice('creating')).toBeNull();
        expect(cloudPowerChoice('gone')).toBeNull();
    });

    it('disables Remove for a billing machine and enables it once gone or never created (R-36)', () => {
        expect(cloudRemoveAvailability({ cloud: cloud({ removable: false }) })).toEqual({
            allowed: false,
            reasonKey: 'removeUnavailable.line',
        });
        expect(cloudRemoveAvailability({ cloud: cloud({ removable: true, powerState: 'gone' }) }).allowed).toBe(true);
        expect(cloudRemoveAvailability({ cloud: null }).allowed).toBe(true);
    });

    it('defaults the form to the first available region and the middle size', () => {
        const form = withOptionDefaults(initialCloudForm('machines-plugin'), OPTIONS);
        expect(form.regionId).toBe('nyc3');
        expect(form.sizeId).toBe('s-2');
        expect(form.software).toEqual(['docker', 'node', 'claude-code', 'codex']);
        expect(sizesForRegion(OPTIONS, 'nyc3').map((size) => size.id)).toEqual(['s-1', 's-2', 's-4']);
    });

    it('puts the price on the Create button and reads a changed price', () => {
        expect(createLabelPrice(OPTIONS.sizes[1], 'USD')).toBe('$24');
        expect(createLabelPrice(null)).toBeNull();
        expect(
            changedPriceOf({ code: 'invalid', details: { field: 'acknowledgedPriceCents', currentPriceCents: 2600 } }),
        ).toBe(2600);
        expect(changedPriceOf({ code: 'invalid', details: { field: 'name' } })).toBeNull();
        expect(changedPriceOf(null)).toBeNull();
    });

    it('formats how long ago', () => {
        expect(formatSince('2026-10-21T11:48:00.000Z', NOW)).toBe('12 min');
        expect(formatSince('2026-10-21T08:00:00.000Z', NOW)).toBe('4 h');
        expect(formatSince('2026-10-18T05:00:00.000Z', NOW)).toBe('3 d 7 h');
        expect(formatSince(null, NOW)).toBeNull();
    });
});
