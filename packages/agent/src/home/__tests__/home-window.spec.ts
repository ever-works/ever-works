import { buildHomeDay, InvalidHomeTimezoneError, resolveHomeTimezone } from '../home-window';

describe('Home day window', () => {
    describe('resolveHomeTimezone', () => {
        it('uses an explicit zone first', () => {
            expect(resolveHomeTimezone('Europe/Kyiv', 'Asia/Tokyo')).toEqual({
                timezone: 'Europe/Kyiv',
                fallback: false,
            });
        });

        it('accepts UTC and GMT explicitly', () => {
            expect(resolveHomeTimezone('UTC', null).timezone).toBe('UTC');
            expect(resolveHomeTimezone('GMT', null).timezone).toBe('GMT');
        });

        it('refuses an explicit unknown zone instead of silently using another', () => {
            expect(() => resolveHomeTimezone('Mars/Olympus_Mons', 'Europe/Kyiv')).toThrow(
                InvalidHomeTimezoneError,
            );
        });

        it('falls back to the profile zone, then to UTC with the fallback flag', () => {
            expect(resolveHomeTimezone(undefined, 'Asia/Tokyo')).toEqual({
                timezone: 'Asia/Tokyo',
                fallback: false,
            });
            expect(resolveHomeTimezone('', 'not-a-zone')).toEqual({
                timezone: 'UTC',
                fallback: true,
            });
            expect(resolveHomeTimezone(null, null)).toEqual({ timezone: 'UTC', fallback: true });
        });
    });

    describe('buildHomeDay', () => {
        it('covers the local calendar day in Europe/Kyiv, not a rolling 24 hours (S4)', () => {
            const day = buildHomeDay('Europe/Kyiv', new Date('2026-09-14T11:30:00.000Z'));
            expect(day).toEqual({
                date: '2026-09-14',
                from: '2026-09-13T21:00:00.000Z',
                to: '2026-09-14T21:00:00.000Z',
            });
        });

        it('treats 23:59:59 as the same day and 00:00:00 as the next one', () => {
            const lastSecond = buildHomeDay('Europe/Kyiv', new Date('2026-09-14T20:59:59.000Z'));
            const midnight = buildHomeDay('Europe/Kyiv', new Date('2026-09-14T21:00:00.000Z'));
            expect(lastSecond.date).toBe('2026-09-14');
            expect(midnight.date).toBe('2026-09-15');
            expect(midnight.from).toBe(lastSecond.to);
        });

        it('is 23 hours long on a spring-forward day', () => {
            const day = buildHomeDay('America/New_York', new Date('2026-03-08T15:00:00.000Z'));
            expect(Date.parse(day.to) - Date.parse(day.from)).toBe(23 * 60 * 60 * 1000);
        });

        it('is 25 hours long on a fall-back day', () => {
            const day = buildHomeDay('America/New_York', new Date('2026-11-01T15:00:00.000Z'));
            expect(Date.parse(day.to) - Date.parse(day.from)).toBe(25 * 60 * 60 * 1000);
        });

        it('handles zones on both sides of the date line', () => {
            const now = new Date('2026-09-14T12:00:00.000Z');
            const kiritimati = buildHomeDay('Pacific/Kiritimati', now);
            const pagoPago = buildHomeDay('Pacific/Pago_Pago', now);
            expect(kiritimati).toEqual({
                date: '2026-09-15',
                from: '2026-09-14T10:00:00.000Z',
                to: '2026-09-15T10:00:00.000Z',
            });
            expect(pagoPago).toEqual({
                date: '2026-09-14',
                from: '2026-09-14T11:00:00.000Z',
                to: '2026-09-15T11:00:00.000Z',
            });
        });

        it('is midnight to midnight in UTC', () => {
            expect(buildHomeDay('UTC', new Date('2026-09-14T23:59:59.999Z'))).toEqual({
                date: '2026-09-14',
                from: '2026-09-14T00:00:00.000Z',
                to: '2026-09-15T00:00:00.000Z',
            });
        });
    });
});
