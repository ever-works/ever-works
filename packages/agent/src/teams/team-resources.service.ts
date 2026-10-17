import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import type { VisibilityAggregate } from '@ever-works/contracts';
import { RecordVisibilityService } from '../record-visibility/record-visibility.service';
import { InjectRepository } from '@nestjs/typeorm';
import { type EntityManager, In, Repository } from 'typeorm';
import { DomainEventPublisher } from '../domain-events/domain-event-publisher.service';
import { Agent } from '../entities/agent.entity';
import { Goal } from '../entities/goal.entity';
import { Mission } from '../entities/mission.entity';
import { Organization } from '../entities/organization.entity';
import { Task } from '../entities/task.entity';
import { Team } from '../entities/team.entity';
import {
    TEAM_RESOURCE_TYPES,
    TeamResource,
    type TeamResourceType,
} from '../entities/team-resource.entity';
import { Work } from '../entities/work.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import {
    AttachTeamResourceInput,
    ResourceTeamRef,
    TeamResourceItem,
    TeamResourcesGrouped,
} from './types';

/** Minimal shape every resource repo exposes for the IDOR + display resolve. */
interface ScopedResourceRow {
    id: string;
    tenantId?: string | null;
    organizationId?: string | null;
}

/**
 * Teams & Prebuilt Companies — Team ↔ resource association service
 * (operator ask "some Works belong to some Teams", generalized to
 * Works / Tasks / Agents / Missions / Ideas / Goals).
 *
 * Authorization happens BEFORE these methods run: every route is behind
 * `OrganizationOwnershipGuard` (fail-closed tenant-ownership, 404 posture).
 * This service re-validates the *object graph* — that both the Team AND the
 * referenced resource actually belong to the same Organization/Tenant — so a
 * legitimate caller cannot link a foreign Work/Agent/… by id (the EW-711
 * IDOR class). 404-never-403 throughout: foreign and missing ids are
 * indistinguishable to the caller.
 */
@Injectable()
export class TeamResourcesService {
    constructor(
        @InjectRepository(TeamResource)
        private readonly resources: Repository<TeamResource>,
        @InjectRepository(Team)
        private readonly teams: Repository<Team>,
        @InjectRepository(Organization)
        private readonly organizations: Repository<Organization>,
        @InjectRepository(Work)
        private readonly works: Repository<Work>,
        @InjectRepository(Agent)
        private readonly agents: Repository<Agent>,
        @InjectRepository(Mission)
        private readonly missions: Repository<Mission>,
        @InjectRepository(WorkProposal)
        private readonly ideas: Repository<WorkProposal>,
        @InjectRepository(Task)
        private readonly tasks: Repository<Task>,
        // Domain events (EW-P1-1 B2) — `team.resource.*`, plus `task.updated` /
        // `work.updated` for an attached task or work (their `teamIds` change).
        // Appended LAST + @Optional.
        @Optional() private readonly domainEvents?: DomainEventPublisher,
        // EW-P1-3: goals sit on Teams too (`team_resources` type `goal`). After the
        // domain-event publisher so positional test fixtures keep their indices;
        // @Optional() because a required parameter cannot follow an optional one.
        @Optional()
        @InjectRepository(Goal)
        private readonly goals?: Repository<Goal>,
        // Record visibility (EW-P1-3) — attaching a record's first Team narrows it to
        // `team`, detaching its last widens it to `organization` (while not chosen
        // by hand). @Optional(): absent means no automatic change.
        @Optional() private readonly visibility?: RecordVisibilityService,
    ) {}

