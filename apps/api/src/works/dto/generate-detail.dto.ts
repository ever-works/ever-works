import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateWorkDetailDto {
    // Security: cap work_name to prevent oversized inputs reaching the AI provider
    @ApiProperty({ description: 'Name of the work to generate details for' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    work_name: string;

    // Security: cap prompt to 8000 chars to prevent unbounded token consumption / DoS
    @ApiProperty({ description: 'Prompt describing the work purpose and content' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(8000)
    prompt: string;

    @ApiPropertyOptional({ description: 'AI provider plugin ID to use for generation' })
    @IsOptional()
    @IsString()
    ai_provider?: string;
}
