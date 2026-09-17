import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    MaxLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import {
    CONVERSATION_CLIENT_MESSAGE_ID_MAX,
    CONVERSATION_NAME_MAX,
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_CONVERSATION_BODY_BYTES,
} from '@ever-works/contracts';

/**
 * Named Conversations — request bodies for the routes added beside the
 * existing conversation endpoints. Every string carries an explicit length
 * cap, matching the posture of the DTOs in `conversation.controller.ts`.
 */

/**
 * `PUT /api/conversations/:id/name`.
 *
 * `name` is REQUIRED and may be `null`: a string sets the name (and stops
 * automatic titling for good), `null` clears it. An absent `name` is a 400 —
 * an empty body must never silently clear a name someone chose.
 *
 * A separate route rather than `PATCH { title: null }`: that route pins
 * `title: null` as a 400 so a client echoing a blanked form field can never
 * wipe a title by accident, and that guarantee stays exactly as it is.
 */
export class ConversationNameDto {
    @ApiProperty({ nullable: true, maxLength: CONVERSATION_NAME_MAX, type: String })
    @ValidateIf((o: ConversationNameDto) => o.name !== null)
    @IsString()
    @MaxLength(CONVERSATION_NAME_MAX)
    name: string | null;
}

export class ConversationAttachmentRefDto {
    @ApiProperty({ maxLength: 64 })
    @IsString()
    @MaxLength(64)
    uploadId: string;
}

/**
 * `POST /api/conversations/:id/messages/send` — a person's message to the
 * Agents of a Conversation.
 *
 * The body's exact 16 KB cap is measured in UTF-8 bytes by the service, which
 * answers with a `failureCode` the composer can explain. The character cap
 * here is only a coarse request-size guard above it.
 */
export class SendConversationMessageDto {
    @ApiProperty({ maxLength: MAX_CONVERSATION_BODY_BYTES * 4 })
    @IsString()
    @MaxLength(MAX_CONVERSATION_BODY_BYTES * 4)
    body: string;

    /** Client-generated; the same id twice returns the first message. */
    @ApiProperty({ required: false, maxLength: CONVERSATION_CLIENT_MESSAGE_ID_MAX })
    @IsOptional()
    @IsString()
    @MaxLength(CONVERSATION_CLIENT_MESSAGE_ID_MAX)
    @Matches(/^[A-Za-z0-9_:.-]+$/, {
        message: 'clientMessageId may contain letters, digits, "_", ":", "." and "-" only',
    })
    clientMessageId?: string;

    @ApiProperty({ required: false, type: [ConversationAttachmentRefDto] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_ATTACHMENTS_PER_MESSAGE)
    @ValidateNested({ each: true })
    @Type(() => ConversationAttachmentRefDto)
    attachments?: ConversationAttachmentRefDto[];

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    model?: string;
}

/** `POST /api/conversations/:id/read`. */
export class MarkConversationReadDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    lastReadMessageId: string;
}
