import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateDirectoryDto {
  @IsString()
  @IsNotEmpty()
  slug: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsOptional()
  @IsString()
  owner?: string;
}
