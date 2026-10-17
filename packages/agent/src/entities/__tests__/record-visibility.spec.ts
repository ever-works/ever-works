import { getMetadataArgsStorage } from 'typeorm';
import { Agent } from '../agent.entity';
import { Goal } from '../goal.entity';
import { Mission } from '../mission.entity';
import { Task } from '../task.entity';
import { TEAM_RESOURCE_TYPES } from '../team-resource.entity';
import { WorkProposal } from '../work-proposal.entity';
import { applyInsertVisibilityDefault, hasVisibilityColumns } from '../_record-visibility';
import { RecordVisibilitySubscriber } from '../../database/record-visibility.subscriber';
import { databaseConfig } from '../../database/database.config';

/**
 * Record visibility columns + insert default (EW-P1-3,
 * `docs/specs/features/record-visibility/spec.md` §1 and §5).
 */
const ENTITIES = [
    ['Task', Task, 'tasks'],
    ['Goal', Goal, 'goals'],
    ['Mission', Mission, 'missions'],
    ['WorkProposal', WorkProposal, 'work_proposals'],
    ['Agent', Agent, 'agents'],
] as const;

type VisibilityInstance = {
    visibility?: string | null;
    visibilityExplicit?: boolean | null;
    organizationId?: string | null;
    teamId?: string | null;
};

const subscriber = new RecordVisibilitySubscriber();

/** Run the subscriber's beforeInsert on a row of `entityClass`, as TypeORM would. */
function inserted(entityClass: (typeof ENTITIES)[number][1], fields: object): VisibilityInstance {
    const row = Object.assign(Object.create(entityClass.prototype), fields) as VisibilityInstance;
    const columns = getMetadataArgsStorage()
        .filterColumns(entityClass)
        .map((column) => ({ propertyName: column.propertyName }));
    subscriber.beforeInsert({ entity: row, metadata: { columns } } as never);
    return row;
}

describe('record visibility columns (EW-P1-3)', () => {
    it.each(ENTITIES)(
        '%s declares visibility varchar(16) default private + visibilityExplicit boolean default false',
        (_name, entityClass) => {
            const columns = getMetadataArgsStorage().filterColumns(entityClass);
            const visibility = columns.find((column) => column.propertyName === 'visibility');
            const explicit = columns.find((column) => column.propertyName === 'visibilityExplicit');
            expect(visibility?.options).toEqual(
                expect.objectContaining({ type: 'varchar', length: 16, default: 'private' }),
            );
            expect(visibility?.options.nullable).toBeFalsy();
            expect(explicit?.options).toEqual(
                expect.objectContaining({ type: 'boolean', default: false }),
            );
            expect(explicit?.options.nullable).toBeFalsy();
        },
    );

    it.each(ENTITIES)('%s declares the org-visibility index', (_name, entityClass, table) => {
        const indices = getMetadataArgsStorage().indices.filter(
            (index) => index.target === entityClass,
        );
        expect(indices.map((index) => index.name)).toContain(`idx_${table}_org_visibility`);
    });

    it.each(ENTITIES)('%s: a personal row stays `private`', (_name, entityClass) => {
        const row = inserted(entityClass, { organizationId: null });
        expect(row.visibility).toBe('private');
    });

    it.each(ENTITIES)(
        '%s: an unstamped row is left for ScopeStampingSubscriber (then the column default)',
        (_name, entityClass) => {
            const row = inserted(entityClass, {});
            expect(row.visibility).toBeUndefined();
        },
    );

    it('a Task created with a teamId starts `team`', () => {
        const row = inserted(Task, { organizationId: 'org-1', teamId: 'team-1' });
        expect(row.visibility).toBe('team');
    });

    it('a visibility chosen by the caller is kept', () => {
        const row = inserted(Task, {
            organizationId: 'org-1',
            teamId: 'team-1',
            visibility: 'private',
            visibilityExplicit: true,
        });
        expect(row.visibility).toBe('private');
        expect(row.visibilityExplicit).toBe(true);
    });

    it('applyInsertVisibilityDefault is idempotent', () => {
        const row: Parameters<typeof applyInsertVisibilityDefault>[0] = { organizationId: 'org-1' };
        applyInsertVisibilityDefault(row, false);
        applyInsertVisibilityDefault(row, true);
        expect(row).toEqual({
            organizationId: 'org-1',
            visibility: 'organization',
            visibilityExplicit: false,
        });
    });

    it('the subscriber ignores entities without the visibility columns', () => {
        const row: Record<string, unknown> = { organizationId: 'org-1' };
        subscriber.beforeInsert({
            entity: row,
            metadata: { columns: [{ propertyName: 'organizationId' }] },
        } as never);
        expect(row).not.toHaveProperty('visibility');
    });

    it('the subscriber is registered with every DataSource built from databaseConfig()', () => {
        const options = databaseConfig() as { subscribers?: unknown[] };
        expect(options.subscribers).toContain(RecordVisibilitySubscriber);
        // TypeORM instantiates a listed subscriber ONLY when it carries @EventSubscriber().
        expect(
            getMetadataArgsStorage().filterSubscribers([RecordVisibilitySubscriber]),
        ).toHaveLength(1);
    });

    it('hasVisibilityColumns needs both columns', () => {
        expect(hasVisibilityColumns(['visibility', 'visibilityExplicit'])).toBe(true);
        expect(hasVisibilityColumns(['visibility'])).toBe(false);
        expect(hasVisibilityColumns(['id'])).toBe(false);
    });
});
