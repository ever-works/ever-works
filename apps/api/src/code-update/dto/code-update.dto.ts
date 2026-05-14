import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCodeUpdateDto {
    @ApiProperty({ description: 'Prompt describing the change' })
    @IsString()
    @MaxLength(2000)
    prompt: string;

    @ApiPropertyOptional({ description: 'Optional title for the PR' })
    @IsString()
    @IsOptional()
    @MaxLength(200)
    title?: string;

    @ApiPropertyOptional({ description: 'AI model id (sonnet | opus | haiku | ...)' })
    @IsString()
    @IsOptional()
    @MaxLength(80)
    aiModel?: string;
}
