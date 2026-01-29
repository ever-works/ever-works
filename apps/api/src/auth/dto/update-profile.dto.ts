import { IsString, IsOptional, MinLength, IsUrl } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
    @ApiPropertyOptional({ description: 'New username', example: 'johndoe', minLength: 3 })
    @IsString()
    @IsOptional()
    @MinLength(3)
    username?: string;

    @ApiPropertyOptional({ description: 'Avatar image URL', example: 'https://example.com/avatar.jpg' })
    @IsUrl()
    @IsOptional()
    avatar?: string;

    @ApiPropertyOptional({ description: 'Vercel API token for deployments' })
    @IsString()
    @IsOptional()
    vercelToken?: string;

    @ApiPropertyOptional({ description: 'ScreenshotOne API access key for screenshots' })
    @IsString()
    @IsOptional()
    screenshotoneAccessKey?: string;
}
