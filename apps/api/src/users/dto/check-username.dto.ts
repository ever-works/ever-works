import { IsString, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * EW-652 — query DTO for `GET /api/users/check-username`.
 *
 * Validation is intentionally loose at the controller boundary — the
 * normalization happens inside `UsernameAllocatorService.normalize`, and
 * the response surfaces what the normalized form would be so the UI
 * can display "your username will become: <normalized>" hints.
 *
 * The Length(1, 64) + Matches([\w-]+) constraints reject obvious
 * garbage (empty, control chars, multi-kilobyte payloads) without
 * pre-empting the allocator's own normalization rules.
 */
export class CheckUsernameQueryDto {
    @ApiProperty({
        description:
            'The desired username to check availability for. Will be normalized to URL-safe form server-side.',
        example: 'alice',
        minLength: 1,
        maxLength: 64,
    })
    @IsString()
    @Length(1, 64)
    @Matches(/^[\p{L}\p{N}._@'\- ]+$/u, {
        message:
            'value contains unsupported characters; allowed: letters, digits, dot, underscore, at-sign, apostrophe, hyphen, space',
    })
    value!: string;
}
