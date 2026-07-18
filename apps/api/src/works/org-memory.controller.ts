import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { KnowledgeBaseService } from '@ever-works/agent/services';
import type {
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
} from '@ever-works/agent/entities';
import {
    KB_DOCUMENT_CLASSES,
    KB_DOCUMENT_SOURCES,
    KB_DOCUMENT_STATUSES,
} from '@ever-works/contracts';
import { OrganizationMembershipService } from '../organizations/organization-membership.service';
import { ScopeContextService } from '../scope';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';

/**
 * Normalize a query-string facet param to `string[]`.
 *
 * Accepts the three shapes Nest/Express hand us for a repeatable query
 * key: an array (`?type=a&type=b`), a comma-joined string (`?type=a,b`),
 * or a single string (`?type=a`). Empty segments are dropped. Anything
 * else (object, number) collapses to `[]`.
 */
function toStringArray(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : [value];
    return raw
        .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
}

/**
 * Query params for `GET /api/memory` (Org-wide Memory, Cortex P1).
 *
 * The active Organization is resolved from the request SCOPE CONTEXT,
 * never from a query/body param — so there is deliberately no `orgId`
 * here. Facet params are multi-value (repeatable or comma-joined).
 */
export class MemoryQueryDto {
    @IsOptional()
    @IsString()
    @MaxLength(200)
    q?: string;

    @IsOptional()
    @Transform(({ value }) => toStringArray(value))
    @IsIn(KB_DOCUMENT_CLASSES as unknown as readonly string[], { each: true })
    type?: KbDocumentClass[];

    @IsOptional()
    @Transform(({ value }) => toStringArray(value))
    @IsString({ each: true })
    @MaxLength(64, { each: true })
    work?: string[];

    @IsOptional()
    @Transform(({ value }) => toStringArray(value))
    @IsIn(KB_DOCUMENT_STATUSES as unknown as readonly string[], { each: true })
    status?: KbDocumentStatus[];

    @IsOptional()
    @Transform(({ value }) => toStringArray(value))
    @IsIn(KB_DOCUMENT_SOURCES as unknown as readonly string[], { each: true })
    source?: KbDocumentSource[];

    @IsOptional()
    @IsInt()
    @Min(1)
    @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
    limit?: number;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
    offset?: number;
}

/**
 * Org-wide Memory (Cortex P1) — the aggregation surface over the
 * per-Work Knowledge Base, fanned in across the active Organization.
 *
 * This is a NEW read-mostly surface that sits ABOVE the existing per-Work
 * KB workbench; it removes/renames nothing. It reuses the existing
 * `KnowledgeBaseService` + `WorkKnowledgeDocument` tables read-only — no
 * new embedding or storage logic.
 *
 * **Org resolution + security.** Unlike the per-Work KB routes, Memory
 * is session-scoped: the Organization comes from the request SCOPE
 * CONTEXT (`ScopeContextService.getOrganizationId()`), which the
 * `SessionScopeGuard` seeds from the authenticated user's validated
 * last-active Org on these legacy un-prefixed routes — never from a
 * query/body param. When no Organization is resolvable (bare-Tenant
 * "personal" surface, or an un-upgraded user) the endpoint returns an
 * EMPTY aggregation — there is no unscoped or cross-tenant scan (spec
 * §2.1 / §7). As defense-in-depth we also assert org membership via the
 * shared `OrganizationMembershipService` (mirrors `OrgKbController`).
 */
@ApiTags('Memory (Organization)')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(AuthSessionGuard)
export class OrgMemoryController {
    constructor(
        private readonly kb: KnowledgeBaseService,
        private readonly membership: OrganizationMembershipService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get('memory')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Org-wide Memory — faceted aggregation of KB documents',
        description:
            'Aggregates every Knowledge Base document across all Works in the active Organization (∪ the org-level documents), faceted by Type / Work / Source / Status and lexically searchable. The Organization is taken from the request scope context, not a param.',
    })
    @ApiQuery({
        name: 'q',
        required: false,
        description: 'Lexical search over title + description',
    })
    @ApiQuery({
        name: 'type',
        required: false,
        isArray: true,
        description: 'KB document class filter',
    })
    @ApiQuery({ name: 'work', required: false, isArray: true, description: 'Work id filter' })
    @ApiQuery({ name: 'status', required: false, isArray: true })
    @ApiQuery({ name: 'source', required: false, isArray: true })
    @ApiResponse({ status: 200, description: 'Aggregated Memory feed + counts + facets' })
    async getMemory(@CurrentUser() auth: AuthenticatedUser, @Query() query: MemoryQueryDto) {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            // No active Organization ⇒ empty aggregation. Never a
            // cross-tenant scan — Memory is org-bounded by construction.
            return {
                documents: [],
                counts: { documents: 0 },
                facets: { types: [], works: [], statuses: [], sources: [] },
            };
        }

        // Defense-in-depth: the caller must belong to the Tenant that owns
        // the active org. The scope was seeded from the user's own
        // validated last-active Org, so this is normally a formality — but
        // it keeps the authorization explicit and consistent with the
        // sibling org-KB routes. Throws NotFound (not Forbidden) on a
        // cross-tenant mismatch, matching the existence-leak contract.
        await this.membership.ensureMember(organizationId, auth.userId);

        return this.kb.aggregateOrgMemory(organizationId, {
            classes: query.type,
            statuses: query.status,
            sources: query.source,
            workIds: query.work,
            q: query.q,
            limit: query.limit,
            offset: query.offset,
        });
    }
}
