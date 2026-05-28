import { IsString, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * EW-658 — query DTO for `GET /api/organizations/check-slug`. Same
 * shape as `CheckUsernameQueryDto` because the underlying allocator
 * is shared.
 */
export class CheckSlugQueryDto {
    @ApiProperty({
        description:
            'The desired slug to check availability for. Will be normalized to URL-safe form server-side.',
        example: 'acme',
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
