import {
    describeCron,
    describeRrule,
    describeWorkCadence,
    describeIntervalMinutes,
    computeNextCronFire,
} from '../cadence';
import { WorkScheduleCadence } from '../../entities/types';

describe('describeCron', () => {
    it('describes well-known cadences', () => {
        expect(describeCron('* * * * *')).toBe('Every minute');
        expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
        expect(describeCron('0 * * * *')).toBe('Every hour');
        expect(describeCron('0 */3 * * *')).toBe('Every 3 hours');
        expect(describeCron('30 9 * * *')).toBe('Every day at 09:30');
        expect(describeCron('0 9 * * 1')).toBe('Every Monday at 09:00');
        expect(describeCron('0 0 1 * *')).toBe('Monthly on day 1 at 00:00');
    });

    it('maps the literal "manual" cadence', () => {
        expect(describeCron('manual')).toBe('Manual');
    });

    it('falls back to the raw expression for exotic crons', () => {
        expect(describeCron('5 4 * 1 0')).toBe('5 4 * 1 0');
    });

    it('handles empty / malformed input without throwing', () => {
        expect(describeCron('')).toBe('');
        expect(describeCron(null)).toBe('');
        expect(describeCron('not a cron')).toBe('not a cron');
    });
});

describe('describeRrule', () => {
    it('describes a daily RRULE', () => {
        expect(describeRrule('FREQ=DAILY').toLowerCase()).toContain('every day');
    });

    it('falls back to the raw rule when unparseable', () => {
        expect(describeRrule('NONSENSE')).toBe('NONSENSE');
        expect(describeRrule(null)).toBe('');
    });
});

describe('describeWorkCadence', () => {
    it('maps enum values to labels', () => {
        expect(describeWorkCadence(WorkScheduleCadence.HOURLY)).toBe('Every hour');
        expect(describeWorkCadence(WorkScheduleCadence.DAILY)).toBe('Every day');
        expect(describeWorkCadence(WorkScheduleCadence.WEEKLY)).toBe('Every week');
        expect(describeWorkCadence(WorkScheduleCadence.MONTHLY)).toBe('Every month');
        expect(describeWorkCadence(null)).toBe('');
    });
});

describe('describeIntervalMinutes', () => {
    it('formats minute intervals', () => {
        expect(describeIntervalMinutes(5)).toBe('Every 5 minutes');
        expect(describeIntervalMinutes(1)).toBe('Every minute');
        expect(describeIntervalMinutes(60)).toBe('Every hour');
        expect(describeIntervalMinutes(120)).toBe('Every 2 hours');
        expect(describeIntervalMinutes(0)).toBe('');
    });
});

describe('computeNextCronFire', () => {
    it('computes the next daily fire strictly after `from` (UTC)', () => {
        const from = new Date('2026-07-18T08:00:00.000Z');
        expect(computeNextCronFire('0 9 * * *', from)).toBe('2026-07-18T09:00:00.000Z');
    });

    it('rolls to the next day when the time has already passed', () => {
        const from = new Date('2026-07-18T10:00:00.000Z');
        expect(computeNextCronFire('0 9 * * *', from)).toBe('2026-07-19T09:00:00.000Z');
    });

    it('returns the next minute for an every-minute cron', () => {
        const from = new Date('2026-07-18T10:00:30.000Z');
        expect(computeNextCronFire('* * * * *', from)).toBe('2026-07-18T10:01:00.000Z');
    });

    it('returns null for an invalid cron', () => {
        expect(computeNextCronFire('bogus', new Date())).toBeNull();
        expect(computeNextCronFire(null, new Date())).toBeNull();
    });
});
