import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateDirectoryDetailDto {
    @ApiProperty({ description: 'Name of the directory to generate details for' })
    @IsString()
    @IsNotEmpty()
    directory_name: string;

    @ApiProperty({ description: 'Prompt describing the directory purpose and content' })
    @IsString()
    @IsNotEmpty()
    prompt: string;

    @ApiPropertyOptional({ description: 'AI provider plugin ID to use for generation' })
    @IsOptional()
    @IsString()
    ai_provider?: string;
}
