import { describe, expect, it } from 'vitest';

import {
	BREAKDOWN_TOP_N,
	CREDIT_PRICE_BASES,
	CREDIT_SETTLEMENT_MODES,
	DEFAULT_CREDIT_SETTLEMENT_MODE,
	isCreditSettlementMode,
	SPEND_CAP_MIN_CENTS,
	SPEND_CAP_THRESHOLDS,
	UNCONFIRMED_PAYER_ALERT_RATIO,
	USAGE_EXPORT_MAX_DAYS,
	USAGE_EXPORT_MAX_ROWS,
	USAGE_METER_IDS,
	USAGE_OUTCOME_IDS,
	USAGE_PAYER_IDS
} from './meter.types.js';

describe('billing meter contracts', () => {
	it('names exactly three meters, in the order every surface renders them', () => {
		expect(USAGE_METER_IDS).toEqual(['model', 'credits', 'addon']);
	});

	it('closes the payer and outcome vocabularies', () => {
		expect(USAGE_PAYER_IDS).toEqual(['workspace', 'platform', 'unconfirmed']);
		expect(USAGE_OUTCOME_IDS).toEqual(['ok', 'cached', 'failed']);
		expect(CREDIT_PRICE_BASES).toEqual(['per-unit', 'provider-cost']);
	});

	it('settles from provider cost unless a deployment opts into the price list', () => {
		expect(CREDIT_SETTLEMENT_MODES).toEqual(['provider_cost', 'price_list']);
		expect(DEFAULT_CREDIT_SETTLEMENT_MODE).toBe('provider_cost');
		expect(isCreditSettlementMode('price_list')).toBe(true);
		expect(isCreditSettlementMode('provider_cost')).toBe(true);
		for (const value of ['', 'price-list', 'PRICE_LIST', 'fixed', null, undefined, 1]) {
			expect(isCreditSettlementMode(value)).toBe(false);
		}
	});

	it('carries the published limits as numbers', () => {
		expect(SPEND_CAP_MIN_CENTS).toBe(100);
		expect(SPEND_CAP_THRESHOLDS).toEqual([75, 90, 100]);
		expect(USAGE_EXPORT_MAX_ROWS).toBe(50_000);
		expect(USAGE_EXPORT_MAX_DAYS).toBe(92);
		expect(BREAKDOWN_TOP_N).toBe(10);
		expect(UNCONFIRMED_PAYER_ALERT_RATIO).toBe(0.001);
	});
});
