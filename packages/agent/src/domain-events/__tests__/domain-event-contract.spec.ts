import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DOMAIN_EVENT_CATALOG, type DomainEventEnvelope } from '@ever-works/contracts';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { DataSource } from 'typeorm';
import { DomainEventRelayService } from '../domain-event-relay.service';
import { DomainEventRetentionService } from '../domain-event-retention.service';
import {
    createDomainEventsDataSource,
    recordMany,
    resetDomainEventsTables,
} from './domain-events.test-helpers';

/**
 * Contract test (EW-P1-1 / EW-P1-8) — the TypeScript side of the domain events
 * against the PUBLISHED integration contract v1 in
 * `docs/specs/features/integrations-api-v1/contract/`, which Ever Gauzy's mock
 * server and tests load too:
 *
 *  - every schema compiles (Ajv, JSON Schema 2020-12);
 *  - the TS catalog (`DOMAIN_EVENT_CATALOG`) and `event-catalog.v1.json` name the
 *    same types, in the same order, with the same aggregate/phase/child/opt-in;
 *  - every example validates; every catalog `dataSchema` resolves;
 *  - an envelope produced by the real recorder + relay validates;
 *  - every webhook signature vector gives its expected verdict.
 */
const CONTRACT_DIR = join(
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

const readJson = <T = unknown>(...parts: string[]): T =>
    JSON.parse(readFileSync(join(CONTRACT_DIR, ...parts), 'utf8')) as T;

function schemaFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return schemaFiles(path);
        return name.endsWith('.schema.json') ? [path] : [];
    });
}

interface CatalogRow {
    type: string;
    domain: string;
    aggregateType: string;
    dataSchema: string | null;
    phase: string;
    child?: string;
    optIn?: boolean;
}

