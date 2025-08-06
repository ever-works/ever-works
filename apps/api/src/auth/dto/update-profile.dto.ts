import { IsString, IsOptional, MinLength, IsUrl } from 'class-validator';

export class UpdateProfileDto {
    @IsString()
    @IsOptional()
    @MinLength(3)
    username?: string;

    @IsUrl()
    @IsOptional()
    avatar?: string;
}