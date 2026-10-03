import { randomUUID } from 'crypto';
import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';
import { ENTITIES } from '@ever-works/agent/database';
import {
    Agent,
    AgentRun,
    CreditLedgerEntry,
    CreditLedgerKind,
    FleetNode,
    Mission,
    Organization,
    Team,
    Tenant,
    User,
    Work,
    WorkDeployment,
} from '@ever-works/agent/entities';
import { PluginEntity } from '@ever-works/agent/plugins';

/**
 * An in-memory better-sqlite3 database with the whole entity inventory, and a
 * seed whose every free-text value is a CANARY: a string that must never
 * appear in a statistics payload.
 *
 * `insertRow` fills every string column of a seeded row that the caller did
 * not set with a unique `canary-…` marker (names, e-mails, descriptions,
 * URLs, prompts, slugs — whatever the entity has), so the canary list is
 * generated from the schema rather than written by hand, and a column added
 * later is covered the day it lands. Every id it generates (row UUIDs, `…Id`
 * columns) is a canary too, and so is every free value the seed sets by hand
 * (a custom deployment provider, an unknown Work kind, plugin ids). Enum-
 * constrained columns get their first allowed value instead (a marker would
 * break their CHECK constraint; a closed enum value names nobody).
 */
export async function createStatsDataSource(): Promise<DataSource> {
    const dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ENTITIES,
        synchronize: true,
        logging: false,
    });
    await dataSource.initialize();
    // Seeding a fully valid relation graph behind every row would dwarf what is
    // under test; the statistics queries never join.
    await dataSource.query('PRAGMA foreign_keys = OFF');
    return dataSource;
}

/** Every canary string written by {@link insertRow} in this process. */
export const CANARIES: string[] = [];

let canarySeq = 0;

/** A generated id — never allowed in a payload either. */
function generatedId(): string {
    const id = randomUUID();
    CANARIES.push(id);
    return id;
}

function canary(table: string, column: string): string {
    canarySeq += 1;
    const value = `canary-${table}-${column}-${canarySeq}`;
    CANARIES.push(value);
    return value;
}

/** Insert one row, filling every unset column the entity requires (and every string column). */
export async function insertRow<T extends ObjectLiteral>(
    dataSource: DataSource,
    entity: EntityTarget<T>,
    values: Record<string, unknown>,
    options: { createdAt?: Date } = {},
): Promise<Record<string, unknown>> {
    const metadata = dataSource.getMetadata(entity);
    const row: Record<string, unknown> = { ...values };
    for (const column of metadata.columns) {
        const key = column.propertyPath;
        if (key.includes('.')) continue;
        if (key in row) continue;
        if (column.isCreateDate || column.isUpdateDate || column.isDeleteDate || column.isVersion)
            continue;
        if (column.isGenerated) {
            if (column.generationStrategy === 'uuid') row[key] = generatedId();
            continue;
        }
        const type =
            typeof column.type === 'function'
                ? column.type.name.toLowerCase()
                : String(column.type);
        const required = !column.isNullable && column.default === undefined;
        if (column.enum && column.enum.length > 0) {
            if (required) row[key] = column.enum[0];
            continue;
        }
        if (/char|text|string/.test(type)) {
            row[key] =
                /uuid/i.test(key) || key.endsWith('Id')
                    ? generatedId()
                    : canary(metadata.tableName, key);
            continue;
        }
        if (type === 'uuid') {
            row[key] = generatedId();
            continue;
        }
        if (!required) continue;
        if (/int|number|numeric|decimal|float|double|real/.test(type)) row[key] = 0;
        else if (/bool/.test(type)) row[key] = false;
        else if (/date|time/.test(type)) row[key] = new Date();
        else if (/simple-array/.test(type)) row[key] = [];
        else if (/json/.test(type)) row[key] = {};
        else row[key] = canary(metadata.tableName, key);
    }
    const repository = dataSource.getRepository(entity);
    await repository.insert(row as never);
    if (options.createdAt) {
        const primary = metadata.primaryColumns.map((column) => column.propertyPath);
        const where = Object.fromEntries(primary.map((name) => [name, row[name]]));
        await repository.update(where as never, { createdAt: options.createdAt } as never);
    }
    return row;
}

/** The fixed facts of {@link seedOneUserInstance}, for assertions. */
export interface SeededInstance {
    period: string;
    inPeriod: Date;
    beforePeriod: Date;
    person: { email: string; name: string; username: string };
    company: string;
    workName: string;
    repoUrl: string;
    prompt: string;
}

