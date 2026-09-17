import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConversationService } from '@ever-works/agent/conversations';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { AuthenticatedUser } from '../auth/types/auth.types';
import { ScopeContextService } from '../scope/scope-context.service';

/**
 * Who takes part in a Conversation — the header's Agent and the people in it.
 *
 * Read-only in this release. A caller who may not read the Conversation gets
 * `404`, indistinguishable from a Conversation that does not exist (FR-95).
 */
@ApiTags('Conversations')
@ApiBearerAuth('JWT-auth')
@Controller('api/conversations')
export class ConversationParticipantsController {
    constructor(
        private readonly conversations: ConversationService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get(':id/participants')
    @ApiOperation({ summary: 'List the participants of a conversation' })
    async list(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        const participants = await this.conversations.listParticipants(
            id,
            auth.userId,
            this.scopeContext.getScope(),
        );
        return {
            participants: participants.map((participant) => ({
                participantType: participant.participantType,
                participantId: participant.participantId,
                role: participant.role,
                joinedAt: participant.joinedAt,
                leftAt: participant.leftAt ?? null,
                lastReadMessageId: participant.lastReadMessageId ?? null,
                lastReadAt: participant.lastReadAt ?? null,
            })),
        };
    }
}
