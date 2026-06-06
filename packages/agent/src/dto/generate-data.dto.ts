import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { sanitizePrompt } from '../utils/sanitize.util';

export class GenerateDataDto {
    @IsString()
    @IsNotEmpty()
    slug: string;

    // Security: cap + sanitize the generation prompt (matches QuickCreateWorkDto.prompt).
    // Prevents unbounded LLM token consumption / cost-DoS and strips control chars.
    @IsString()
    @IsNotEmpty()
    @MaxLength(5000)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizePrompt(value, 5000) : value))
    prompt: string;
}
