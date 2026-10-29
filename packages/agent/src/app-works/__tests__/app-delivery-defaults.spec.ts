import {
    APP_DELIVERY_DEFAULTS_ENV,
    APP_DELIVERY_DEFAULT_VALUES,
    readAppDeliveryDefaults,
} from '../app-delivery-defaults';

/**
 * APW08-G25 — the delivery chain's owner-decision defaults, each behind a named env variable.
 * Unset is the spec default; a valid value is the owner's choice; anything else falls back to the
 * default (these are policy numbers, not kill switches).
 */
describe('readAppDeliveryDefaults (APW08-G25)', () => {
    it('names the three switches', () => {
        expect(APP_DELIVERY_DEFAULTS_ENV).toEqual({
            liveWithWarningsCloses: 'EVER_WORKS_APP_DELIVERY_LIVE_WITH_WARNINGS_CLOSES',
            followUpsPerChange: 'EVER_WORKS_APP_FOLLOW_UPS_PER_CHANGE',
            followUpsOpenPerWork: 'EVER_WORKS_APP_FOLLOW_UPS_OPEN_PER_WORK',
        });
    });

    it('unset = the spec defaults: Live with warnings closes, 2 per change, 3 open per Work', () => {
        expect(readAppDeliveryDefaults({})).toEqual({
            liveWithWarningsCloses: true,
            followUpsPerChange: 2,
            followUpsOpenPerWork: 3,
        });
        expect(APP_DELIVERY_DEFAULT_VALUES).toEqual(readAppDeliveryDefaults({}));
    });

    it('reads an owner override', () => {
        expect(
            readAppDeliveryDefaults({
                EVER_WORKS_APP_DELIVERY_LIVE_WITH_WARNINGS_CLOSES: 'false',
                EVER_WORKS_APP_FOLLOW_UPS_PER_CHANGE: '0',
                EVER_WORKS_APP_FOLLOW_UPS_OPEN_PER_WORK: '10',
            }),
        ).toEqual({ liveWithWarningsCloses: false, followUpsPerChange: 0, followUpsOpenPerWork: 10 });
    });

    it.each([
        ['EVER_WORKS_APP_DELIVERY_LIVE_WITH_WARNINGS_CLOSES', 'flase', 'liveWithWarningsCloses', true],
        ['EVER_WORKS_APP_FOLLOW_UPS_PER_CHANGE', '6', 'followUpsPerChange', 2],
        ['EVER_WORKS_APP_FOLLOW_UPS_PER_CHANGE', '-1', 'followUpsPerChange', 2],
        ['EVER_WORKS_APP_FOLLOW_UPS_OPEN_PER_WORK', '11', 'followUpsOpenPerWork', 3],
        ['EVER_WORKS_APP_FOLLOW_UPS_OPEN_PER_WORK', 'many', 'followUpsOpenPerWork', 3],
        ['EVER_WORKS_APP_FOLLOW_UPS_OPEN_PER_WORK', '  ', 'followUpsOpenPerWork', 3],
    ])('%s=%j falls back to the default', (name, value, key, expected) => {
        expect(readAppDeliveryDefaults({ [name]: value })[key as 'followUpsPerChange']).toBe(expected);
    });
});
