import { Transform } from 'class-transformer';
import { IsDefined, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateActiveScopeDto {
    @ApiProperty({
        type: String,
        nullable: true,
        example: 'ever',
        description:
            'Organization slug to make active. Explicit null selects personal/bare-Tenant scope.',
    })
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @ValidateIf((_object, value) => value !== null)
    @IsDefined()
    @IsString()
    @Length(1, 64)
    @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    organizationSlug: string | null;
}
