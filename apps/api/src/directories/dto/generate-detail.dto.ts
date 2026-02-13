import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class GenerateDirectoryDetailDto {
    @IsString()
    @IsNotEmpty()
    directory_name: string;

    @IsString()
    @IsNotEmpty()
    prompt: string;

    @IsOptional()
    @IsString()
    ai_provider?: string;
}