    /** The resource-side event of a team resource change (its DTO's `teamIds` moved). */
    private async recordResourceSide(
        publisher: DomainEventPublisher,
        manager: EntityManager,
        resourceType: TeamResourceType,
        resourceId: string,
    ): Promise<void> {
        if (resourceType === 'task') {
            await publisher.changed(manager, 'task', resourceId, 'task.updated', {
                changedFields: ['teamIds'],
            });
        } else if (resourceType === 'work') {
            await publisher.changed(manager, 'work', resourceId, 'work.updated', {
                changedFields: ['teamIds'],
            });
        } else if (resourceType === 'idea') {
            // EW-P2-1: an Idea's Teams are its `team_resources` rows.
            await publisher.changed(manager, 'idea', resourceId, 'idea.updated', {
                changedFields: ['teamIds'],
            });
        } else if (resourceType === 'goal') {
            // EW-P2-2: a Goal's Teams are its `team_resources` rows (EW-P1-3 type `goal`).
            await publisher.changed(manager, 'goal', resourceId, 'goal.updated', {
                changedFields: ['teamIds'],
            });
        } else if (resourceType === 'mission') {
            // EW-P2-5: a Mission's Teams are its `team_resources` rows (D11).
            await publisher.changed(manager, 'mission', resourceId, 'mission.updated', {
                changedFields: ['teamIds'],
            });
        }
    }

    /**
     * Attach a resource to a Team. Validates the Team is in the org AND the
     * resource exists + belongs to the same tenant/org (IDOR guard). Scope
     * columns are stamped from the Team (not the ALS subscriber — raw
     * `/api/organizations/:orgId/...` routes run with EMPTY_SCOPE).
     */
    async attach(
        userId: string,
        orgId: string,
        teamId: string,
        input: AttachTeamResourceInput,
    ): Promise<TeamResourceItem> {
        const resourceType = this.normalizeResourceType(input.resourceType);
        const team = await this.getTeamOrThrow(orgId, teamId);
        const org = await this.organizations.findOne({ where: { id: orgId } });
        if (!org) {
            throw new NotFoundException(`Organization ${orgId} not found`);
        }

        const resource = await this.assertResourceInOrg(org, resourceType, input.resourceId);

        const row = this.resources.create({
            teamId: team.id,
            resourceType,
            resourceId: input.resourceId,
            addedById: userId,
            // Prefer the Team's stamped scope; fall back to the org (a Team is
            // always org-stamped in v1, so these agree).
            tenantId: team.tenantId ?? org.tenantId ?? null,
            organizationId: team.organizationId ?? org.id,
            createdAt: new Date(),
        });

        try {
            const publisher = this.domainEvents;
            const saved = publisher
                ? await publisher.transaction(async (manager) => {
                      const added = await manager.getRepository(TeamResource).save(row);
                      await publisher.child(
                          manager,
                          'team',
                          team.id,
                          'team.resource.added',
                          { teamId: team.id, resourceType, resourceId: input.resourceId },
                          { changedFields: ['resources'] },
                      );
                      await this.recomputeVisibilityIn(manager, resourceType, input.resourceId);
                      await this.recordResourceSide(
                          publisher,
                          manager,
                          resourceType,
                          input.resourceId,
                      );
                      return added;
                  })
                : await this.resources.save(row);
            await this.recomputeVisibility(resourceType, input.resourceId);
            return this.toItem(saved, this.resolveRef(resourceType, resource));
        } catch (error) {
            if (this.isUniqueViolation(error)) {
                throw new ConflictException('This resource is already attached to the team');
            }
            throw error;
        }
    }

    /** Detach a resource from a Team (idempotent-ish: 404 when nothing matched). */
    async detach(
        orgId: string,
        teamId: string,
        resourceType: TeamResourceType,
        resourceId: string,
    ): Promise<void> {
        const type = this.normalizeResourceType(resourceType);
        await this.getTeamOrThrow(orgId, teamId);
        const publisher = this.domainEvents;
        const result = publisher
            ? await publisher.transaction(async (manager) => {
                  const deleted = await manager
                      .getRepository(TeamResource)
                      .delete({ teamId, resourceType: type, resourceId });
                  if (deleted.affected) {
                      await publisher.child(
                          manager,
                          'team',
                          teamId,
                          'team.resource.removed',
                          { teamId, resourceType: type, resourceId, deleted: true },
                          { changedFields: ['resources'] },
                      );
                      await this.recomputeVisibilityIn(manager, type, resourceId);
                      await this.recordResourceSide(publisher, manager, type, resourceId);
                  }
                  return deleted;
              })
            : await this.resources.delete({ teamId, resourceType: type, resourceId });
        if (!result.affected) {
            throw new NotFoundException('Resource is not attached to this team');
        }
        await this.recomputeVisibility(type, resourceId);
    }

