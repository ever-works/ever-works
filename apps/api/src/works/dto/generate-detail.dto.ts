import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateWorkDetailDto {
    @ApiProperty({ description: 'Name of the work to generate details for' })
    @IsString()
    @IsNotEmpty()
    work_name: string;

    @ApiProperty({ description: 'Prompt describing the work purpose and content' })
    @IsString()
    @IsNotEmpty()
    prompt: string;

    @ApiPropertyOptional({ description: 'AI provider plugin ID to use for generation' })
    @IsOptional()
    @IsString()
    ai_provider?: string;
}
