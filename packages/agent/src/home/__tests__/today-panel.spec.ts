import type { ScheduleSourceType, ScheduleView } from '../../schedules/schedule-view.types';
import { HomeTodayBuilder, homeScheduleKind, toHomeToday } from '../builders/today.builder';

/** 14:30 in Europe/Kyiv. */
const NOW = new Date('2026-09-14T11:30:00.000Z');
const DAY = {
    from: new Date('2026-09-13T21:00:00.000Z'),
    to: new Date('2026-09-14T21:00:00.000Z'),
};
const kyiv = (hhmm: string, date = '2026-09-14') => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(
        Date.parse(`${date}T00:00:00.000Z`) + (h - 3) * 3600_000 + m * 60_000,
    ).toISOString();
};

function view(overrides: Partial<ScheduleView> = {}): ScheduleView {
    return {
        id: 'agent_heartbeat:agent-1',
        sourceType: 'agent_heartbeat',
        ownerType: 'agent',
        ownerId: 'agent-1',
        ownerName: 'Daily sweep',
        ownerLink: '/agents/agent-1',
        cadenceRaw: null,
        cadenceHuman: 'Every day',
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        status: 'active',
        enabled: true,
        ...overrides,
    };
}

const ALL_SOURCES: ScheduleSourceType[] = [
    'recurring_task',
    'agent_heartbeat',
    'work_schedule',
    'mission_tick',
    'source_validation',
    'data_sync',
    'inbound_trigger',
];

describe('Home Today panel', () => {
    it('maps every one of the seven schedule sources to its own kind', () => {
        expect(ALL_SOURCES.map(homeScheduleKind)).toEqual(ALL_SOURCES);
    });

    it('shows what ran today and what is still due today, not tomorrow (S4)', () => {
        const today = toHomeToday(
            [
                view({
                    id: 'sweep',
                    ownerName: 'Daily sweep',
                    lastRunAt: kyiv('06:15'),
                    nextRunAt: kyiv('06:15', '2026-09-15'),
                }),
                view({
                    id: 'report',
                    ownerName: 'Weekly report',
                    nextRunAt: kyiv('09:00', '2026-09-15'),
                }),
                view({ id: 'catalog', ownerName: 'Catalog check', nextRunAt: kyiv('18:00') }),
            ],
            DAY,
            NOW,
        );

        expect(today.ran.map((row) => [row.id, row.state, row.at])).toEqual([
            ['sweep', 'ran', kyiv('06:15')],
        ]);
        expect(today.due.map((row) => [row.id, row.state, row.at])).toEqual([
            ['catalog', 'due', kyiv('18:00')],
        ]);
        expect(today.dueTotal).toBe(1);
    });

    it('keeps every kind in the rows it returns', () => {
        const views = ALL_SOURCES.map((sourceType, index) =>
            view({
                id: `${sourceType}:x`,
                sourceType,
                nextRunAt: kyiv(`${15 + (index % 5)}:0${index}`),
            }),
        );
        const today = toHomeToday(views, DAY, NOW);
        expect(today.dueTotal).toBe(7);
        expect(today.due).toHaveLength(6);
        expect(new Set(today.due.map((row) => row.kind)).size).toBe(6);
    });

    it('never counts a schedule whose next run cannot be computed', () => {
        const today = toHomeToday(
            [view({ nextRunAt: null }), view({ nextRunAt: 'garbage' })],
            DAY,
            NOW,
        );
        expect(today.due).toEqual([]);
        expect(today.dueTotal).toBe(0);
    });

    it('shows paused and errored schedules and hides disabled and ended ones', () => {
        const today = toHomeToday(
            [
                view({ id: 'active', status: 'active', nextRunAt: kyiv('15:00') }),
                view({ id: 'paused', status: 'paused', nextRunAt: kyiv('16:00') }),
                view({ id: 'error', status: 'error', nextRunAt: kyiv('17:00') }),
                view({ id: 'disabled', status: 'disabled', nextRunAt: kyiv('18:00') }),
                view({ id: 'ended', status: 'ended', lastRunAt: kyiv('08:00') }),
            ],
            DAY,
            NOW,
        );
        expect(today.due.map((row) => [row.id, row.status])).toEqual([
            ['active', 'active'],
            ['paused', 'paused'],
            ['error', 'error'],
        ]);
        expect(today.ran).toEqual([]);
    });

    it('caps ran at the 3 most recent (earliest first) and due at 6 with an exact total', () => {
        const ran = ['01:00', '02:00', '03:00', '04:00'].map((time) =>
            view({ id: `ran-${time}`, lastRunAt: kyiv(time) }),
        );
        const due = ['15:00', '15:10', '15:20', '15:30', '15:40', '15:50', '16:00', '16:10'].map(
            (time) => view({ id: `due-${time}`, nextRunAt: kyiv(time) }),
        );
        const today = toHomeToday([...ran, ...due], DAY, NOW);

        expect(today.ran.map((row) => row.id)).toEqual(['ran-02:00', 'ran-03:00', 'ran-04:00']);
        expect(today.due).toHaveLength(6);
        expect(today.due[0].id).toBe('due-15:00');
        expect(today.dueTotal).toBe(8);
    });

    it('treats a past next run and a future last run as neither due nor ran', () => {
        const today = toHomeToday(
            [view({ nextRunAt: kyiv('09:00') }), view({ id: 'future', lastRunAt: kyiv('20:00') })],
            DAY,
            NOW,
        );
        expect(today.due).toEqual([]);
        expect(today.ran).toEqual([]);
    });

    it('cuts owner names to 60 characters and carries the owner link', () => {
        const [row] = toHomeToday(
            [
                view({
                    ownerName: 'n'.repeat(90),
                    ownerLink: '/missions/m-1',
                    nextRunAt: kyiv('20:00'),
                }),
            ],
            DAY,
            NOW,
        ).due;
        expect(row.name).toHaveLength(60);
        expect(row.href).toBe('/missions/m-1');
    });

    it('asks the aggregation for every source in the active scope', async () => {
        const schedules = { getSchedules: jest.fn().mockResolvedValue([]) };
        const builder = new HomeTodayBuilder(schedules as never);

        await builder.build({
            userId: 'user-1',
            scope: { tenantId: 't', organizationId: 'org-1' },
            timezone: 'Europe/Kyiv',
            day: { date: '2026-09-14', ...DAY },
            now: NOW,
            memo: new Map(),
        });

        expect(schedules.getSchedules).toHaveBeenCalledWith({
            userId: 'user-1',
            organizationId: 'org-1',
        });
    });
});
