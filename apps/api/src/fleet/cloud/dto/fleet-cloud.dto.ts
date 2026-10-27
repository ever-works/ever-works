import { ApiProperty } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsNumber,
    Max,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import {
    FLEET_CLOUD_IDLE_MAX_HOURS,
    FLEET_CLOUD_IDLE_MIN_HOURS,
    FLEET_CLOUD_IDLE_POLICY_MODES,
    FLEET_CLOUD_NAME_PATTERN,
    FLEET_CLOUD_SOFTWARE_IDS,
    type FleetActionConfirmFields,
    type FleetCloudIdlePolicyMode,
    type FleetCloudPowerAction,
    type FleetCloudSoftwareId,
} from '@ever-works/contracts';

/**
 * Cloud computers (FL-17, plan §4.4, §5) — request shapes. Every enumeration
 * comes from the shared contract; the service re-checks everything it relies
 * on (an Agent tool or the CLI reaches it without these DTOs) and verifies the
 * acknowledged price against the provider's CURRENT list price.
 *
 * `vpnAuthKey` (P3) is accepted on create, handed to the bootstrap once, and
 * never echoed, stored, logged or audited: no response type carries it.
 */

export class FleetCloudCreateDto {
    @ApiProperty({
        description: 'The machine-provider plugin id (from GET /api/fleet/providers).',
        maxLength: 64,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(64)
    providerPluginId: string;

    @ApiProperty({
        pattern: FLEET_CLOUD_NAME_PATTERN.source,
        description: '2–39 lower-case letters, digits and hyphens.',
    })
    @IsString()
    @MinLength(2)
    @MaxLength(39)
    @Matches(FLEET_CLOUD_NAME_PATTERN)
    name: string;

    @ApiProperty({ description: 'A region id from the provider options.', maxLength: 64 })
    @IsString()
    @MinLength(1)
    @MaxLength(64)
    regionId: string;

    @ApiProperty({ description: 'A size id from the provider options.', maxLength: 64 })
    @IsString()
    @MinLength(1)
    @MaxLength(64)
    sizeId: string;

    @ApiProperty({ required: false, isArray: true, enum: FLEET_CLOUD_SOFTWARE_IDS })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(FLEET_CLOUD_SOFTWARE_IDS.length)
    @IsIn([...FLEET_CLOUD_SOFTWARE_IDS], { each: true })
    software?: FleetCloudSoftwareId[];

    @ApiProperty({
        description:
            'The monthly price in cents the caller was shown (refused `invalid` when it changed).',
    })
    @IsNumber()
    @Min(0)
    acknowledgedPriceCents: number;

    @ApiProperty({ required: false, description: 'CONTRACTS §2.2 — the price sentence was seen.' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;

    @ApiProperty({
        required: false,
        description: 'The Organization the owner is acting in (spec FR-14).',
    })
    @IsOptional()
    @IsUUID()
    organizationId?: string;

    @ApiProperty({
        required: false,
        maxLength: 200,
        description:
            'P3: the overlay-VPN client’s one-time auth key — used once in the first-boot script, never stored.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    vpnAuthKey?: string;
}

export class FleetCloudPowerDto {
    @ApiProperty({ enum: ['on', 'off'] })
    @IsIn(['on', 'off'])
    action: FleetCloudPowerAction;

    @ApiProperty({ required: false, description: 'CONTRACTS §2.2 — confirm the power change.' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;
}

export class FleetCloudDestroyDto {
    @ApiProperty({
        required: false,
        description: 'CONTRACTS §2.2 `confirm-destructive` — the machine’s exact name.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(39)
    confirmName?: string;
}

/** P2 (spec FR-25) — nothing · tell me after N hours · power off after N hours; N 1–72. */
export class FleetCloudIdlePolicyDto {
    @ApiProperty({ enum: FLEET_CLOUD_IDLE_POLICY_MODES })
    @IsIn([...FLEET_CLOUD_IDLE_POLICY_MODES])
    mode: FleetCloudIdlePolicyMode;

    @ApiProperty({
        minimum: FLEET_CLOUD_IDLE_MIN_HOURS,
        maximum: FLEET_CLOUD_IDLE_MAX_HOURS,
        default: 3,
    })
    @IsInt()
    @Min(FLEET_CLOUD_IDLE_MIN_HOURS)
    @Max(FLEET_CLOUD_IDLE_MAX_HOURS)
    afterHours: number;
}

export function cloudConfirmFields(
    body: { confirm?: boolean; confirmName?: string } | null | undefined,
): FleetActionConfirmFields {
    const out: FleetActionConfirmFields = {};
    if (body?.confirm === true) out.confirm = true;
    if (typeof body?.confirmName === 'string') out.confirmName = body.confirmName;
    return out;
}
