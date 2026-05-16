import { IsString, IsOptional, MinLength, IsUrl, IsEmail, IsBoolean } from 'class-validator';
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
    })
    @IsString()
    @IsOptional()
    committerName?: string | null;

    @ApiPropertyOptional({
        description: 'Custom git committer email (overrides account email for commits)',
    })
    @IsEmail()
    @IsOptional()
    committerEmail?: string | null;

    @ApiPropertyOptional({
        description:
            'EW-602: receive budget threshold alert emails (75/90/100/overage). ' +
            'The in-app notification always fires; this only gates the email channel.',
    })
    @IsBoolean()
    @IsOptional()
    emailBudgetAlerts?: boolean;
}
