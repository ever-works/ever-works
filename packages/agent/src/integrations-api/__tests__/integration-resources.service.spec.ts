import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { DataSource } from 'typeorm';
import {
    CONTRACT_DIR,
    createDomainEventsDataSource,
    ORG_A,
    ORG_B,
    TENANT,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { Agent } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { OrganizationMember } from '../../entities/organization-member.entity';
import { Task } from '../../entities/task.entity';
import { TaskChatMessage } from '../../entities/task-chat-message.entity';
import { Team } from '../../entities/team.entity';
import { Tenant } from '../../entities/tenant.entity';
import { User } from '../../entities/user.entity';
import { WorkProposal } from '../../entities/work-proposal.entity';
import { ExternalRecordLinksService } from '../external-record-links.service';
import { ResourceNotFoundError } from '../integration-api.errors';
import { IntegrationResourcesService } from '../integration-resources.service';

/**
 * Integration API v1 reads (EW-P1-4) on SQLite: org-scoped keyset lists and
 * gets built from the domain-event snapshots, `externalLinks` for the caller's
 * source, `ETag`, and every DTO valid against the published contract schema.
 */
const BASE = 'https://ever.works/schemas/integrations/v1/';

function contract() {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) return walk(path);
            return name.endsWith('.schema.json') ? [path] : [];
        });
    for (const file of walk(join(CONTRACT_DIR, 'schemas'))) {
        ajv.addSchema(JSON.parse(readFileSync(file, 'utf8')));
    }
    return (ref: string, value: unknown) => {
        const validate = ajv.getSchema(BASE + ref)!;
        if (!validate(JSON.parse(JSON.stringify(value)))) {
            throw new Error(`${ref}: ${JSON.stringify(validate.errors, null, 1)}`);
        }
    };
}