    /** Record visibility (EW-P1-3): re-apply D11 to a record whose Teams changed. */
    private async recomputeVisibility(
        resourceType: TeamResourceType,
        resourceId: string,
    ): Promise<void> {
        const aggregate = this.visibilityAggregateOf(resourceType);
        if (this.visibility && aggregate) {
            await this.visibility.recomputeAutomatic(aggregate, resourceId);
        }
    }

    /**
     * The same, inside the team-event transaction and BEFORE `recordResourceSide`, so the
     * task's `task.updated` snapshot already carries the new visibility (and no separate
     * notice is needed for it). Ideas likewise: `recordResourceSide` records `idea.updated`
     * for them (EW-P2-1), so a second event would bump the version twice for one change.
     * Other aggregates get their own `visibility_changed`.
     */
    private async recomputeVisibilityIn(
        manager: EntityManager,
        resourceType: TeamResourceType,
        resourceId: string,
    ): Promise<void> {
        const aggregate = this.visibilityAggregateOf(resourceType);
        if (!this.visibility || !aggregate) return;
        await this.visibility.recomputeAutomaticIn(manager, aggregate, resourceId, {
            recordEvent: aggregate !== 'task' && aggregate !== 'idea',
        });
    }

    private visibilityAggregateOf(resourceType: TeamResourceType): VisibilityAggregate | null {
        switch (resourceType) {
            case 'task':
            case 'goal':
            case 'mission':
            case 'idea':
            case 'agent':
                return resourceType;
            default:
                return null;
        }
    }

    /** List a Team's attached resources, resolved + grouped by type. */
    async listForTeam(orgId: string, teamId: string): Promise<TeamResourcesGrouped> {
        await this.getTeamOrThrow(orgId, teamId);
        const rows = await this.resources.find({
            where: { teamId },
            order: { createdAt: 'ASC' },
        });

        const grouped: TeamResourcesGrouped = {
            work: [],
            task: [],
            agent: [],
            mission: [],
            idea: [],
            goal: [],
        };
        if (rows.length === 0) {
            return grouped;
        }

        // Resolve display refs in one query per type present.
        const refsByType = await this.resolveRefsForRows(rows);
        for (const row of rows) {
            const type = row.resourceType;
            if (!this.isKnownType(type)) {
                continue;
            }
            const ref = refsByType.get(type)?.get(row.resourceId) ?? { name: null, slug: null };
            grouped[type].push(this.toItem(row, ref));
        }
        return grouped;
    }

    /**
     * Reverse lookup: which Teams (in this org) own a given resource. Filters
     * by `organizationId = orgId` so an attacker-supplied resourceId can only
     * ever reveal Teams inside the org they already passed the guard for.
     */
    async listTeamsForResource(
        orgId: string,
        resourceType: TeamResourceType,
        resourceId: string,
    ): Promise<ResourceTeamRef[]> {
        const type = this.normalizeResourceType(resourceType);
        const rows = await this.resources.find({
            where: { organizationId: orgId, resourceType: type, resourceId },
        });
        if (rows.length === 0) {
            return [];
        }
        const teamRows = await this.teams.find({
            where: { id: In(rows.map((r) => r.teamId)), organizationId: orgId },
            order: { name: 'ASC' },
        });
        return teamRows.map((t) => ({ teamId: t.id, name: t.name, slug: t.slug }));
    }

    // ── Validation helpers ──

    private async getTeamOrThrow(orgId: string, teamId: string): Promise<Team> {
        const team = await this.teams.findOne({ where: { id: teamId, organizationId: orgId } });
        if (!team) {
            throw new NotFoundException(`Team ${teamId} not found`);
        }
        return team;
    }

