import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import {
    FLEET_PROCESS_SIGNALS,
    FLEET_SERVICE_MANAGERS,
    FLEET_SERVICE_SCOPES,
    type FleetActionConfirmFields,
    type FleetProcessSignal,
    type FleetServiceManager,
    type FleetServiceScope,
} from '@ever-works/contracts';

/**
 * Machine actions (FL-09, plan §5) — request shapes. Every enumeration comes
 * from the shared contract; the service and the node re-check what they rely
 * on (the node never trusts the platform did), and a service name or pid in
 * the PATH is validated by the controller against the strict contracts
 * patterns before anything runs (FR-36).
 */

/** The CONTRACTS §2.2 confirmation fields every machine act accepts — the same for every caller. */
export class FleetActionConfirmDto implements FleetActionConfirmFields {
    @ApiProperty({ required: false, description: 'Satisfies the `confirm` class.' })
    @IsOptional()
    @IsBoolean()
    confirm?: boolean;

    @ApiProperty({
        required: false,
        description: 'Satisfies `confirm-destructive`: the target name, typed exactly.',
        maxLength: 256,
    })
    @IsOptional()
    @IsString()
    @MaxLength(256)
    confirmName?: string;

    @ApiProperty({
        required: false,
        description: 'Satisfies the warning half of `blast-radius`: the caller read the computer’s sentence.',
    })
    @IsOptional()
    @IsBoolean()
    acknowledgeBlastRadius?: boolean;
}

export class ListFleetServicesQueryDto {
    @ApiProperty({ required: false, enum: [...FLEET_SERVICE_SCOPES, 'all'] })
    @IsOptional()
    @IsIn([...FLEET_SERVICE_SCOPES, 'all'])
    scope?: FleetServiceScope | 'all';

    @ApiProperty({ required: false, maxLength: 200, description: 'Filter by name or description.' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    find?: string;
}

export class FleetServiceActionDto extends FleetActionConfirmDto {
    @ApiProperty({ required: false, enum: FLEET_SERVICE_SCOPES, default: 'system' })
    @IsOptional()
    @IsIn([...FLEET_SERVICE_SCOPES])
    scope?: FleetServiceScope;

    @ApiProperty({
        required: false,
        enum: FLEET_SERVICE_MANAGERS,
        description: 'Which manager holds it (macOS: `launchd` or `brew`); the computer’s own by default.',
    })
    @IsOptional()
    @IsIn([...FLEET_SERVICE_MANAGERS])
    manager?: FleetServiceManager;
}

export class ListFleetProcessesQueryDto {
    @ApiProperty({ required: false, enum: ['cpu', 'mem'], default: 'cpu' })
    @IsOptional()
    @IsIn(['cpu', 'mem'])
    sort?: 'cpu' | 'mem';

    @ApiProperty({ required: false, maxLength: 200, description: 'Filter by name, command, owner or pid.' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    find?: string;
}

export class FleetProcessSignalDto extends FleetActionConfirmDto {
    @ApiProperty({ enum: FLEET_PROCESS_SIGNALS, description: '`TERM` (Stop) or `KILL` (Kill).' })
    @IsIn([...FLEET_PROCESS_SIGNALS])
    signal!: FleetProcessSignal;
}

/**
 * `POST …/docker/containers` — "Run a container" (FL-09 P2, FR-28). `request`
 * is checked by the shared `validateFleetRunRequest` in the service and again
 * on the machine (allow-listed fields only; no privileged mode, host
 * namespaces, cap-add or socket mounts), so it is an object here.
 */
export class FleetRunContainerDto extends FleetActionConfirmDto {
    @ApiProperty({
        description:
            '`{ image, name?, ports: [{host, container, proto?}], env: [{name, value}], volumes: [{source, target, readOnly?}], restart, command? }`. Environment values are never stored, logged or shown again.',
    })
    @IsObject()
    request!: Record<string, unknown>;
}

/** `POST …/docker/images` — pull. */
export class FleetPullImageDto extends FleetActionConfirmDto {
    @ApiProperty({ description: 'The image reference (`redis:7`, `ghcr.io/acme/api:1.4`).', maxLength: 255 })
    @IsString()
    @MaxLength(255)
    ref!: string;
}

/** `DELETE …/docker/images?unused=true` — prune. */
export class FleetPruneImagesQueryDto {
    @ApiProperty({ required: false, enum: ['true', 'false'] })
    @IsOptional()
    @IsIn(['true', 'false'])
    unused?: 'true' | 'false';
}

/** `GET …/docker/compose[?project=]` (FL-09 P3). */
export class FleetComposeQueryDto {
    @ApiProperty({ required: false, description: 'A project name: answer its description instead of the list.' })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    project?: string;
}

/** `POST …/docker/compose/:project/:action` — up · down · restart · pull, optionally one service. */
export class FleetComposeActionDto extends FleetActionConfirmDto {
    @ApiProperty({ required: false, description: 'One service of the project (up, restart, pull).', maxLength: 128 })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    service?: string;
}

/**
 * `POST …/docker/containers/:cid/:action` — the confirmation fields, plus
 * `shell` for `exec` (Shell inside, an owner Session).
 */
export class FleetContainerExecDto extends FleetActionConfirmDto {
    @ApiProperty({ enum: ['bash', 'sh'], default: 'sh' })
    @IsOptional()
    @IsIn(['bash', 'sh'])
    shell?: 'bash' | 'sh';
}

/** The confirmation fields of a body, as the service reads them (only the three CONTRACTS fields). */
export function confirmFieldsOf(body: FleetActionConfirmDto | null | undefined): FleetActionConfirmFields {
    const out: FleetActionConfirmFields = {};
    if (body?.confirm === true) out.confirm = true;
    if (typeof body?.confirmName === 'string') out.confirmName = body.confirmName;
    if (body?.acknowledgeBlastRadius === true) out.acknowledgeBlastRadius = true;
    return out;
}
