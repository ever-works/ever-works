import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Invite a human into an Organization.
 *
 * `email` is required and validated here as well as in the service. That is
 * not redundant: the DTO rejects a malformed address with a 400 and a field
 * name the form can point at, while the service guard is what protects any
 * other caller of `issue()`.
 */
export class CreateOrganizationInvitationDto {
    @ApiProperty({
        description: 'Where the invitation is sent. The issued token is bound to this address.',
        example: 'newcomer@example.com',
        maxLength: 320,
    })
    @IsEmail({}, { message: 'invalid_email' })
    // RFC 5321 caps a path at 320 octets, and the column is sized to match —
    // without this a longer address would pass validation and then fail at
    // INSERT as a 500.
    @MaxLength(320, { message: 'invalid_email' })
    email: string;

    @ApiPropertyOptional({
        description: 'Display name for the email copy only. Never used for identity.',
        maxLength: 200,
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    invitedName?: string;
}
