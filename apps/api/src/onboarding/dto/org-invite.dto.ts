import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * Redeem an organization invitation.
 *
 * The token is `randomBytes(32).toString('hex')`, so its length is fixed at
 * 64. Pinning it here rejects a truncated or padded value before it reaches a
 * database lookup, which keeps the public surface from being usable as an
 * oracle for how long a valid token is.
 */
export class AcceptOrgInviteDto {
    @ApiProperty({
        description: 'The raw invitation token from the email link.',
        minLength: 64,
        maxLength: 64,
    })
    @IsString()
    @Length(64, 64, { message: 'invalid_token' })
    token: string;
}
