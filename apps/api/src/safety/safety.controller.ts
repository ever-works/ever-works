import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Put,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    ACTION_CATEGORIES,
    ACTION_CATEGORY_CEILING,
    ACTION_CATEGORY_DEFAULT,
    ACTION_CATEGORY_I18N_KEY,
    READINESS_WINDOW_DAYS,
    SAFETY_RUNG_WRITES_PER_MINUTE,
    isDraftableCategory,
    isLadderedCategory,
    type RailRefusalDto,
    type RailRefusalListDto,
    type ReadinessDto,
    type ResolvedLadder,
    type SafetyCategoryListDto,
    type SafetyOverviewDto,
} from '@ever-works/contracts';
import {
    AutonomyGrantService,
    RailRefusalService,
    SafetyGateService,
    SafetyReadinessService,
    WorkspacePauseService,
} from '@ever-works/agent/safety';
import { TenantRepository } from '@ever-works/agent/database';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope/scope-context.service';
import { HumanOnly } from './decorators/human-only.decorator';
import { HumanActorGuard } from './guards/human-actor.guard';
import {
    ExpandRefusalGroupQueryDto,
    LadderQueryDto,
    ListRefusalsQueryDto,
    PutLadderDto,
} from './dto/safety.dto';

/**
 * Safety rails and the trust ladder (AW-24) — the customer-facing surface.
 *
 *   GET    /api/safety/categories
 *   GET    /api/safety/overview
 *   GET    /api/safety/ladder?agentId=
 *   PUT    /api/safety/ladder
 *   DELETE /api/safety/ladder/:id
 *   GET    /api/safety/readiness?agentId=
 *   GET    /api/safety/refusals?railId=&category=&agentId=&from=&to=&cursor=
 *   GET    /api/safety/refusals/:collapseKey
 *
 * ## Who may read, and who may write
 *
 * Every member of the workspace may READ all of it: the ladder, the
 * readiness record and the refusal log are how a team understands why
 * something did not happen, and hiding them would leave "the work just did
 * not get done" as the only available explanation.
 *
 * Only the workspace OWNER may write (FR-39, FR-77), and only a PERSON in an
 * interactive session (FR-31) — `@HumanOnly()` plus the owner check. The two
 * are independent: an owner using an API key is refused, and a signed-in
 * teammate who is not the owner is refused.
 *
 * ## Scope and the no-existence-leak rule
 *
 * The workspace is the resolved scope (`ScopeContextService`), which the
 * global `SessionScopeGuard` / `ScopeOwnershipGuard` pair has already
 * authorised against the caller's own tenant — so this controller never
 * re-declares those guards (registering them again would run them twice).
 * A foreign identifier reads as **404, never 403**, matching every
 * controller in this area: a 403 confirms the row exists.
 */
@ApiTags('safety')
@ApiBearerAuth('JWT-auth')
@Controller('api/safety')
@UseGuards(HumanActorGuard)
export class SafetyController {
    constructor(
        private readonly grants: AutonomyGrantService,
        private readonly refusals: RailRefusalService,
        private readonly pauses: WorkspacePauseService,
        private readonly readiness: SafetyReadinessService,
        private readonly gate: SafetyGateService,
        private readonly scope: ScopeContextService,
        private readonly tenants: TenantRepository,
    ) {}

    @Get('categories')
    @ApiOperation({
        summary:
            'The closed list of the thirteen kinds of work an agent can do, each with its ceiling, its shipped default and whether the ladder offers Draft for it. Read-only — the list is a spec change, not a setting.',
    })
    @HttpCode(HttpStatus.OK)
    categories(): SafetyCategoryListDto {
        return {
            categories: ACTION_CATEGORIES.map((id) => ({
                id,
                laddered: isLadderedCategory(id),
                ceiling: isLadderedCategory(id) ? ACTION_CATEGORY_CEILING[id] : null,
                defaultRung: isLadderedCategory(id) ? ACTION_CATEGORY_DEFAULT[id] : null,
                draftable: isDraftableCategory(id),
                i18nKey: ACTION_CATEGORY_I18N_KEY[id],
            })),
        };
    }

