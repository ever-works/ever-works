import {
    NOTIFICATION_CHOICE_ORIGIN_MATRIX,
    defaultNotificationTargets,
    effectiveNotificationTargets,
    isMatrixChoice,
    storedChoiceDecidesTargets,
    storedChoiceKeepsInApp,
} from '../notification-choice';

/**
 * Attention controls (AW-13) — the meaning of a stored per-event choice.
 *
 * Rows without the matrix marker are every row stored before AW-13 and every
 * write through the API or the chat assistant: they must behave exactly as
 * before (an empty list falls back to the defaults; the bell always shows the
 * notification). Only a choice saved in the matrix is taken literally.
 */
describe('notification choice rules', () => {
    const matrix = (channelIds: string[] | null) => ({
        channelIds,
        origin: NOTIFICATION_CHOICE_ORIGIN_MATRIX,
    });

    it('recognises only the matrix marker', () => {
        expect(NOTIFICATION_CHOICE_ORIGIN_MATRIX).toBe('matrix');
        expect(isMatrixChoice(matrix([]))).toBe(true);
        expect(isMatrixChoice({ channelIds: [], origin: null })).toBe(false);
        expect(isMatrixChoice({ channelIds: [] })).toBe(false);
        expect(isMatrixChoice({ channelIds: [], origin: 'api' })).toBe(false);
        expect(isMatrixChoice(null)).toBe(false);
        expect(isMatrixChoice(undefined)).toBe(false);
    });

    describe('rows without the matrix marker (behaviour before AW-13)', () => {
        it('decide the targets only when they name at least one', () => {
            expect(storedChoiceDecidesTargets({ channelIds: ['ch-1'] })).toBe(true);
            expect(storedChoiceDecidesTargets({ channelIds: [] })).toBe(false);
            expect(storedChoiceDecidesTargets({ channelIds: null, origin: null })).toBe(false);
            expect(storedChoiceDecidesTargets(null)).toBe(false);
        });

        it('always keep the notification in the bell', () => {
            expect(storedChoiceKeepsInApp({ channelIds: ['email'] })).toBe(true);
            expect(storedChoiceKeepsInApp({ channelIds: [] })).toBe(true);
            expect(storedChoiceKeepsInApp(null)).toBe(true);
        });

        it('show the defaults for an empty list, with in-app on', () => {
            expect(
                effectiveNotificationTargets({ channelIds: [] }, null, ['in-app', 'email']),
            ).toEqual(['in-app', 'email']);
            expect(
                effectiveNotificationTargets({ channelIds: [] }, ['in-app', 'ch-org'], ['in-app']),
            ).toEqual(['in-app', 'ch-org']);
        });

        it('show a non-empty list as stored, with in-app on because the bell still shows it', () => {
            expect(
                effectiveNotificationTargets({ channelIds: ['email', 'ch-1'] }, null, ['in-app']),
            ).toEqual(['in-app', 'email', 'ch-1']);
            expect(
                effectiveNotificationTargets({ channelIds: ['in-app', 'email'] }, null, ['in-app']),
            ).toEqual(['in-app', 'email']);
        });
    });

    describe('matrix choices', () => {
        it('decide the targets even when empty', () => {
            expect(storedChoiceDecidesTargets(matrix([]))).toBe(true);
            expect(storedChoiceDecidesTargets(matrix(null))).toBe(true);
        });

        it('keep the notification in the bell only when they name in-app', () => {
            expect(storedChoiceKeepsInApp(matrix(['in-app']))).toBe(true);
            expect(storedChoiceKeepsInApp(matrix(['email']))).toBe(false);
            expect(storedChoiceKeepsInApp(matrix([]))).toBe(false);
        });

        it('are shown exactly as saved', () => {
            expect(
                effectiveNotificationTargets(matrix([]), ['in-app'], ['in-app', 'email']),
            ).toEqual([]);
            expect(effectiveNotificationTargets(matrix(['email']), null, ['in-app'])).toEqual([
                'email',
            ]);
        });
    });

    it('with nothing stored, shows the organisation default, else the event default, else in-app — with in-app on', () => {
        expect(effectiveNotificationTargets(null, ['in-app', 'ch-org'], ['in-app'])).toEqual([
            'in-app',
            'ch-org',
        ]);
        expect(effectiveNotificationTargets(undefined, ['ch-org'], ['in-app'])).toEqual([
            'in-app',
            'ch-org',
        ]);
        expect(effectiveNotificationTargets(null, [], ['in-app', 'email'])).toEqual([
            'in-app',
            'email',
        ]);
        expect(effectiveNotificationTargets(null, undefined, [])).toEqual(['in-app']);
        expect(defaultNotificationTargets(null, null)).toEqual(['in-app']);
    });
});