describe('IntegrationResourcesService', () => {
    let dataSource: DataSource;
    let links: ExternalRecordLinksService;
    let resources: IntegrationResourcesService;
    const expectValid = contract();
    const OWNER = randomUUID();

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        links = new ExternalRecordLinksService(dataSource);
        resources = new IntegrationResourcesService(dataSource, links);
    });

    beforeEach(async () => {
        for (const table of [
            'task_chat_messages',
            'tasks',
            'teams',
            'agents',
            'organizations',
            'organization_members',
            'users',
            'external_record_links',
            'work_proposals',
            'tenants',
        ]) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
        await dataSource.getRepository(Organization).insert([
            {
                id: ORG_A,
                tenantId: TENANT,
                slug: `a-${randomUUID().slice(0, 6)}`,
                displayName: 'Acme',
            },
            {
                id: ORG_B,
                tenantId: TENANT,
                slug: `b-${randomUUID().slice(0, 6)}`,
                displayName: 'Beta',
            },
        ] as unknown as Organization[]);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const task = (organizationId: string, title: string) =>
        dataSource.getRepository(Task).save({
            id: randomUUID(),
            userId: OWNER,
            slug: `T-${Math.floor(Math.random() * 1e6)}`,
            title,
            createdByType: 'user',
            createdById: OWNER,
            tenantId: TENANT,
            organizationId,
            // What the record-visibility subscriber stamps on an org row in the app
            // (the bare test DataSource has no subscriber, so the column default
            // `private` would apply).
            visibility: 'organization',
        } as unknown as Task);

    it('lists only the pinned organization tasks, as contract task DTOs with externalLinks', async () => {
        const mine = await task(ORG_A, 'Ship the feed');
        await task(ORG_B, 'Not yours');
        await links.create(
            { organizationId: ORG_A, source: 'gauzy', installationId: 'conn-1' },
            { entityType: 'task', entityId: mine.id, externalId: 'g-1' },
        );
        const page = await resources.list('task', ORG_A, { limit: 50 }, 'gauzy');
        expect(page.data.map((dto) => dto.id)).toEqual([mine.id]);
        expect(page).toMatchObject({ hasMore: false, nextCursor: null });
        expect(page.data[0].externalLinks).toEqual([
            { source: 'gauzy', installationId: 'conn-1', externalId: 'g-1', externalUrl: null },
        ]);
        expectValid('resources/task.schema.json', page.data[0]);
        // Another source sees no links.
        const jira = await resources.list('task', ORG_A, {}, 'jira');
        expect(jira.data[0].externalLinks).toEqual([]);
    });

    it('pages with a cursor and filters by updatedSince', async () => {
        const created = [];
        for (let i = 0; i < 3; i++) created.push(await task(ORG_A, `Task ${i}`));
        const first = await resources.list('task', ORG_A, { limit: 2 }, 'gauzy');
        expect(first.data).toHaveLength(2);
        expect(first.hasMore).toBe(true);
        const second = await resources.list(
            'task',
            ORG_A,
            { limit: 2, cursor: first.nextCursor },
            'gauzy',
        );
        expect([...first.data, ...second.data].map((dto) => dto.id).sort()).toEqual(
            created.map((row) => row.id).sort(),
        );
        const later = await resources.list(
            'task',
            ORG_A,
            { updatedSince: new Date(Date.now() + 60_000) },
            'gauzy',
        );
        expect(later.data).toEqual([]);
    });

    it('never serves a task whose STORED visibility is private, nor links to it', async () => {
        const shared = await task(ORG_A, 'Shared');
        const secret = await task(ORG_A, 'Secret');
        await dataSource.getRepository(Task).update(secret.id, { visibility: 'private' } as never);
        const page = await resources.list('task', ORG_A, {}, 'gauzy');
        expect(page.data.map((dto) => dto.id)).toEqual([shared.id]);
        await expect(resources.get('task', ORG_A, secret.id, 'gauzy')).rejects.toBeInstanceOf(
            ResourceNotFoundError,
        );
        const rows = [
            { entityType: 'task', entityId: shared.id },
            { entityType: 'task', entityId: secret.id },
            { entityType: 'team', entityId: randomUUID() },
        ];
        expect((await resources.withoutPrivateTargets(rows)).map((row) => row.entityId)).toEqual([
            shared.id,
            rows[2].entityId,
        ]);
    });

    it('gets one resource with its ETag, and 404s outside the organization', async () => {
        const mine = await task(ORG_A, 'Ship the feed');
        const other = await task(ORG_B, 'Not yours');
        const got = await resources.get('task', ORG_A, mine.id, 'gauzy');
        expect(got.etag).toBe('"1"');
        expect(got.dto).toMatchObject({ id: mine.id, title: 'Ship the feed', externalLinks: [] });
        await expect(resources.get('task', ORG_A, other.id, 'gauzy')).rejects.toBeInstanceOf(
            ResourceNotFoundError,
        );
        await expect(resources.get('task', ORG_A, randomUUID(), 'gauzy')).rejects.toBeInstanceOf(
            ResourceNotFoundError,
        );
    });

    it('serves teams and agents of the organization as contract DTOs', async () => {
        const team = await dataSource.getRepository(Team).save({
            userId: OWNER,
            name: 'Platform',
            slug: 'platform',
            tenantId: TENANT,
            organizationId: ORG_A,
        } as unknown as Team);
        const agent = await dataSource.getRepository(Agent).save({
            userId: OWNER,
            scope: 'tenant',
            name: 'Builder',
            slug: 'builder',
            permissions: {},
            tenantId: TENANT,
            organizationId: ORG_A,
            visibility: 'organization',
        } as unknown as Agent);
        const teams = await resources.list('team', ORG_A, {}, 'gauzy');
        expect(teams.data.map((dto) => dto.id)).toEqual([team.id]);
        expectValid('resources/team.schema.json', teams.data[0]);
        const agentDto = await resources.get('agent', ORG_A, agent.id, 'gauzy');
        expectValid('resources/agent.schema.json', agentDto.dto);
    });

    it("lists a task's comments with their links, and 404s for a task outside the organization", async () => {
        const mine = await task(ORG_A, 'Ship the feed');
        const other = await task(ORG_B, 'Not yours');
        const messages = dataSource.getRepository(TaskChatMessage);
        const first = await messages.save({
            taskId: mine.id,
            authorType: 'integration',
            authorId: randomUUID(),
            body: 'From Gauzy',
            externalAuthor: { name: 'Ada', avatarUrl: null, source: 'gauzy' },
        } as unknown as TaskChatMessage);
        await messages.save({
            taskId: mine.id,
            authorType: 'user',
            authorId: OWNER,
            body: 'Thanks',
        } as unknown as TaskChatMessage);
        await links.create(
            { organizationId: ORG_A, source: 'gauzy', installationId: null },
            { entityType: 'task_comment', entityId: first.id, externalId: 'c-1' },
        );

        const page = await resources.comments(ORG_A, mine.id, { limit: 1 }, 'gauzy');
        expect(page.hasMore).toBe(true);
        const rest = await resources.comments(
            ORG_A,
            mine.id,
            { limit: 1, cursor: page.nextCursor },
            'gauzy',
        );
        const all = [...page.data, ...rest.data];
        expect(all).toHaveLength(2);
        for (const dto of all) expectValid('resources/task-comment.schema.json', dto);
        const linked = all.find((dto) => dto.id === first.id);
        expect(linked).toMatchObject({
            organizationId: ORG_A,
            authorType: 'integration',
            externalLinks: [expect.objectContaining({ source: 'gauzy', externalId: 'c-1' })],
        });

        expect(await resources.comment(ORG_A, mine.id, first.id, 'gauzy')).toMatchObject({
            id: first.id,
            body: 'From Gauzy',
        });
        await expect(resources.comments(ORG_A, other.id, {}, 'gauzy')).rejects.toBeInstanceOf(
            ResourceNotFoundError,
        );
        await expect(
            resources.comment(ORG_A, mine.id, randomUUID(), 'gauzy'),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    const idea = (organizationId: string, title: string, visibility = 'organization') =>
        dataSource.getRepository(WorkProposal).save({
            userId: OWNER,
            title,
            description: 'A self-service portal.',
            slugSuggestion: 'portal',
            suggestedCategories: [],
            suggestedFields: [],
            recommendedPlugins: [],
            reasoning: 'test',
            source: 'external',
            status: 'pending',
            tenantId: TENANT,
            organizationId,
            visibility,
        } as unknown as WorkProposal);

    it('serves the organization Ideas (EW-P2-1) as contract DTOs, never a private one, and links to them', async () => {
        const shared = await idea(ORG_A, 'Customer portal');
        const secret = await idea(ORG_A, 'Secret', 'private');
        await idea(ORG_B, 'Not yours');
        await links.create(
            { organizationId: ORG_A, source: 'gauzy', installationId: 'conn-1' },
            { entityType: 'idea', entityId: shared.id, externalId: 'g-idea-1' },
        );
        const page = await resources.list('idea', ORG_A, {}, 'gauzy');
        expect(page.data.map((dto) => dto.id)).toEqual([shared.id]);
        expect(page.data[0]).toMatchObject({
            status: 'pending',
            source: 'external',
            externalLinks: [expect.objectContaining({ externalId: 'g-idea-1' })],
        });
        expectValid('resources/idea.schema.json', page.data[0]);
        const got = await resources.get('idea', ORG_A, shared.id, 'gauzy');
        expect(got.etag).toBe('"1"');
        await expect(resources.get('idea', ORG_A, secret.id, 'gauzy')).rejects.toBeInstanceOf(
            ResourceNotFoundError,
        );
        expect(await resources.assertLinkTarget('idea', ORG_A, shared.id, 'gauzy')).toBe(true);
        await expect(
            resources.assertLinkTarget('idea', ORG_A, secret.id, 'gauzy'),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(
            (
                await resources.withoutPrivateTargets([
                    { entityType: 'idea', entityId: shared.id },
                    { entityType: 'idea', entityId: secret.id },
                ])
            ).map((row) => row.entityId),
        ).toEqual([shared.id]);
    });

    it('serves the organization and its members', async () => {
        const org = await resources.organization(ORG_A);
        expect(org.dto).toMatchObject({ id: ORG_A, displayName: 'Acme' });
        expect(org.etag).toBe('"1"');
        expectValid('resources/organization.schema.json', org.dto);

        const userId = randomUUID();
        await dataSource.getRepository(User).insert({
            id: userId,
            username: 'ruslan',
            slug: `ruslan-${userId.slice(0, 6)}`,
            email: 'ruslan@example.com',
            tenantId: TENANT,
            isActive: true,
        } as unknown as User);
        await dataSource.getRepository(OrganizationMember).insert({
            organizationId: ORG_A,
            userId,
            tenantId: TENANT,
            role: 'member',
            joinedAt: new Date(),
        } as unknown as OrganizationMember);
        const members = await resources.members(ORG_A, {});
        expect(members.data).toHaveLength(1);
        expect(members.data[0]).toMatchObject({
            organizationId: ORG_A,
            userId,
            username: 'ruslan',
        });
        expectValid('resources/member.schema.json', members.data[0]);
    });

    it('lists the Tenant owner as a member (role owner) when they have no roster row', async () => {
        // The owner of a one-person tenant created the organization and has no
        // organization_members row: the roster was empty, so an integration could
        // never pair them (local Gauzy ↔ Ever Works e2e, 2026-10-18).
        const ownerId = randomUUID();
        await dataSource.getRepository(User).insert({
            id: ownerId,
            username: 'owner',
            slug: `owner-${ownerId.slice(0, 6)}`,
            email: 'owner@example.com',
            tenantId: TENANT,
            isActive: true,
        } as unknown as User);
        await dataSource.getRepository(Tenant).insert({
            id: TENANT,
            ownerUserId: ownerId,
            slug: `t-${ownerId.slice(0, 6)}`,
            displayName: 'Tenant',
        } as unknown as Tenant);

        const first = await resources.members(ORG_A, {});
        expect(first.data).toHaveLength(1);
        expect(first.data[0]).toMatchObject({
            organizationId: ORG_A,
            userId: ownerId,
            role: 'owner',
            isActive: true,
        });
        expectValid('resources/member.schema.json', first.data[0]);
        await expect(resources.assertLinkTarget('member', ORG_A, ownerId, 'gauzy')).resolves.toBe(
            true,
        );
        await expect(
            resources.assertLinkTarget('member', ORG_A, randomUUID(), 'gauzy'),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);

        // Not when nothing changed since `updatedSince`, and only on the first page.
        expect(
            (await resources.members(ORG_A, { updatedSince: new Date(Date.now() + 60_000) })).data,
        ).toEqual([]);
        const others = [randomUUID(), randomUUID()];
        for (const [i, id] of others.entries()) {
            await dataSource.getRepository(User).insert({
                id,
                username: `m${i}`,
                slug: `m${i}-${id.slice(0, 6)}`,
                email: `m${i}@example.com`,
                tenantId: TENANT,
                isActive: true,
            } as unknown as User);
            await dataSource.getRepository(OrganizationMember).insert({
                organizationId: ORG_A,
                userId: id,
                tenantId: TENANT,
                role: 'member',
                joinedAt: new Date(),
            } as unknown as OrganizationMember);
        }
        // The owner counts toward the page limit (review on #2723): every page holds at most `limit` members,
        // and walking the cursor lists everybody exactly once.
        for (const limit of [1, 2]) {
            const seen: unknown[] = [];
            let cursor: string | null | undefined;
            for (let n = 0; n < 5; n++) {
                const page = await resources.members(ORG_A, { limit, cursor });
                expect(page.data.length).toBeLessThanOrEqual(limit);
                seen.push(...page.data.map((m) => m.userId));
                if (!page.hasMore) break;
                expect(page.nextCursor).toBeTruthy();
                cursor = page.nextCursor;
            }
            expect(seen[0]).toBe(ownerId);
            expect([...seen].sort()).toEqual([ownerId, ...others].sort());
        }
        await dataSource.query(
            `DELETE FROM "organization_members" WHERE "userId" IN (?, ?)`,
            others,
        );

        // Once the owner has a roster row of their own, it is listed once, as that row.
        await dataSource.getRepository(OrganizationMember).insert({
            organizationId: ORG_A,
            userId: ownerId,
            tenantId: TENANT,
            role: 'owner',
            joinedAt: new Date(),
        } as unknown as OrganizationMember);
        const again = await resources.members(ORG_A, {});
        expect(again.data.map((m) => m.userId)).toEqual([ownerId]);
    });
});