    @Get('overview')
    @ApiOperation({
        summary:
            'One read for the Safety screen: the pause state, the trust ladder and the refusal counts. Each panel is read independently and carries its own error flag — a failed panel never blanks the page.',
    })
    @HttpCode(HttpStatus.OK)
    async overview(@CurrentUser() auth: AuthenticatedUser): Promise<SafetyOverviewDto> {
        const workspaceScopeId = this.workspaceScopeId(auth);
        // Settled, not all-or-nothing (FR-73): the one screen about safety
        // must not go blank because one of its three reads failed.
        const [pause, ladder, counts] = await Promise.allSettled([
            this.pauses.state(this.workspaceRef(auth)),
            this.grants.resolve(auth.userId, { workspaceScopeId }),
            this.refusals.counts(auth.userId, READINESS_WINDOW_DAYS),
        ]);

        const resolvedLadder = ladder.status === 'fulfilled' ? ladder.value : null;
        return {
            pause: {
                data: pause.status === 'fulfilled' ? pause.value : null,
                error: pause.status === 'rejected',
            },
            ladder: { data: resolvedLadder, error: ladder.status === 'rejected' },
            refusalCounts: {
                data: counts.status === 'fulfilled' ? counts.value : null,
                error: counts.status === 'rejected',
            },
            // Safe mode is reported when either half says so, OR when the
            // ladder could not be read at all — an unknown ladder is treated
            // as safe mode rather than as a running workspace.
            safeMode:
                ladder.status === 'rejected' ||
                resolvedLadder?.safeMode === true ||
                (pause.status === 'fulfilled' && pause.value.unverified),
            canEdit: await this.isWorkspaceOwner(auth),
        };
    }

    @Get('ladder')
    @ApiOperation({
        summary:
            'The rungs in force, resolved platform default → workspace → agent with a narrow-only merge, with the scope that decided each one.',
    })
    @HttpCode(HttpStatus.OK)
    async ladder(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: LadderQueryDto,
    ): Promise<ResolvedLadder> {
        return this.grants.resolve(auth.userId, {
            workspaceScopeId: this.workspaceScopeId(auth),
            agentId: query.agentId ?? null,
        });
    }

    @Put('ladder')
    @HumanOnly()
    @Throttle({ long: { limit: SAFETY_RUNG_WRITES_PER_MINUTE, ttl: 60_000 } })
    @ApiOperation({
        summary:
            'Move one kind of work to one rung. Promotion moves exactly one rung at a time and may never pass the category ceiling; demotion is unrestricted and immediate. Only the workspace owner, and only from an interactive session — nothing graduates itself.',
    })
    @ApiResponse({ status: 400, description: 'The rung would skip a step or pass a ceiling' })
    @ApiResponse({ status: 403, description: 'Not the workspace owner, or not a person' })
    @HttpCode(HttpStatus.OK)
    async putLadder(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: PutLadderDto,
    ): Promise<ResolvedLadder> {
        await this.assertOwner(auth);
        const workspaceScopeId = this.workspaceScopeId(auth);
        const ladder = await this.grants.write(
            { userId: auth.userId, isHuman: true },
            {
                ownerUserId: auth.userId,
                workspaceScopeId,
                scopeType: body.scopeType,
                scopeId: body.scopeId,
                category: body.category,
                rung: body.rung,
                note: body.note ?? null,
                agentId: body.scopeType === 'agent' ? body.scopeId : null,
            },
        );
        // Take effect on this replica immediately; the others expire inside
        // the ten-second cache window (FR-37).
        this.gate.invalidate(auth.userId, workspaceScopeId);
        return ladder;
    }

    @Delete('ladder/:id')
    @HumanOnly()
    @Throttle({ long: { limit: SAFETY_RUNG_WRITES_PER_MINUTE, ttl: 60_000 } })
    @ApiOperation({
        summary:
            'Remove one stored rung, reverting that scope and kind of work to inherit from the scope above it.',
    })
    @ApiResponse({ status: 404, description: 'No such rung for this workspace' })
    @HttpCode(HttpStatus.OK)
    async deleteLadder(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Query() query: LadderQueryDto,
    ): Promise<ResolvedLadder> {
        await this.assertOwner(auth);
        const workspaceScopeId = this.workspaceScopeId(auth);
        const ladder = await this.grants.revert(
            { userId: auth.userId, isHuman: true },
            auth.userId,
            id,
            { workspaceScopeId, agentId: query.agentId ?? null },
        );
        this.gate.invalidate(auth.userId, workspaceScopeId);
        return ladder;
    }

