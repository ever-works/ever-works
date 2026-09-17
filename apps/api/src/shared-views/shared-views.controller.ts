import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    SHARED_VIEW_LIMITS,
    type PublishedBoardDto,
    type SharedViewKnowledgeClassCountDto,
    type SharedViewSettingsDto,
} from '@ever-works/contracts/api';
import { KbDocumentClass } from '@ever-works/agent/entities';
import {
    SharedView,
    SharedViewConflictError,
    SharedViewInvalidSettingsError,
    SharedViewMissingError,
    SharedViewProjectionService,
    SharedViewService,
    sharedViewDefaults,
    type SharedViewActor,
} from '@ever-works/agent/shared-views';
import { AuthSessionGuard, CurrentUser } from '../auth';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import { OrganizationOwnershipGuard } from '../organizations/guards/organization-ownership.guard';
import { RegenerateSharedViewDto, UpdateSharedViewDto } from './dto/shared-view.dto';
import {
    SHARED_VIEW_ACTOR_KEY,
    SharedViewOwnerGuard,
    SharedViewOwnerResolver,
} from './shared-view-owner.guard';

const MINUTE_MS = 60_000;

type OwnerRequest = { [SHARED_VIEW_ACTOR_KEY]?: SharedViewActor };

/** Regenerate is limited per Workspace, not per person. */
const workspaceTracker = (request: { params?: Record<string, string> }): string =>
    `org:${request.params?.orgId ?? 'unknown'}`;

/**
 * Shared view — Settings → Sharing for one Workspace.
 *
 * Class-level `OrganizationOwnershipGuard` admits members of the Workspace's
 * Tenant and 404s everyone else. On top of it, `SharedViewOwnerGuard` admits
 * only the Tenant owner to every write, to the preview and to the class
 * counts. A member may read the settings — whether sharing is on, what is
 * published — but never receives the link.
 *
 * Everything that is not the owner reads `404`, never `403`, matching the
 * no-existence-leak posture of every other `/api/organizations/:orgId` route.
 */
@ApiTags('Shared view')
@ApiBearerAuth('JWT-auth')
@Controller('api/organizations/:orgId/shared-view')
@UseGuards(AuthSessionGuard, OrganizationOwnershipGuard)
export class SharedViewsController {
    constructor(
        private readonly views: SharedViewService,
        private readonly projection: SharedViewProjectionService,
        private readonly owners: SharedViewOwnerResolver,
    ) {}

    @Get()
    @ApiOperation({
        summary: "Read the Workspace's sharing settings",
        description:
            'Every member may read the settings and counters; only the Tenant owner receives the link.',
    })
    @ApiResponse({ status: 200, description: 'Sharing settings' })
    async get(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<SharedViewSettingsDto> {
        const owner = await this.owners.resolve(orgId);
        if (!owner) {
            throw new NotFoundException('Shared view not found');
        }
        const view = await this.views.getForOrganization(orgId);
        return this.toSettings(view, owner.ownerUserId === user.userId);
    }

    @Post()
    @UseGuards(SharedViewOwnerGuard)
    @Throttle({ long: { limit: SHARED_VIEW_LIMITS.regeneratePerMinute, ttl: MINUTE_MS } })
    @ApiOperation({
        summary: 'Turn sharing on',
        description:
            'Creates the Shared view the first time (201) with the board on, knowledge off and crawlers blocked; turning it on again re-uses the same link (200).',
    })
    @ApiResponse({ status: 201, description: 'Shared view created' })
    @ApiResponse({ status: 200, description: 'Shared view was already there; now on' })
    async enable(
        @Req() request: OwnerRequest,
        @Res({ passthrough: true }) response: { status(code: number): unknown },
    ): Promise<SharedViewSettingsDto> {
        const { view, created } = await this.views.enable(this.actor(request));
        response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
        return this.toSettings(view, true);
    }

    @Post('regenerate')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SharedViewOwnerGuard)
    @Throttle({
        long: {
            limit: SHARED_VIEW_LIMITS.regeneratePerMinute,
            ttl: MINUTE_MS,
            getTracker: workspaceTracker,
        },
    })
    @ApiOperation({
        summary: 'Regenerate the share link',
        description:
            'The previous link, and every view session minted under it, stops working on its next request. 409 when another tab regenerated first.',
    })
    @ApiResponse({ status: 200, description: 'Link regenerated' })
    @ApiResponse({ status: 409, description: 'The page is out of date; re-read and retry' })
    async regenerate(
        @Req() request: OwnerRequest,
        @Body() body: RegenerateSharedViewDto,
    ): Promise<SharedViewSettingsDto> {
        try {
            const view = await this.views.regenerate(
                this.actor(request),
                body?.expectedRotationCount,
            );
            return this.toSettings(view, true);
        } catch (error) {
            throw this.mapError(error);
        }
    }

