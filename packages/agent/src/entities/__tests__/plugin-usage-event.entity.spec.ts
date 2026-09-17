import { getMetadataArgsStorage } from 'typeorm';
import { PluginUsageEvent } from '../plugin-usage-event.entity';
import { UsageMeter, UsageOutcome, UsagePayer } from '../_types';

/**
 * AW-17 P1 — the usage row learns which meter it belongs to. Asserts the
 * decorator metadata the migration `AddUsageMeterClassification1791170000000`
 * mirrors, and that the leaf enums resolve at decorator time (they live in
 * `_types.ts` for the same cycle reason as `BudgetOwnerType`).
 */
describe('PluginUsageEvent entity — meter classification (AW-17)', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((c) => c.target === PluginUsageEvent);
    const indices = storage.indices.filter((i) => i.target === PluginUsageEvent);
    const relations = storage.relations.filter((r) => r.target === PluginUsageEvent);
    const column = (name: string) => columns.find((c) => c.propertyName === name);

    it('declares the seven classification columns', () => {
        expect(columns.map((c) => c.propertyName)).toEqual(
            expect.arrayContaining([
                'meter',
                'payer',
                'outcome',
                'creditsCharged',
                'priceKey',
                'priceVersion',
                'missionId',
            ]),
        );
    });

    it('keeps every classification column nullable except the defaulted credits figure', () => {
        for (const name of ['meter', 'payer', 'outcome', 'priceKey', 'priceVersion', 'missionId']) {
            expect(column(name)?.options.nullable).toBe(true);
        }
        expect(column('creditsCharged')?.options.type).toBe('int');
        expect(column('creditsCharged')?.options.default).toBe(0);
    });

    it('stores missionId as a raw uuid with no relation — audit outlives the Mission', () => {
        expect(column('missionId')?.options.type).toBe('uuid');
        expect(relations.some((r) => r.propertyName === 'missionId')).toBe(false);
        expect(relations.some((r) => r.propertyName === 'mission')).toBe(false);
    });

    it('declares the three grouping indexes, each leading with its grouping column', () => {
        const byName = (name: string) => indices.find((i) => i.name === name);
        expect(byName('idx_plugin_usage_meter_user_occurred')?.columns).toEqual([
            'userId',
            'meter',
            'occurredAt',
        ]);
        expect(byName('idx_plugin_usage_pricekey_user_occurred')?.columns).toEqual([
            'userId',
            'priceKey',
            'occurredAt',
        ]);
        expect(byName('idx_plugin_usage_mission_occurred')?.columns).toEqual([
            'missionId',
            'occurredAt',
        ]);
    });

    it('resolves the leaf enums (never undefined at decorator time)', () => {
        expect(UsageMeter.MODEL).toBe('model');
        expect(UsageMeter.CREDITS).toBe('credits');
        expect(UsageMeter.ADDON).toBe('addon');
        expect(UsagePayer.WORKSPACE).toBe('workspace');
        expect(UsagePayer.PLATFORM).toBe('platform');
        expect(UsagePayer.UNCONFIRMED).toBe('unconfirmed');
        expect(UsageOutcome.OK).toBe('ok');
        expect(UsageOutcome.CACHED).toBe('cached');
        expect(UsageOutcome.FAILED).toBe('failed');
    });
});
