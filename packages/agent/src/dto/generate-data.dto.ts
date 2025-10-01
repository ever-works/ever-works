import { IsNotEmpty, IsString } from 'class-validator';

export class GenerateDataDto {
    @IsString()
    @IsNotEmpty()
    slug: string;

    @IsString()
    @IsNotEmpty()
    prompt: string;
}