    @Patch()
    @UseGuards(SharedViewOwnerGuard)
    @Throttle({ long: { limit: 30, ttl: MINUTE_MS } })
    @ApiOperation({
        summary: 'Change sharing settings',
        description:
            'Turn sharing off (keeps the link) or on, change the published sections and knowledge classes, or allow / block crawlers. One activity entry per changed setting.',
    })
    @ApiResponse({ status: 200, description: 'Settings changed' })
    @ApiResponse({ status: 400, description: 'A setting that cannot be applied' })
    async update(
        @Req() request: OwnerRequest,
        @Body() body: UpdateSharedViewDto,
    ): Promise<SharedViewSettingsDto> {
        try {
            const view = await this.views.updateSettings(this.actor(request), {
                status: body.status,
                sections: body.sections,
                knowledgeClasses: body.knowledgeClasses,
                searchIndexable: body.searchIndexable,
            });
            return this.toSettings(view, true);
        } catch (error) {
            throw this.mapError(error);
        }
    }

    @Delete()
    @HttpCode(HttpStatus.NO_CONTENT)
    @UseGuards(SharedViewOwnerGuard)
    @Throttle({ long: { limit: 30, ttl: MINUTE_MS } })
    @ApiOperation({
        summary: 'Delete the Shared view',
        description:
            'Deletes the view and its link. Distinct from turning sharing off, which keeps the link.',
    })
    @ApiResponse({ status: 204, description: 'Shared view deleted' })
    async remove(@Req() request: OwnerRequest): Promise<void> {
        try {
            await this.views.deleteForOrganization(this.actor(request));
        } catch (error) {
            throw this.mapError(error);
        }
    }

    @Get('preview')
    @UseGuards(SharedViewOwnerGuard)
    @ApiOperation({
        summary: 'Preview the published board as a visitor sees it',
        description:
            'Runs the exact public projection under the owner session, whether or not sharing is on. Never counts as a view.',
    })
    @ApiResponse({ status: 200, description: 'Published board' })
    async preview(@Req() request: OwnerRequest): Promise<PublishedBoardDto> {
        const actor = this.actor(request);
        const view =
            (await this.views.getForOrganization(actor.organizationId)) ?? this.previewView(actor);
        return this.projection.projectBoard(view);
    }

    @Get('knowledge-classes')
    @UseGuards(SharedViewOwnerGuard)
    @ApiOperation({
        summary: 'Publishable document counts per knowledge class',
        description: 'Zero for every class until the knowledge section ships.',
    })
    @ApiResponse({ status: 200, description: 'Per-class counts' })
    knowledgeClasses(): SharedViewKnowledgeClassCountDto[] {
        return Object.values(KbDocumentClass).map((documentClass) => ({ documentClass, count: 0 }));
    }

    private actor(request: OwnerRequest): SharedViewActor {
        const actor = request[SHARED_VIEW_ACTOR_KEY];
        if (!actor) {
            // Unreachable behind SharedViewOwnerGuard; fail closed regardless.
            throw new NotFoundException('Shared view not found');
        }
        return actor;
    }

    /** The view a Workspace that never turned sharing on would publish, for the preview only. */
    private previewView(actor: SharedViewActor): SharedView {
        return Object.assign(new SharedView(), {
            id: 'preview',
            organizationId: actor.organizationId,
            tenantId: actor.tenantId,
            ownerUserId: actor.ownerUserId,
            ...sharedViewDefaults(),
        });
    }

    private mapError(error: unknown): unknown {
        if (error instanceof SharedViewConflictError) {
            return new ConflictException('shared_view_out_of_date');
        }
        if (error instanceof SharedViewMissingError) {
            return new NotFoundException('Shared view not found');
        }
        if (error instanceof SharedViewInvalidSettingsError) {
            return new BadRequestException(error.reason);
        }
        return error;
    }

    private toSettings(view: SharedView | null, isOwner: boolean): SharedViewSettingsDto {
        if (!view) {
            const defaults = sharedViewDefaults();
            return {
                exists: false,
                canManage: isOwner,
                status: null,
                sections: defaults.sections,
                knowledgeClasses: defaults.knowledgeClasses,
                searchIndexable: defaults.searchIndexable,
                viewCount: 0,
                lastViewedAt: null,
                tokenRotatedAt: null,
                rotationCount: 0,
                createdAt: null,
                link: null,
                linkUnreadable: false,
            };
        }
        const token = isOwner ? this.views.readToken(view) : null;
        return {
            exists: true,
            canManage: isOwner,
            status: view.status,
            sections: { board: view.sections.board, knowledge: view.sections.knowledge },
            knowledgeClasses: [...(view.knowledgeClasses ?? [])],
            searchIndexable: view.searchIndexable === true,
            viewCount: view.viewCount ?? 0,
            lastViewedAt: toIso(view.lastViewedAt),
            tokenRotatedAt: toIso(view.tokenRotatedAt),
            rotationCount: view.rotationCount ?? 0,
            createdAt: toIso(view.createdAt),
            link: token ? { token } : null,
            linkUnreadable: isOwner && token === null,
        };
    }
}

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
