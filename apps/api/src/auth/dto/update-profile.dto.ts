import {
    IsString,
    IsOptional,
    MinLength,
    MaxLength,
    Matches,
    IsUrl,
    IsEmail,
    IsBoolean,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
    @ApiPropertyOptional({ description: 'New username', example: 'johndoe', minLength: 3 })
    @IsString()
    @IsOptional()
    @MinLength(3)
    username?: string;

    @ApiPropertyOptional({
        description: 'Avatar image URL',
        example: 'https://example.com/avatar.jpg',
    })
    @IsUrl()
    @IsOptional()
    avatar?: string;

    @ApiPropertyOptional({
        description: 'Custom git committer name (overrides username for commits)',
        maxLength: 120,
    })
    @IsString()
    @IsOptional()
    // Security: this value is persisted to users.committerName and later embedded
    // verbatim as the git commit author name when an agent writes commits on the
    // user's behalf. Git's on-wire commit-object format is newline-delimited, so a
    // newline/control char in the name could forge a `committer` field or otherwise
    // corrupt the object. Bound the length to the varchar(120) DB column and reject
    // CR/LF and C0/DEL control chars. @IsOptional() keeps the null "clear override"
    // path untouched; all legitimate names are unaffected.
    @MaxLength(120)
    @Matches(/^[^\r\n\x00-\x1F\x7F]+$/, {
        message: 'committerName must not contain newline or control characters',
    })
    committerName?: string | null;

    @ApiPropertyOptional({
        description: 'Custom git committer email (overrides account email for commits)',
    })
    @IsEmail()
    @IsOptional()
    committerEmail?: string | null;

    @ApiPropertyOptional({
        description:
            'Receive budget threshold alert emails (75/90/100/overage). ' +
            'The in-app notification always fires; this only gates the email channel.',
    })
    @IsBoolean()
    @IsOptional()
    emailBudgetAlerts?: boolean;
}
