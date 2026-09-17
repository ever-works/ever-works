import { BadRequestException } from '@nestjs/common';
import { ParseScheduleIdPipe } from './parse-schedule-id.pipe';

const UUID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';

describe('ParseScheduleIdPipe', () => {
    const pipe = new ParseScheduleIdPipe();

    it.each([
        'recurring_task',
        'agent_heartbeat',
        'work_schedule',
        'mission_tick',
        'source_validation',
        'data_sync',
        'inbound_trigger',
    ])('accepts a %s id', (sourceType) => {
        expect(pipe.transform(`${sourceType}:${UUID}`)).toBe(`${sourceType}:${UUID}`);
    });

    it.each([
        ['an unknown source type', `cron_job:${UUID}`],
        ['a non-uuid owner', 'recurring_task:task-1'],
        ['a missing colon', `recurring_task${UUID}`],
        ['two colons', `recurring_task:${UUID}:extra`],
        ['an empty owner', 'recurring_task:'],
        ['a bare uuid', UUID],
        ['an empty string', ''],
    ])('rejects %s', (_label, value) => {
        expect(() => pipe.transform(value)).toThrow(BadRequestException);
    });

    it('rejects a non-string value', () => {
        expect(() => pipe.transform(42)).toThrow(BadRequestException);
        expect(() => pipe.transform(undefined)).toThrow(BadRequestException);
    });
});
