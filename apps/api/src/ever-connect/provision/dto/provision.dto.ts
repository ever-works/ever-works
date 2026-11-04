import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    Length,
    Matches,
    MaxLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';

/** `POST /api/ever-connect/provision`: the signed request from the URL fragment. */
export class ProvisionIntakeDto {
    @ApiProperty({ description: 'The signed request, as the landing page read it.' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(65_536)
    intent: string;
}

/** What identifies a verified request while the person signs in. */
export class ProvisionTransactionDto {
    @ApiProperty({ description: 'The handle `POST /api/ever-connect/provision` answered.' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(4_096)
    provisionTxn: string;
}

/** The first Mission, as the person left it on the confirmation page. */
export class ProvisionFirstMissionDto {
    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @Length(1, 200)
    title: string;

    @ApiProperty({ minLength: 1, maxLength: 10_000 })
    @IsString()
    @Length(1, 10_000)
    goal: string;
}

/**
 * `POST /api/ever-connect/provision/company`: what the person confirmed. Every
 * field but the handle defaults to the signed request.
 */
export class ProvisionCompanyDto extends ProvisionTransactionDto {
    @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @Length(1, 200)
    name?: string;

    @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @Length(1, 200)
    legalName?: string;

    @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2' })
    @IsOptional()
    @IsString()
    @Matches(/^[A-Za-z]{2}$/)
    countryCode?: string;

    /** Checked by the service: a bad one answers `422 slug_invalid`. */
    @ApiPropertyOptional({ description: 'Defaults to the Ever handle', maxLength: 64 })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    slug?: string;

    @ApiPropertyOptional({ nullable: true, description: 'A template of `GET /api/org-templates`' })
    @ValidateIf((_, value) => value !== null && value !== undefined)
    @IsString()
    @Length(1, 128)
    staffTemplateSlug?: string | null;

    @ApiPropertyOptional({ nullable: true, type: ProvisionFirstMissionDto })
    @ValidateIf((_, value) => value !== null && value !== undefined)
    @IsObject()
    @ValidateNested()
    @Type(() => ProvisionFirstMissionDto)
    firstMission?: ProvisionFirstMissionDto | null;
}