    /**
     * The referenced resource must belong to the same Tenant as the org, and
     * (when it is org-stamped) the same Organization. Mirrors
     * `TeamsService.assertAgentInOrg`: a resource with no `tenantId` cannot be
     * proven to belong here, so it is rejected (pre-backfill rows are
     * practically unreachable — the backfill runs on first-Org creation).
     */
    private async assertResourceInOrg(
        org: Organization,
        resourceType: TeamResourceType,
        resourceId: string,
    ): Promise<ScopedResourceRow> {
        const repo = this.repoFor(resourceType);
        const row = (await repo.findOne({ where: { id: resourceId } })) as ScopedResourceRow | null;
        const notFound = new NotFoundException(`Resource ${resourceId} not found`);
        // Exactly the TeamsService.assertAgentInOrg posture: the resource's
        // tenant must match the org's, an org-stamped resource must match this
        // org, and a resource with no tenant cannot be proven to belong here.
        if (!row) {
            throw notFound;
        }
        if (row.tenantId && row.tenantId !== org.tenantId) {
            throw notFound;
        }
        if (row.organizationId && row.organizationId !== org.id) {
            throw notFound;
        }
        if (!row.tenantId) {
            throw notFound;
        }
        return row;
    }

    private normalizeResourceType(value: string): TeamResourceType {
        if (!this.isKnownType(value)) {
            throw new BadRequestException(
                `resourceType must be one of: ${TEAM_RESOURCE_TYPES.join(', ')}`,
            );
        }
        return value;
    }

    private isKnownType(value: string): value is TeamResourceType {
        return (TEAM_RESOURCE_TYPES as readonly string[]).includes(value);
    }

    private repoFor(resourceType: TeamResourceType): Repository<ScopedResourceRow> {
        switch (resourceType) {
            case 'work':
                return this.works as unknown as Repository<ScopedResourceRow>;
            case 'agent':
                return this.agents as unknown as Repository<ScopedResourceRow>;
            case 'mission':
                return this.missions as unknown as Repository<ScopedResourceRow>;
            case 'idea':
                return this.ideas as unknown as Repository<ScopedResourceRow>;
            case 'task':
                return this.tasks as unknown as Repository<ScopedResourceRow>;
            case 'goal':
                if (!this.goals) {
                    throw new NotFoundException('Goals cannot be attached in this context');
                }
                return this.goals as unknown as Repository<ScopedResourceRow>;
        }
    }

    // ── Display resolution ──

    private async resolveRefsForRows(
        rows: TeamResource[],
    ): Promise<Map<TeamResourceType, Map<string, { name: string | null; slug: string | null }>>> {
        const idsByType = new Map<TeamResourceType, string[]>();
        for (const row of rows) {
            if (!this.isKnownType(row.resourceType)) continue;
            const list = idsByType.get(row.resourceType) ?? [];
            list.push(row.resourceId);
            idsByType.set(row.resourceType, list);
        }

        const out = new Map<
            TeamResourceType,
            Map<string, { name: string | null; slug: string | null }>
        >();
        for (const [type, ids] of idsByType) {
            const repo = this.repoFor(type);
            const found = await repo.find({ where: { id: In(ids) } });
            const byId = new Map<string, { name: string | null; slug: string | null }>();
            for (const entity of found) {
                byId.set((entity as ScopedResourceRow).id, this.resolveRef(type, entity));
            }
            out.set(type, byId);
        }
        return out;
    }

    /** Per-type identity mapping (works/agents expose name+slug; missions/ideas/
     *  tasks expose a title, and only some carry a slug). */
    private resolveRef(
        resourceType: TeamResourceType,
        entity: unknown,
    ): { name: string | null; slug: string | null } {
        const e = entity as Record<string, unknown>;
        const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
        switch (resourceType) {
            case 'work':
            case 'agent':
                return { name: str(e.name), slug: str(e.slug) };
            case 'task':
                return { name: str(e.title), slug: str(e.slug) };
            case 'mission':
            case 'goal':
                return { name: str(e.title), slug: null };
            case 'idea':
                return { name: str(e.title), slug: str(e.slugSuggestion) };
        }
    }

    private toItem(
        row: TeamResource,
        ref: { name: string | null; slug: string | null },
    ): TeamResourceItem {
        return {
            id: row.id,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            name: ref.name,
            slug: ref.slug,
            addedById: row.addedById ?? null,
            createdAt: row.createdAt,
        };
    }

    /** Postgres 23505 / sqlite SQLITE_CONSTRAINT unique-violation detection. */
    private isUniqueViolation(error: unknown): boolean {
        const e = error as { code?: string; message?: string };
        return (
            e?.code === '23505' ||
            (typeof e?.message === 'string' && e.message.includes('UNIQUE constraint failed'))
        );
    }
}
