import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DataSource, EntityMetadata, InsertEvent } from 'typeorm';
import { ScopeContextService } from '../scope-context.service';
import { ScopeStampingSubscriber } from '../scope-stamping.subscriber';

const REPOSITORY_ROOT = resolve(__dirname, '../../../../..');

interface CreationPath {
    domain: string;
    entityFile: string;
    serviceFile: string;
    createStart: string;
    createEnd: string;
    requiredInsertTokens: string[];
    supportingFile?: string;
    supportingStart?: string;
    supportingEnd?: string;
}

const CREATION_PATHS: CreationPath[] = [
    {
        domain: 'Mission',
        entityFile: 'packages/agent/src/entities/mission.entity.ts',
        serviceFile: 'packages/agent/src/missions/missions.service.ts',
        createStart: '    async create(userId: string, input: CreateMissionInput)',
        createEnd: '    async update(',
        requiredInsertTokens: ['this.missions.create({', 'this.missions.save('],
    },
    {
        domain: 'Goal',
        entityFile: 'packages/agent/src/entities/goal.entity.ts',
        serviceFile: 'packages/agent/src/goals/goals.service.ts',
        createStart: '    async create(userId: string, input: CreateGoalInput)',
        createEnd: '    async update(',
        requiredInsertTokens: ['this.goals.create({', 'this.goals.save('],
    },
    {
        domain: 'Work',
        entityFile: 'packages/agent/src/entities/work.entity.ts',
        serviceFile: 'packages/agent/src/database/repositories/work.repository.ts',
        createStart: '    async create(dto: Partial<Work>, user: User)',
        createEnd: '    async createOrUpdate(',
        requiredInsertTokens: ['this.repository.create(dto)', 'this.repository.save(work)'],
    },
    {
        domain: 'Agent',
        entityFile: 'packages/agent/src/entities/agent.entity.ts',
        serviceFile: 'packages/agent/src/agents/agents.service.ts',
        createStart: '    async create(userId: string, input: CreateAgentInput)',
        createEnd: '    async update(',
        requiredInsertTokens: ['this.agents', '.create({'],
        supportingFile: 'packages/agent/src/database/repositories/agent.repository.ts',
        supportingStart: '    async create(data: Partial<Agent>)',
        supportingEnd: '    async updateById(',
    },
];

function source(relativePath: string): string {
    return readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8');
}

function section(text: string, start: string, end: string): string {
    const startIndex = text.indexOf(start);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    const endIndex = text.indexOf(end, startIndex + start.length);
    expect(endIndex).toBeGreaterThan(startIndex);
    return text.slice(startIndex, endIndex);
}

function makeEvent(entity: Record<string, unknown>): InsertEvent<unknown> {
    return {
        entity,
        metadata: {
            columns: ['id', 'tenantId', 'organizationId'].map((propertyName) => ({
                propertyName,
            })),
        } as unknown as EntityMetadata,
    } as InsertEvent<unknown>;
}

describe('Scope stamping across Mission/Goal/Work/Agent creation paths', () => {
    const tenantId = 'tenant-ever';
    const organizationId = 'organization-ever';

    it.each(CREATION_PATHS)(
        '$domain is a Tier-C entity whose real create path leaves scope implicit for the subscriber',
        (path) => {
            const entitySource = source(path.entityFile);
            expect(entitySource).toMatch(
                /@Column\([^)]*nullable:\s*true[^)]*\)[\s\S]*tenantId\??:/,
            );
            expect(entitySource).toMatch(
                /@Column\([^)]*nullable:\s*true[^)]*\)[\s\S]*organizationId\??:/,
            );

            const createPath = section(source(path.serviceFile), path.createStart, path.createEnd);
            for (const token of path.requiredInsertTokens) expect(createPath).toContain(token);
            expect(createPath).not.toMatch(/\b(?:tenantId|organizationId)\s*:/);

            if (path.supportingFile && path.supportingStart && path.supportingEnd) {
                const supportingPath = section(
                    source(path.supportingFile),
                    path.supportingStart,
                    path.supportingEnd,
                );
                expect(supportingPath).toContain('this.repository.create(data)');
                expect(supportingPath).toContain('this.repository.save(entity)');
                expect(supportingPath).not.toMatch(/\b(?:tenantId|organizationId)\s*:/);
            }

            const scopeContext = new ScopeContextService();
            const subscriber = new ScopeStampingSubscriber(
                { subscribers: [] } as unknown as DataSource,
                scopeContext,
            );
            const row: Record<string, unknown> = { id: `${path.domain.toLowerCase()}-1` };
            scopeContext.runWith({ tenantId, organizationId }, () => {
                subscriber.beforeInsert(makeEvent(row));
            });

            expect(row).toMatchObject({ tenantId, organizationId });
        },
    );
});