    @Get('readiness')
    @ApiOperation({
        summary:
            'The 30-day record behind each category: decisions answered, approval rate, withdrawals and refusals by any other rail. Advisory only — the product never promotes anything by itself.',
    })
    @HttpCode(HttpStatus.OK)
    async readinessFor(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: LadderQueryDto,
    ): Promise<{ readiness: ReadinessDto[] }> {
        const ladder = await this.grants.resolve(auth.userId, {
            workspaceScopeId: this.workspaceScopeId(auth),
            agentId: query.agentId ?? null,
        });
        return { readiness: await this.readiness.forWorkspace(auth.userId, ladder) };
    }

    @Get('refusals')
    @ApiOperation({
        summary:
            'What the rails stopped: every refusal and hold, newest first, filterable by rail, kind of work, agent and date. A day that trips the collapse threshold is lifted out as one group with a count.',
    })
    @HttpCode(HttpStatus.OK)
    async listRefusals(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListRefusalsQueryDto,
    ): Promise<RailRefusalListDto> {
        const to = query.to ? new Date(query.to) : new Date();
        const from = query.from
            ? new Date(query.from)
            : new Date(to.getTime() - READINESS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        return this.refusals.list({
            userId: auth.userId,
            railId: query.railId ?? null,
            category: query.category ?? null,
            agentId: query.agentId ?? null,
            from,
            to,
            cursor: query.cursor ?? null,
        });
    }

    @Get('refusals/:collapseKey')
    @ApiOperation({ summary: 'The rows behind one collapsed group.' })
    @HttpCode(HttpStatus.OK)
    async expandRefusals(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('collapseKey') collapseKey: string,
        @Query() _query: ExpandRefusalGroupQueryDto,
    ): Promise<{ items: RailRefusalDto[] }> {
        return { items: await this.refusals.expand(auth.userId, collapseKey) };
    }

    /**
     * The workspace this request is about.
     *
     * The Organization when one is in scope; otherwise the tenant, which is
     * how a bare-tenant workspace addresses itself — the same fallback
     * `tool_grants` uses for its tenant scope. The caller's own id is the last
     * resort for an account not yet upgraded to a tenant, so the ladder still
     * resolves rather than throwing.
     */
    private workspaceScopeId(auth: AuthenticatedUser): string {
        return (
            this.scope.getOrganizationId() ??
            this.scope.getTenantId() ??
            auth.tenantId ??
            auth.userId
        );
    }

    private workspaceRef(
        auth: AuthenticatedUser,
    ): { tenantId: string; organizationId: string | null } | null {
        const tenantId = this.scope.getTenantId() ?? auth.tenantId ?? null;
        if (!tenantId) return null;
        return { tenantId, organizationId: this.scope.getOrganizationId() };
    }

    /**
     * Is the caller the workspace owner?
     *
     * `tenants.ownerUserId` is UNIQUE, so one read settles it. Answers
     * `false` rather than throwing when the tenant cannot be read: the
     * overview uses this to decide whether to render controls, and a screen
     * that renders read-only is a better failure than a screen that 500s.
     */
    private async isWorkspaceOwner(auth: AuthenticatedUser): Promise<boolean> {
        const tenantId = this.scope.getTenantId() ?? auth.tenantId ?? null;
        if (!tenantId) {
            // No tenant row yet: the account IS its own workspace, so its
            // owner is the account.
            return true;
        }
        try {
            const tenant = await this.tenants.findById(tenantId);
            return tenant?.ownerUserId === auth.userId;
        } catch {
            return false;
        }
    }

    /**
     * 404, never 403 (FR-79). A teammate who is not the owner must not learn
     * that the rung they tried to write exists — and the Safety screen has
     * already told them the controls are read-only.
     */
    private async assertOwner(auth: AuthenticatedUser): Promise<void> {
        if (await this.isWorkspaceOwner(auth)) return;
        throw new NotFoundException('Safety settings not found');
    }
}
