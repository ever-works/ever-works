import { UsageMeter, UsageOutcome, UsagePayer } from '@src/entities/_types';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { PublishedCreditPriceList } from './credit-price-list';
import {
    classifyUsage,
    priceKeyFor,
    usagePayerFromSettingSource,
    type UsageClassificationContext,
} from './usage-meter-classifier';

/**
 * AW-17 — the meter classification is a TOTAL function: every
 * (capability × payer × outcome) input maps to exactly one meter, never two
 * and never none.
 */
describe('classifyUsage', () => {
    const priceList = new PublishedCreditPriceList();
    const context: UsageClassificationContext = {
        priceList,
        creditsForCostCents: (cents) => Math.ceil(cents),
    };
    const CAPABILITIES = Object.values(PluginUsageCapability);
    const PAYERS: Array<UsagePayer | null> = [...Object.values(UsagePayer), null];
    const OUTCOMES: Array<UsageOutcome | null> = [...Object.values(UsageOutcome), null];

    it('assigns exactly one known meter to every capability × payer × outcome', () => {
        const meters = new Set<string>(Object.values(UsageMeter));
        let cases = 0;
        for (const capability of CAPABILITIES) {
            for (const payer of PAYERS) {
                for (const outcome of OUTCOMES) {
                    const result = classifyUsage(
                        {
                            capability,
                            pluginId: 'some-plugin',
                            units: 1,
                            costCents: 7,
                            payer,
                            outcome,
                        },
                        context,
                    );
                    expect(meters.has(result.meter)).toBe(true);
                    expect(result.creditsCharged).toBeGreaterThanOrEqual(0);
                    expect(Number.isInteger(result.creditsCharged)).toBe(true);
                    cases += 1;
                }
            }
        }
        expect(cases).toBe(CAPABILITIES.length * PAYERS.length * OUTCOMES.length);
    });

    it('classifies a call paid with a Workspace-owned credential as model usage, never charged', () => {
        for (const capability of [
            PluginUsageCapability.AI,
            PluginUsageCapability.SEARCH,
            PluginUsageCapability.SCREENSHOT,
        ]) {
            const result = classifyUsage(
                {
                    capability,
                    pluginId: 'p',
                    units: 1,
                    costCents: 500,
                    payer: UsagePayer.WORKSPACE,
                },
                context,
            );
            expect(result.meter).toBe(UsageMeter.MODEL);
            expect(result.creditsCharged).toBe(0);
            expect(result.priceVersion).toBeNull();
        }
    });

    it('prices a platform-paid search from the published list, with its version', () => {
        const result = classifyUsage(
            {
                capability: PluginUsageCapability.SEARCH,
                pluginId: 'p',
                units: 1,
                costCents: 1,
                payer: UsagePayer.PLATFORM,
            },
            context,
        );
        expect(result).toMatchObject({
            meter: UsageMeter.CREDITS,
            payer: UsagePayer.PLATFORM,
            outcome: UsageOutcome.OK,
            priceKey: 'search.query',
            priceVersion: priceList.currentVersion,
            creditsCharged: 2,
            priceMissing: false,
            unconfirmed: false,
        });
    });

    it('zero-rates cached and failed calls but still records the version that priced them', () => {
        for (const outcome of [UsageOutcome.CACHED, UsageOutcome.FAILED]) {
            const result = classifyUsage(
                {
                    capability: PluginUsageCapability.EXTRACTOR,
                    pluginId: 'p',
                    units: 1,
                    costCents: 3,
                    payer: UsagePayer.PLATFORM,
                    outcome,
                },
                context,
            );
            expect(result.meter).toBe(UsageMeter.CREDITS);
            expect(result.creditsCharged).toBe(0);
            expect(result.priceVersion).toBe(priceList.currentVersion);
        }
    });

    it('prices managed model access from the provider cost, with no fixed version', () => {
        const result = classifyUsage(
            {
                capability: PluginUsageCapability.AI,
                pluginId: 'p',
                units: 1200,
                costCents: 4.2,
                payer: UsagePayer.PLATFORM,
            },
            context,
        );
        expect(result).toMatchObject({
            meter: UsageMeter.CREDITS,
            priceKey: 'ai.managed',
            priceVersion: null,
            creditsCharged: 5,
            priceMissing: false,
        });
    });

    it('classifies an unresolvable payer to credits and flags it — never silently free', () => {
        const result = classifyUsage(
            { capability: PluginUsageCapability.SEARCH, pluginId: 'p', units: 1, costCents: 0 },
            context,
        );
        expect(result.meter).toBe(UsageMeter.CREDITS);
        expect(result.payer).toBe(UsagePayer.UNCONFIRMED);
        expect(result.unconfirmed).toBe(true);
        expect(result.creditsCharged).toBe(2);
    });

    it('treats a fleet node row as Workspace-paid whatever the caller claimed', () => {
        const result = classifyUsage(
            {
                capability: PluginUsageCapability.AI,
                pluginId: 'fleet-node:claude-code',
                units: 3,
                costCents: 90,
                payer: UsagePayer.PLATFORM,
            },
            context,
        );
        expect(result.meter).toBe(UsageMeter.MODEL);
        expect(result.payer).toBe(UsagePayer.WORKSPACE);
        expect(result.creditsCharged).toBe(0);
    });

    it('classifies email and notification sends to add-ons, which never draw credits', () => {
        for (const capability of [
            PluginUsageCapability.EMAIL,
            PluginUsageCapability.NOTIFICATION_CHANNEL,
        ]) {
            for (const payer of PAYERS) {
                const result = classifyUsage(
                    { capability, pluginId: 'p', units: 1, costCents: 250, payer },
                    context,
                );
                expect(result.meter).toBe(UsageMeter.ADDON);
                expect(result.creditsCharged).toBe(0);
            }
        }
    });

    it('charges 0 and flags a miss for a kind of call with no price-list entry', () => {
        const result = classifyUsage(
            {
                capability: 'future-capability',
                operation: 'lookup',
                pluginId: 'p',
                units: 1,
                costCents: 40,
                payer: UsagePayer.PLATFORM,
            },
            context,
        );
        expect(result.meter).toBe(UsageMeter.CREDITS);
        expect(result.priceKey).toBe('future-capability.lookup');
        expect(result.creditsCharged).toBe(0);
        expect(result.priceVersion).toBeNull();
        expect(result.priceMissing).toBe(true);
    });

    it('prices nothing (and flags no miss) when no price list is bound', () => {
        const result = classifyUsage({
            capability: PluginUsageCapability.SEARCH,
            pluginId: 'p',
            units: 1,
            costCents: 1,
            payer: UsagePayer.PLATFORM,
        });
        expect(result.meter).toBe(UsageMeter.CREDITS);
        expect(result.creditsCharged).toBe(0);
        expect(result.priceVersion).toBeNull();
        expect(result.priceMissing).toBe(false);
    });
});