describe('integration contract v1 (published schemas)', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);

    beforeAll(() => {
        expect(existsSync(CONTRACT_DIR)).toBe(true);
        for (const file of schemaFiles(join(CONTRACT_DIR, 'schemas'))) {
            ajv.addSchema(JSON.parse(readFileSync(file, 'utf8')));
        }
    });

    const validator = (ref: string) => {
        const validate = ajv.getSchema(BASE + ref);
        if (!validate) throw new Error(`no schema ${ref}`);
        return validate;
    };
    const expectValid = (ref: string, value: unknown) => {
        const validate = validator(ref);
        const ok = validate(value);
        if (!ok) throw new Error(`${ref}: ${JSON.stringify(validate.errors, null, 1)}`);
    };

    it('compiles every schema', () => {
        for (const file of schemaFiles(join(CONTRACT_DIR, 'schemas'))) {
            const { $id } = JSON.parse(readFileSync(file, 'utf8')) as { $id: string };
            expect(ajv.getSchema($id)).toBeDefined();
        }
    });

    it('publishes exactly the TypeScript catalog, in order', () => {
        const published = readJson<{ events: CatalogRow[] }>('event-catalog.v1.json');
        expectValid('event-catalog.schema.json', published);
        expect(
            published.events.map(({ type, domain, aggregateType, phase, child, optIn }) => ({
                type,
                domain,
                aggregateType,
                phase,
                ...(child ? { child } : {}),
                ...(optIn ? { optIn } : {}),
            })),
        ).toEqual(DOMAIN_EVENT_CATALOG.map((entry) => ({ ...entry })));
    });

    it('resolves every catalog data schema', () => {
        const published = readJson<{ events: CatalogRow[] }>('event-catalog.v1.json');
        for (const row of published.events) {
            if (row.dataSchema === null) {
                expect(row.phase).not.toBe('P1');
                continue;
            }
            expect(ajv.getSchema(BASE + row.dataSchema.replace(/^schemas\//, ''))).toBeDefined();
        }
    });

    it('validates every example', () => {
        const resources: Array<[string, string]> = [
            ['whoami.json', 'resources/whoami.schema.json'],
            ['task.json', 'resources/task.schema.json'],
            ['team.json', 'resources/team.schema.json'],
            ['work.json', 'resources/work.schema.json'],
            ['agent.json', 'resources/agent.schema.json'],
            ['idea.json', 'resources/idea.schema.json'],
            ['goal.json', 'resources/goal.schema.json'],
            ['mission.json', 'resources/mission.schema.json'],
            ['comment.json', 'resources/task-comment.schema.json'],
            ['member.json', 'resources/member.schema.json'],
            ['member-invite-result.json', 'resources/member-invite-result.schema.json'],
            ['organization.json', 'resources/organization.schema.json'],
            ['inbox-item.json', 'resources/inbox-item.schema.json'],
            ['email-message.json', 'resources/email-message.schema.json'],
            ['email-inbound-result.json', 'resources/email-inbound-result.schema.json'],
            ['inbox-reply-result.json', 'resources/inbox-reply-result.schema.json'],
            ['kb-document.json', 'resources/kb-document.schema.json'],
            ['kb-folder.json', 'resources/kb-folder.schema.json'],
            ['events-page.json', 'resources/events-page.schema.json'],
            ['error.transition_blocked.json', 'error.schema.json'],
            ['error.version_mismatch.json', 'error.schema.json'],
        ];
        for (const [example, ref] of resources) expectValid(ref, readJson('examples', example));

        const catalog = readJson<{ events: CatalogRow[] }>('event-catalog.v1.json').events;
        for (const file of readdirSync(join(CONTRACT_DIR, 'examples', 'events'))) {
            const envelope = readJson<DomainEventEnvelope>('examples', 'events', file);
            expectValid('event-envelope.schema.json', envelope);
            const row = catalog.find((entry) => entry.type === envelope.type);
            expect(row?.aggregateType).toBe(envelope.aggregate.type);
            expectValid((row?.dataSchema as string).replace(/^schemas\//, ''), envelope.data);
        }
    });

    it('rejects what it must (controls for the acceptances above)', () => {
        const task = readJson<Record<string, unknown>>('examples', 'task.json');
        expect(validator('resources/task.schema.json')({ ...task, status: 'open' })).toBe(false);
        expect(validator('resources/task.schema.json')({ ...task, visibility: 'private' })).toBe(
            false,
        );
        const envelope = readJson<Record<string, unknown>>(
            'examples',
            'events',
            'task.updated.json',
        );
        expect(validator('event-envelope.schema.json')({ ...envelope, id: 'evt_1' })).toBe(false);
    });

    describe('an envelope the recorder and the relay actually produce', () => {
        let dataSource: DataSource;

        beforeAll(async () => {
            dataSource = await createDomainEventsDataSource();
        });

        afterAll(async () => {
            if (dataSource?.isInitialized) await dataSource.destroy();
        });

        it('validates against the published envelope schema', async () => {
            await resetDomainEventsTables(dataSource);
            const seen: DomainEventEnvelope[] = [];
            const emitter = new EventEmitter2();
            emitter.on('domain.task.updated', (envelope: DomainEventEnvelope) => {
                seen.push(envelope);
            });
            await recordMany(dataSource, 1, () => ({
                originTag: 'gauzy:conn-1',
                correlationId: 'req-1',
            }));
            const relay = new DomainEventRelayService(
                dataSource,
                new DomainEventRetentionService(dataSource),
                emitter,
            );
            await relay.tick();
            await relay.stop();
            expect(seen).toHaveLength(1);
            expectValid('event-envelope.schema.json', JSON.parse(JSON.stringify(seen[0])));
        });
    });

    describe('webhook signature vectors (B.5)', () => {
        interface Vector {
            name: string;
            secret: string;
            body: string;
            header: string;
            now: number;
            toleranceSeconds: number;
            expected: boolean;
        }

        /** The reference verifier Ever Works documents (same algorithm as Gauzy's verifyWebhookSignature, never throws). */
        function verify(vector: Vector): boolean {
            if (!vector.secret || !vector.header) return false;
            const parts = vector.header.split(',').map((part) => part.trim());
            const timestampPart = parts.find((part) => part.startsWith('t='));
            const signatures = parts
                .filter((part) => part.startsWith('v1='))
                .map((part) => part.slice(3));
            if (!timestampPart || signatures.length === 0) return false;
            const timestamp = Number(timestampPart.slice(2));
            if (!Number.isFinite(timestamp)) return false;
            if (Math.abs(vector.now - timestamp) > vector.toleranceSeconds) return false;
            const expected = createHmac('sha256', vector.secret)
                .update(`${timestamp}.${vector.body}`, 'utf8')
                .digest('hex');
            return signatures.some(
                (signature) =>
                    /^[0-9a-f]+$/i.test(signature) &&
                    signature.length === expected.length &&
                    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex')),
            );
        }

        const file = () =>
            readJson<{ vectors: Vector[]; toleranceSeconds: number }>(
                'webhook-signature-vectors.json',
            );

        it('has valid and invalid vectors, named after their verdict', () => {
            const { vectors } = file();
            expectValid('webhook-signature-vectors.schema.json', file());
            expect(vectors.some((vector) => vector.expected)).toBe(true);
            expect(vectors.some((vector) => !vector.expected)).toBe(true);
            for (const vector of vectors)
                expect(vector.name.startsWith('valid-')).toBe(vector.expected);
        });

        it('gives every vector its expected verdict', () => {
            for (const vector of file().vectors) {
                expect({ name: vector.name, verdict: verify(vector) }).toEqual({
                    name: vector.name,
                    verdict: vector.expected,
                });
            }
        });
    });
});
