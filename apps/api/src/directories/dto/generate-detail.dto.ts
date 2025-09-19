import { IsString, IsNotEmpty } from 'class-validator';

export class GenerateDirectoryDetailDto {
    @IsString()
    @IsNotEmpty()
    directory_name: string;

    @IsString()
    @IsNotEmpty()
    prompt: string;
}
