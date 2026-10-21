import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import {
    FLEET_FILES_LIMITS,
    FLEET_FILES_NAME_MAX_LENGTH,
    FLEET_FILES_PATH_MAX_LENGTH,
} from '@ever-works/contracts';

/**
 * Files on computers (FL-11, plan §5) — request shapes. Bounds come from the
 * shared contract; the service re-checks every path's SHAPE
 * (`normalizeFleetFileRelativePath`, `isFleetFileName`) and the machine
 * re-checks everything against its own roots — this only keeps the request to
 * the shape.
 */

const ROOT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `?x=a&x=b` and `?x=a` both read as a list. */
const asList = ({ value }: { value: unknown }) =>
    value === undefined ? undefined : Array.isArray(value) ? value : [value];
/** `true` / `1` (query strings) as booleans. */
const asBoolean = ({ value }: { value: unknown }) =>
    value === undefined ? undefined : value === true || value === 'true' || value === '1';

export class FleetFilesLocationQueryDto {
    @ApiProperty({ description: 'The root id from `GET …/files/roots`.' })
    @IsString()
    @Matches(ROOT_ID)
    root!: string;

    @ApiPropertyOptional({
        description: 'A folder under the root, `/`-separated (empty for the root itself).',
        maxLength: FLEET_FILES_PATH_MAX_LENGTH,
    })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_FILES_PATH_MAX_LENGTH)
    path?: string;
}

/** `GET /api/fleet/nodes/:id/files/list`. */
export class FleetFilesListQueryDto extends FleetFilesLocationQueryDto {
    @ApiPropertyOptional({ description: 'Include hidden entries (names starting with a dot).' })
    @IsOptional()
    @Transform(asBoolean)
    @IsBoolean()
    hidden?: boolean;
}

/** `GET /api/fleet/nodes/:id/files/stat`. */
export class FleetFilesStatQueryDto extends FleetFilesLocationQueryDto {
    @ApiProperty({
        description: 'One entry of the folder.',
        maxLength: FLEET_FILES_NAME_MAX_LENGTH,
    })
    @IsString()
    @MaxLength(FLEET_FILES_NAME_MAX_LENGTH)
    name!: string;
}

/** `POST /api/fleet/nodes/:id/files/conflicts`. */
export class FleetFilesConflictsDto extends FleetFilesLocationQueryDto {
    @ApiProperty({ type: [String], description: 'The names about to be written into the folder.' })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(FLEET_FILES_LIMITS.maxEntries)
    @IsString({ each: true })
    @MaxLength(FLEET_FILES_NAME_MAX_LENGTH, { each: true })
    names!: string[];
}

/** `GET /api/fleet/nodes/:id/files/download`. */
export class FleetFilesDownloadQueryDto extends FleetFilesLocationQueryDto {
    @ApiProperty({
        type: [String],
        description: 'Entries of the folder to download (repeat the parameter).',
    })
    @Transform(asList)
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(FLEET_FILES_LIMITS.maxEntries)
    @IsString({ each: true })
    @MaxLength(FLEET_FILES_NAME_MAX_LENGTH, { each: true })
    entries!: string[];

    @ApiPropertyOptional({
        description:
            'Class `confirm` (CONTRACTS §2.2): needed to download a credential-shaped file; without it the answer is 409 `confirmation_required`.',
    })
    @IsOptional()
    @Transform(asBoolean)
    @IsBoolean()
    confirm?: boolean;
}

/** `POST /api/fleet/nodes/:id/files/upload` — the query; the body is the files stream. */
export class FleetFilesUploadQueryDto extends FleetFilesLocationQueryDto {
    @ApiPropertyOptional({ description: 'Replace every same-name entry (default: skip them).' })
    @IsOptional()
    @Transform(asBoolean)
    @IsBoolean()
    replaceAll?: boolean;

    @ApiPropertyOptional({
        type: [String],
        description: 'Same-name entries to replace (the rest are skipped).',
    })
    @IsOptional()
    @Transform(asList)
    @IsArray()
    @ArrayMaxSize(200)
    @IsString({ each: true })
    @MaxLength(FLEET_FILES_NAME_MAX_LENGTH, { each: true })
    replace?: string[];

    @ApiPropertyOptional({
        description: 'Entries in the stream (checked against the 5 000 limit first).',
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(1_000_000)
    entries?: number;

    @ApiPropertyOptional({
        description: 'Bytes in the stream (checked against the 2 GiB limit first).',
    })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    bytes?: number;

    @ApiPropertyOptional({
        description: 'What the Operations strip calls it ("app.ts", "3 items").',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    label?: string;
}

/** `POST /api/fleet/nodes/:id/files/delete`. */
export class FleetFilesDeleteDto extends FleetFilesLocationQueryDto {
    @ApiProperty({ type: [String], description: 'Entries of the folder to delete.' })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(FLEET_FILES_LIMITS.maxEntries)
    @IsString({ each: true })
    @MaxLength(FLEET_FILES_NAME_MAX_LENGTH, { each: true })
    entries!: string[];

    @ApiPropertyOptional({
        description:
            "Class `confirm-destructive` (CONTRACTS §2.2): the entry's name, or for several the folder's name. Without it (or with another) the answer is 409 `confirmation_required`.",
    })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_FILES_NAME_MAX_LENGTH)
    confirmName?: string;
}

/** `DELETE /api/fleet/nodes/:id/files/transfers/:transferId`. */
export class FleetFilesCancelQueryDto {
    @ApiPropertyOptional({
        description: "The transfer's FL-02 operation id, to cancel it from another replica.",
    })
    @IsOptional()
    @IsString()
    @Matches(/^[A-Za-z0-9_-]{1,64}$/)
    operationId?: string;
}
