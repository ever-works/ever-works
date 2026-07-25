import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Meeting, MeetingSource } from '@ever-works/agent/meetings';
import { MeetingsService } from '@ever-works/agent/meetings';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreateMeetingDto, IngestTranscriptDto, UpdateMeetingDto } from './dto/meeting.dto';

/** Wire shape of one meeting (list rows omit the transcript body). */
export interface MeetingView {
    id: string;
    title: string;
    startedAt: string;
    endedAt: string | null;
    source: string;
    externalId: string | null;
    workId: string | null;
    organizationId: string | null;
    participants: { name: string; email?: string }[];
    sourceUrl: string | null;
    summary: string | null;
    hasTranscript: boolean;
    transcriptText?: string | null;
    createdAt: string;
}

const MEETING_SOURCES: readonly string[] = ['zoom', 'google-meet', 'manual', 'import'];

/**
 * Meetings v1 (Wave 8, feature a) — thin owner-scoped CRUD +
 * transcript capture over the agent-side `MeetingsService`.
 *
 * Endpoints:
 *   GET    /api/meetings                 list mine (workId/source filters)
 *   POST   /api/meetings                 create (manual/import)
 *   GET    /api/meetings/:id             get one (incl. transcript body)
 *   PATCH  /api/meetings/:id             partial update
 *   DELETE /api/meetings/:id             delete
 *   POST   /api/meetings/:id/transcript  attach transcript (size-capped;
 *                                        runs summary + memory + envelope)
 *
 * Provider-synced meetings (zoom-connector recordings) land through the
 * ingest-spine processor, not this surface. Transcript ingest is
 * throttled harder — it fans out to an LLM summary.
 */
@ApiTags('meetings')
@Controller('api/meetings')
export class MeetingsController {
    constructor(private readonly service: MeetingsService) {}

    @Get()
    @ApiOperation({ summary: 'List my meetings (org-wide, or filtered to one Work), newest first' })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('workId') workId?: string,
        @Query('source') source?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ): Promise<MeetingView[]> {
        const meetings = await this.service.listForUser(auth.userId, {
            ...(workId ? { workId } : {}),
            ...(source && MEETING_SOURCES.includes(source)
                ? { source: source as MeetingSource }
                : {}),
            ...(limit ? { limit: Number(limit) || undefined } : {}),
            ...(offset ? { offset: Number(offset) || undefined } : {}),
        });
        return meetings.map((meeting) => this.toView(meeting));
    }

    @Post()
    @ApiOperation({ summary: 'Create a meeting (manual/import; connectors sync their own)' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: CreateMeetingDto,
    ): Promise<MeetingView> {
        const meeting = await this.service.createForUser(auth.userId, body);
        return this.toView(meeting, { includeTranscript: true });
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one meeting (includes the transcript body)' })
    @HttpCode(HttpStatus.OK)
    async getOne(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<MeetingView> {
        const meeting = await this.service.getForUser(auth.userId, id);
        return this.toView(meeting, { includeTranscript: true });
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update meeting fields (partial)' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateMeetingDto,
    ): Promise<MeetingView> {
        const meeting = await this.service.updateForUser(auth.userId, id, body);
        return this.toView(meeting, { includeTranscript: true });
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a meeting' })
    @HttpCode(HttpStatus.NO_CONTENT)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
        await this.service.deleteForUser(auth.userId, id);
    }

    @Post(':id/transcript')
    @ApiOperation({
        summary:
            'Attach a transcript (size-capped). Stores it, then best-effort: AI summary, Memory observation, meeting.transcript envelope (→ Activity with sourceUrl).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async ingestTranscript(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: IngestTranscriptDto,
    ): Promise<{
        meeting: MeetingView;
        summary?: string;
        memorySaved: boolean;
        envelopeEmitted: boolean;
    }> {
        const result = await this.service.ingestTranscriptForUser(
            auth.userId,
            id,
            body.transcriptText,
        );
        return {
            meeting: this.toView(result.meeting, { includeTranscript: true }),
            ...(result.summary ? { summary: result.summary } : {}),
            memorySaved: result.memorySaved,
            envelopeEmitted: result.envelopeEmitted,
        };
    }

    /** Entity → wire view. `dedupeKey` never leaves the API. */
    private toView(meeting: Meeting, opts: { includeTranscript?: boolean } = {}): MeetingView {
        return {
            id: meeting.id,
            title: meeting.title,
            startedAt: meeting.startedAt.toISOString(),
            endedAt: meeting.endedAt ? meeting.endedAt.toISOString() : null,
            source: meeting.source,
            externalId: meeting.externalId ?? null,
            workId: meeting.workId ?? null,
            organizationId: meeting.organizationId ?? null,
            participants: meeting.participants ?? [],
            sourceUrl: meeting.sourceUrl ?? null,
            summary: meeting.summary ?? null,
            hasTranscript: !!meeting.transcriptText,
            ...(opts.includeTranscript ? { transcriptText: meeting.transcriptText ?? null } : {}),
            createdAt: meeting.createdAt.toISOString(),
        };
    }
}