describe('priceKeyFor', () => {
    it('maps each capability to a capability.operation key — never a plugin id', () => {
        expect(priceKeyFor('search', 'search')).toBe('search.query');
        expect(priceKeyFor('extractor', 'extract')).toBe('extractor.page');
        expect(priceKeyFor('screenshot', 'capture')).toBe('screenshot.capture');
        expect(priceKeyFor('ai', 'askJson')).toBe('ai.managed');
        expect(priceKeyFor('ai', 'createStreamingChatCompletion')).toBe('ai.managed');
        expect(priceKeyFor('metrics', 'getMetricValue')).toBe('metrics.read');
        expect(priceKeyFor('mcp')).toBe('mcp.toolCall');
        expect(priceKeyFor('email', 'send')).toBe('email.send');
        expect(priceKeyFor('notification_channel', 'send')).toBe('notification.send');
    });

    it('keeps an unknown capability key short and free of separators it could inject', () => {
        const key = priceKeyFor('x'.repeat(50), 'a.b/c d'.repeat(20));
        expect(key.length).toBeLessThanOrEqual(64);
        expect(key.split('.')).toHaveLength(2);
    });
});

describe('usagePayerFromSettingSource', () => {
    it('maps Workspace-level sources to the workspace and platform-level sources to the platform', () => {
        expect(usagePayerFromSettingSource('user')).toBe(UsagePayer.WORKSPACE);
        expect(usagePayerFromSettingSource('work')).toBe(UsagePayer.WORKSPACE);
        expect(usagePayerFromSettingSource('admin')).toBe(UsagePayer.PLATFORM);
        expect(usagePayerFromSettingSource('env')).toBe(UsagePayer.PLATFORM);
        expect(usagePayerFromSettingSource('default')).toBe(UsagePayer.PLATFORM);
    });

    it('never guesses an unknown source', () => {
        expect(usagePayerFromSettingSource(undefined)).toBe(UsagePayer.UNCONFIRMED);
        expect(usagePayerFromSettingSource(null)).toBe(UsagePayer.UNCONFIRMED);
        expect(usagePayerFromSettingSource('tenant')).toBe(UsagePayer.UNCONFIRMED);
    });
});
