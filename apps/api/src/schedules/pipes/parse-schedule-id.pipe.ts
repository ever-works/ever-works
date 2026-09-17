import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

const SOURCE_TYPES = new Set([
    'recurring_task',
    'agent_heartbeat',
    'work_schedule',
    'mission_tick',
    'source_validation',
    'data_sync',
    'inbound_trigger',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates a synthetic schedule id, `${sourceType}:${ownerId}`.
 *
 * A schedule id contains a colon and is NOT a uuid, so `ParseUUIDPipe` must
 * never be used on it. The source type must be one of the seven known
 * sources and the owner id a uuid; anything else is a 400 before any
 * repository is touched.
 */
@Injectable()
export class ParseScheduleIdPipe implements PipeTransform<unknown, string> {
    transform(value: unknown): string {
        if (typeof value !== 'string') {
            throw new BadRequestException('Malformed schedule id.');
        }
        const parts = value.split(':');
        if (parts.length !== 2 || !SOURCE_TYPES.has(parts[0]) || !UUID.test(parts[1])) {
            throw new BadRequestException('Malformed schedule id.');
        }
        return value;
    }
}