/**
 * A one-person installation — the smallest real case, which reports full
 * counts like any other (there is no small-instance rule):
 *
 * - 1 person (+ 1 anonymous guest, not counted), 1 tenant, 1 organization;
 * - 3 Works: `website`, `app`, and one with a kind the schema does not list
 *   (counted under `other`);
 * - 1 agent, 1 mission, 1 team, 1 fleet node, 2 plugin rows (1 loaded);
 * - in the period: 2 deployments (`vercel`, a custom provider → `other`),
 *   1 run, credits consumed −5 and −3 (= 8); outside it: 1 deployment, 1 run,
 *   1 consumption; plus a purchase that is never counted as consumed.
 */
export async function seedOneUserInstance(
    dataSource: DataSource,
    period = '2026-10',
): Promise<SeededInstance> {
    const [year, month] = period.split('-').map(Number);
    const inPeriod = new Date(Date.UTC(year, month - 1, 10, 12, 0, 0));
    const beforePeriod = new Date(Date.UTC(year, month - 2, 10, 12, 0, 0));
    const person = {
        email: 'canary.person@example.invalid',
        name: 'Canary Person',
        username: 'canary-person',
    };
    const company = 'Canary Company Ltd';
    const workName = 'Canary Work Of Art';
    const repoUrl = 'https://github.com/canary-org/canary-repo';
    const prompt = 'Build a canary directory of secret things';
    CANARIES.push(person.email, person.name, person.username, company, workName, repoUrl, prompt);
    // The free values set by hand below: an unknown Work kind and a custom
    // deployment provider (both counted under `other`, never named), and the
    // plugin ids (counted, never named).
    CANARIES.push(
        'a-kind-from-the-future',
        'acme-internal-deployer',
        'ever-stats-sink',
        'another-plugin',
    );

    const user = await insertRow(dataSource, User, {
        email: person.email,
        username: person.username,
        name: person.name,
        isAnonymous: false,
        isPlatformAdmin: true,
    });
    await insertRow(dataSource, User, { isAnonymous: true });
    await insertRow(dataSource, Tenant, {});
    await insertRow(dataSource, Organization, { name: company });
    for (const kind of ['website', 'app', 'a-kind-from-the-future']) {
        await insertRow(dataSource, Work, {
            kind,
            name: workName,
            userId: user.id,
            description: prompt,
            gitRepositoryUrl: repoUrl,
        });
    }
    await insertRow(dataSource, Agent, {});
    await insertRow(dataSource, Mission, {});
    await insertRow(dataSource, Team, {});
    await insertRow(dataSource, FleetNode, {});
    await insertRow(dataSource, PluginEntity, { pluginId: 'ever-stats-sink', state: 'loaded' });
    await insertRow(dataSource, PluginEntity, { pluginId: 'another-plugin', state: 'unloaded' });
    await insertRow(dataSource, WorkDeployment, { provider: 'vercel' }, { createdAt: inPeriod });
    await insertRow(
        dataSource,
        WorkDeployment,
        { provider: 'acme-internal-deployer' },
        { createdAt: inPeriod },
    );
    await insertRow(
        dataSource,
        WorkDeployment,
        { provider: 'vercel' },
        { createdAt: beforePeriod },
    );
    await insertRow(dataSource, AgentRun, { startedAt: inPeriod });
    await insertRow(dataSource, AgentRun, { startedAt: beforePeriod });
    await insertRow(
        dataSource,
        CreditLedgerEntry,
        { kind: CreditLedgerKind.CONSUMPTION, amountCredits: -5 },
        { createdAt: inPeriod },
    );
    await insertRow(
        dataSource,
        CreditLedgerEntry,
        { kind: CreditLedgerKind.CONSUMPTION, amountCredits: -3 },
        { createdAt: inPeriod },
    );
    await insertRow(
        dataSource,
        CreditLedgerEntry,
        { kind: CreditLedgerKind.CONSUMPTION, amountCredits: -40 },
        { createdAt: beforePeriod },
    );
    await insertRow(
        dataSource,
        CreditLedgerEntry,
        { kind: CreditLedgerKind.PURCHASE, amountCredits: 100 },
        { createdAt: inPeriod },
    );

    return { period, inPeriod, beforePeriod, person, company, workName, repoUrl, prompt };
}
