import { IsString, IsOptional, MaxLength, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateApiKeyDto {
	@ApiProperty({ description: 'A label for the API key', maxLength: 100 })
	@IsString()
	@MaxLength(100)
	name: string;

	@ApiPropertyOptional({ description: 'Expiration date in ISO 8601 format' })
	@IsOptional()
	@IsDateString()
	expiresAt?: string;
}
