import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Put,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ArrayMaxSize, IsArray, IsIn, IsUUID } from 'class-validator';
import { VISIBILITY_AGGREGATES, type VisibilityAggregate } from '@ever-works/contracts';
import { ownershipScopeMatches } from '@ever-works/agent/database';
import {
    RecordAccessPolicy,
    RecordVisibilityService,
    VISIBILITY_CHOICES,
    type OrganizationTeamOption,
    type VisibilityChoice,
    type VisibilityState,
} from '@ever-works/agent/record-visibility';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope';

export class SetRecordVisibilityDto {
    @ApiProperty({
        enum: VISIBILITY_CHOICES,
        description:
            "'automatic' hands the choice back to the D11 rule (team when on a Team, else organization); 'private' | 'team' | 'organization' is a choice by hand and stops the automatic changes.",
    })
    @IsIn([...VISIBILITY_CHOICES])
    visibility!: VisibilityChoice;
}

export class SetRecordTeamsDto {
    @ApiProperty({
        type: [String],
        description:
            "The record's Teams, as one set. For a Task the first is stored as `teamId`, the rest as team_resources rows.",
    })
    @IsArray()
    @ArrayMaxSize(50)
    @IsUUID('all', { each: true })
    teamIds!: string[];
}

/** What a form needs to render the visibility control. */
export interface RecordVisibilityView extends VisibilityState {
    /** Only the owner may change visibility or Teams (spec §4). */
    canEdit: boolean;
    /** The record's Organization's Teams (owner only; for the Team picker). */
    organizationTeams?: OrganizationTeamOption[];
}

interface OwnedRow {
    id: string;
    userId: string;
    tenantId?: string | null;
    organizationId?: string | null;
}

/**
 * Record visibility (EW-P1-3, `docs/specs/features/record-visibility/spec.md` §5, §7) —
 * the visibility control on the task, goal, mission, idea and agent forms.
 *
 *   - `GET  /api/record-visibility/:aggregate/:id`        — anyone who may read the record.
 *   - `PUT  /api/record-visibility/:aggregate/:id`        — the owner: by hand or `automatic`.
 *   - `PUT  /api/record-visibility/:aggregate/:id/teams`  — the owner: the record's Teams
 *     (the goal form's Teams; any aggregate).
 *
 * 404 (never 403) for a record the caller may not read, so existence never leaks.
 * An integration principal may set `team` / `organization` only (`422 domain_rule`).
 */
@ApiTags('record-visibility')
@Controller('api/record-visibility')
export class RecordVisibilityController {
    constructor(
        private readonly policy: RecordAccessPolicy,
        private readonly visibility: RecordVisibilityService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get(':aggregate/:id')
    @ApiOperation({ summary: "A record's visibility, explicit flag and Teams" })
    @HttpCode(HttpStatus.OK)
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('aggregate') aggregate: string,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<RecordVisibilityView> {
        const type = this.parseAggregate(aggregate);
        const owned = await this.findOwned(type, id, auth.userId);
        if (!owned) {
            const readable = await this.policy.findVisibleNotOwned({
                aggregate: type,
                userId: auth.userId,
                id,
                scope: this.scopeContext.getScope(),
            });
            if (!readable) throw new NotFoundException('Record not found');
        }
        const state = await this.visibility.getState(type, id);
        if (!state) throw new NotFoundException('Record not found');
        if (!owned) return { ...state, canEdit: false };
        return {
            ...state,
            canEdit: true,
            organizationTeams: await this.visibility.organizationTeamsOf(type, id),
        };
    }

    @Put(':aggregate/:id')
    @ApiOperation({ summary: "Set a record's visibility by hand, or back to automatic (owner)" })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async set(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('aggregate') aggregate: string,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: SetRecordVisibilityDto,
    ): Promise<RecordVisibilityView> {
        const type = this.parseAggregate(aggregate);
        if (this.isIntegration(auth)) {
            RecordVisibilityService.assertIntegrationVisibility(body.visibility);
        }
        if (!(await this.findOwned(type, id, auth.userId))) {
            throw new NotFoundException('Record not found');
        }
        const state = await this.visibility.setVisibility(type, id, body.visibility);
        if (!state) throw new NotFoundException('Record not found');
        return { ...state, canEdit: true };
    }

    @Put(':aggregate/:id/teams')
    @ApiOperation({ summary: "Replace a record's Teams (owner); D11 then re-applies" })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async setTeams(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('aggregate') aggregate: string,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: SetRecordTeamsDto,
    ): Promise<RecordVisibilityView> {
        const type = this.parseAggregate(aggregate);
        if (!(await this.findOwned(type, id, auth.userId))) {
            throw new NotFoundException('Record not found');
        }
        const state = await this.visibility.setTeams(type, id, body.teamIds, auth.userId);
        if (!state) throw new NotFoundException('Record not found');
        return { ...state, canEdit: true };
    }

    private parseAggregate(value: string): VisibilityAggregate {
        if (!(VISIBILITY_AGGREGATES as readonly string[]).includes(value)) {
            throw new BadRequestException(
                `aggregate must be one of: ${VISIBILITY_AGGREGATES.join(', ')}`,
            );
        }
        return value as VisibilityAggregate;
    }

    /** The record when the caller owns it in the active scope; `null` otherwise. */
    private async findOwned(
        aggregate: VisibilityAggregate,
        id: string,
        userId: string,
    ): Promise<OwnedRow | null> {
        const row = (await this.policy
            .repositoryFor(aggregate)
            .findOne({ where: { id } })) as OwnedRow | null;
        if (!row || row.userId !== userId) return null;
        return ownershipScopeMatches(row, this.scopeContext.getScope()) ? row : null;
    }

    /** `authMethod='integration'` (EW-P1-2) — compared as a string until that lands. */
    private isIntegration(auth: AuthenticatedUser): boolean {
        return (auth as { authMethod?: string }).authMethod === 'integration';
    }
}
