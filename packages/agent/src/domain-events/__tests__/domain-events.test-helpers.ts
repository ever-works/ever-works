import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { getDomainEventCatalogEntry } from '@ever-works/contracts';
import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { DomainEvent } from '../../entities/domain-event.entity';
import { RecordVisibilitySubscriber } from '../../database/record-visibility.subscriber';
import {
    DOMAIN_EVENT_RELAY_STATE_ID,
    DomainEventRelayState,
} from '../../entities/domain-event-relay-state.entity';
import { DomainEventRecorder, type RecordDomainEventInput } from '../domain-event-recorder.service';

/**
 * An in-memory better-sqlite3 database with the whole entity inventory (so
 * the versioned aggregates are real tables) and the relay-state row seeded
 * the way the migration seeds it. Foreign keys are off: these specs never
 * build a full relation graph behind the rows they touch.
 */
export async function createDomainEventsDataSource(): Promise<DataSource> {
    const dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ENTITIES,
        // Record visibility (EW-P1-3): the insert-time default, registered exactly as
        // `databaseConfig()` registers it, so org rows start `team` / `organization`.
        subscribers: [RecordVisibilitySubscriber],
        synchronize: true,
        logging: false,
    });
    await dataSource.initialize();
    await dataSource.query('PRAGMA foreign_keys = OFF');
    await dataSource
        .getRepository(DomainEventRelayState)
        .insert({ id: DOMAIN_EVENT_RELAY_STATE_ID, lastSeq: 0, retentionFloorSeq: 0 });
    return dataSource;
}

/** Empty the tables these specs write and re-seed the relay-state row (cheaper than a new schema per test). */
export async function resetDomainEventsTables(dataSource: DataSource): Promise<void> {
    for (const table of [
        'domain_events',
        'plugin_event_cursors',
        'domain_event_relay_state',
        'teams',
        'tenants',
    ]) {
        await dataSource.query(`DELETE FROM "${table}"`);
    }
    await dataSource
        .getRepository(DomainEventRelayState)
        .insert({ id: DOMAIN_EVENT_RELAY_STATE_ID, lastSeq: 0, retentionFloorSeq: 0 });
}

export const ORG_A = '0f4b2c6d-8e1a-4b3c-9d5e-6f7a8b9c0d12';
export const ORG_B = '1a5c3d7e-9f2b-4c4d-8e6f-7a8b9c0d1e23';
export const TENANT = '7c1e9a52-3b0d-4c8e-9f21-5d6a7b8c9d01';

/** A minimal, valid recorder input for a task event. */
export function taskEventInput(
    overrides: Partial<RecordDomainEventInput> = {},
): RecordDomainEventInput {
    const id = randomUUID();
    return {
        type: 'task.updated',
        tenantId: TENANT,
        organizationId: ORG_A,
        aggregate: { type: 'task', id, version: 2 },
        data: { id, title: 'Ship it', visibility: 'organization' },
        changedFields: ['title'],
        previous: { title: 'Ship' },
        actor: { type: 'user', id: randomUUID(), label: 'ruslan' },
        ...overrides,
    };
}

/** Record `count` events through the real recorder (each in its own transaction). */
export async function recordMany(
    dataSource: DataSource,
    count: number,
    overrides: (index: number) => Partial<RecordDomainEventInput> = () => ({}),
): Promise<DomainEvent[]> {
    const recorder = new DomainEventRecorder();
    const rows: DomainEvent[] = [];
    for (let index = 0; index < count; index++) {
        rows.push(
            await dataSource.transaction((manager) =>
                recorder.record(manager, taskEventInput(overrides(index))),
            ),
        );
    }
    return rows;
}

export const CONTRACT_DIR = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'docs',
    'specs',
    'features',
    'integrations-api-v1',
    'contract',
);
const BASE = 'https://ever.works/schemas/integrations/v1/';

/** Validates a value against a contract schema by `$id` suffix (`resources/task.schema.json`, `…#/$defs/X`). */
export function contractValidator() {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) return walk(path);
            return name.endsWith('.schema.json') ? [path] : [];
        });
    for (const file of walk(join(CONTRACT_DIR, 'schemas')))
        ajv.addSchema(JSON.parse(readFileSync(file, 'utf8')));
    return (ref: string, value: unknown) => {
        const validate = ajv.getSchema(BASE + ref);
        if (!validate) throw new Error(`no schema ${ref}`);
        if (!validate(JSON.parse(JSON.stringify(value)))) {
            throw new Error(`${ref}: ${JSON.stringify(validate.errors, null, 1)}`);
        }
    };
}

interface ContractCatalogRow {
    readonly type: string;
    readonly dataSchema: string;
}

/**
 * Validates a recorded event's `data` against the schema its row in the
 * published catalog (`event-catalog.v1.json`) names.
 */
export function catalogDataValidator(): (event: { type: string; data: unknown }) => void {
    const validate = contractValidator();
    const catalog = JSON.parse(
        readFileSync(join(CONTRACT_DIR, 'event-catalog.v1.json'), 'utf8'),
    ) as {
        events: ContractCatalogRow[];
    };
    const rows = new Map(catalog.events.map((row) => [row.type, row]));
    return (event) => {
        const row = rows.get(event.type);
        if (!row) throw new Error(`not in event-catalog.v1.json: ${event.type}`);
        validate(row.dataSchema.replace(/^schemas\//, ''), event.data);
    };
}
