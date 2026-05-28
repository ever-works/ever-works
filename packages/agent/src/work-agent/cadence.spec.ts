import {
    DEFAULT_AUTO_GENERATE_CADENCE_MINUTES,
    isSupportedAutoGenerateCadence,
    parseAutoGenerateCadenceMinutes,
} from './cadence';

describe('work-agent cadence helpers', () => {
    it('parses the supported simple every-N-minutes cron shape', () => {
        expect(DEFAULT_AUTO_GENERATE_CADENCE_MINUTES).toBe(60);
        expect(parseAutoGenerateCadenceMinutes('*/15 * * * *')).toBe(15);
        expect(parseAutoGenerateCadenceMinutes('*/1440 * * * *')).toBe(1440);
    });

    it('rejects unsupported or out-of-range cadence strings', () => {
        expect(isSupportedAutoGenerateCadence('0 3 * * *')).toBe(false);
        expect(isSupportedAutoGenerateCadence('*/0 * * * *')).toBe(false);
        expect(isSupportedAutoGenerateCadence('*/1441 * * * *')).toBe(false);
        expect(parseAutoGenerateCadenceMinutes(null)).toBeNull();
    });
});
