import { ApiProperty } from '@nestjs/swagger';
import {
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateIf,
} from 'class-validator';
import {
    FLEET_CREDENTIAL_MAX_LENGTH,
    FLEET_CREDENTIAL_MIN_LENGTH,
    FLEET_ENROLLABLE_NODE_KINDS,
    FLEET_EXECUTION_MODES,
    FLEET_EXECUTION_SCOPE_TYPES,
    FLEET_MAX_CLI_VERSION_LENGTH,
    FLEET_MAX_DISK_FREE_BYTES,
    FLEET_MAX_NODE_NAME_LENGTH,
    FLEET_MAX_PLATFORM_LENGTH,
    FLEET_MAX_VERSION_LENGTH,
    FLEET_MIN_NODE_NAME_LENGTH,
} from '@ever-works/contracts';
import type {
    FleetEnrollableNodeKind,
    FleetExecutionMode,
    FleetExecutionScopeType,
} from '@ever-works/contracts';
import {
    MaxConfiguredCapabilityTagLength,
    MaxConfiguredCapabilityTags,
} from './fleet-capability.validators';

/**
 * Every bound below comes from the SHARED fleet contract
 * (`@ever-works/contracts`) rather than a literal typed twice: the node
 * apps validate against the same constants, so a change is a compile
 * error on both sides instead of a runtime rejection nobody sees.
 *
 * The capability caps are the exception — they are operator knobs
 * (`config.fleet.*`), so they go through the validation-time
 * constraints in `./fleet-capability.validators`.
 */
const ENROLLABLE_KINDS: readonly FleetEnrollableNodeKind[] = FLEET_ENROLLABLE_NODE_KINDS;

/**
 * Request body for `POST /api/fleet/nodes/enrollment-token` — issue a
 * one-time enrollment token for a new node. Semantic rules (name floor,
 * kind whitelist) are re-validated in `FleetService`, the single source
 * of truth.
 */
export class CreateFleetEnrollmentTokenDto {
    @ApiProperty({ minLength: FLEET_MIN_NODE_NAME_LENGTH, maxLength: FLEET_MAX_NODE_NAME_LENGTH })
    @IsString()
    @MinLength(FLEET_MIN_NODE_NAME_LENGTH)
    @MaxLength(FLEET_MAX_NODE_NAME_LENGTH)
    name: string;

    @ApiProperty({ enum: ENROLLABLE_KINDS, description: 'App shape of the node.' })
    @IsIn(ENROLLABLE_KINDS)
    kind: FleetEnrollableNodeKind;
}

/** Request body for `PATCH /api/fleet/nodes/:id` (partial update). */
export class UpdateFleetNodeDto {
    @ApiProperty({
        required: false,
        minLength: FLEET_MIN_NODE_NAME_LENGTH,
        maxLength: FLEET_MAX_NODE_NAME_LENGTH,
    })
    @IsOptional()
    @IsString()
    @MinLength(FLEET_MIN_NODE_NAME_LENGTH)
    @MaxLength(FLEET_MAX_NODE_NAME_LENGTH)
    name?: string;

    @ApiProperty({
        required: false,
        description:
            'true drains the node (no new work is leased onto it; in-flight jobs still report and heartbeats are still accepted so it stays observable); false re-enables it as offline until its next heartbeat.',
    })
    @IsOptional()
    @IsBoolean()
    disabled?: boolean;

    @ApiProperty({
        required: false,
        description:
            'true pauses (drains) the node without disabling it; false resumes it as offline until its next heartbeat. A paused node keeps heartbeating and keeps reporting the jobs it already holds.',
    })
    @IsOptional()
    @IsBoolean()
    paused?: boolean;

    @ApiProperty({
        required: false,
        type: [String],
        description:
            "Admin-edited capability tags, e.g. ['terminal', 'workspace']. Writing them PINS the set so the node's heartbeats stop overwriting it; send capabilitiesPinned:false in the same call to hand ownership back to the node.",
    })
    @IsOptional()
    @IsArray()
    // The SAME configurable caps the enroll DTO uses. Hardcoding 16/32
    // here would let an operator who raised FLEET_MAX_CAPABILITY_TAGS
    // enroll a node with more tags than they could subsequently edit.
    @MaxConfiguredCapabilityTags()
    @IsString({ each: true })
    @MaxConfiguredCapabilityTagLength({ each: true })
    capabilities?: string[];

    @ApiProperty({
        required: false,
        description:
            'Whether the admin-edited tag set is authoritative. Only meaningful alongside `capabilities`; defaults to true.',
    })
    @IsOptional()
    @IsBoolean()
    capabilitiesPinned?: boolean;
}

/**
 * Request body for `POST /api/fleet/nodes/:id/drain`.
 *
 * Explicit boolean rather than two verbs: draining and undraining are
 * one idempotent control, and an operator retrying a drain must not
 * accidentally toggle a node back into service.
 */
export class DrainFleetNodeDto {
    @ApiProperty({
        description:
            'true drains the node (disables it AND requeues its in-flight claims); false returns it to service as offline until its next heartbeat.',
    })
    @IsBoolean()
    drain: boolean;
}

/** Node self-description shared by enroll + heartbeat refresh. */
export class FleetNodeSelfDescriptionDto {
    @ApiProperty({
        required: false,
        maxLength: FLEET_MAX_PLATFORM_LENGTH,
        description: 'os/arch, e.g. linux/x64.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_MAX_PLATFORM_LENGTH)
    platform?: string;

    @ApiProperty({ required: false, maxLength: FLEET_MAX_VERSION_LENGTH })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_MAX_VERSION_LENGTH)
    version?: string;

    @ApiProperty({
        required: false,
        type: [String],
        description:
            "Capability tags, e.g. ['terminal', 'workspace', 'docker']. Count and per-tag length are operator-configurable (FLEET_MAX_CAPABILITY_TAGS / FLEET_MAX_CAPABILITY_TAG_LENGTH; defaults 16 / 32).",
    })
    @IsOptional()
    @IsArray()
    @MaxConfiguredCapabilityTags()
    @IsString({ each: true })
    @MaxConfiguredCapabilityTagLength({ each: true })
    capabilities?: string[];

    /**
     * Version of the AGENT CLI on the machine — the binary an
     * `agent-task` step shells out to — as opposed to `version`, which
     * is the daemon's own.
     *
     * Optional here AND optional in the service, which is what keeps
     * older daemons working: they send nothing, and a heartbeat that
     * omits the field leaves the stored value untouched instead of
     * clearing it.
     */
    @ApiProperty({
        required: false,
        maxLength: FLEET_MAX_CLI_VERSION_LENGTH,
        description: 'Version of the agent CLI installed on the node, e.g. "1.4.2".',
    })
    @IsOptional()
    @IsString()
    @MaxLength(FLEET_MAX_CLI_VERSION_LENGTH)
    cliVersion?: string;

    /** Free bytes on the node's workspace volume. Same optional contract. */
    @ApiProperty({
        required: false,
        minimum: 0,
        maximum: FLEET_MAX_DISK_FREE_BYTES,
        description: "Free bytes on the volume the node's workspace lives on.",
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(FLEET_MAX_DISK_FREE_BYTES)
    diskFreeBytes?: number;
}

/**
 * Request body for the PUBLIC `POST /api/fleet/enroll` — the one-time
 * token IS the credential; auth is the constant-time hash check in
 * `FleetService.enroll` (fail-closed 401 on any invalid path).
 */
export class EnrollFleetNodeDto extends FleetNodeSelfDescriptionDto {
    @ApiProperty({
        minLength: FLEET_CREDENTIAL_MIN_LENGTH,
        maxLength: FLEET_CREDENTIAL_MAX_LENGTH,
        description: 'One-time enrollment token.',
    })
    @IsString()
    @MinLength(FLEET_CREDENTIAL_MIN_LENGTH)
    @MaxLength(FLEET_CREDENTIAL_MAX_LENGTH)
    token: string;
}

/**
 * Credential pair every node-initiated fleet call carries. The
 * `(nodeId, secret)` pair IS the credential — checked constant-time
 * against the stored sha256, fail-closed to one undifferentiated 401.
 */
export class FleetNodeCredentialDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    nodeId: string;

    @ApiProperty({ minLength: 16, maxLength: 256, description: 'Node secret minted at enroll.' })
    @IsString()
    @MinLength(16)
    @MaxLength(256)
    secret: string;
}

/**
 * Request body for the PUBLIC `POST /api/fleet/heartbeat` — node
 * credential auth (constant-time hash check, fail-closed 401).
 */
export class FleetHeartbeatDto extends FleetNodeSelfDescriptionDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    nodeId: string;

    @ApiProperty({
        minLength: FLEET_CREDENTIAL_MIN_LENGTH,
        maxLength: FLEET_CREDENTIAL_MAX_LENGTH,
        description: 'Node secret minted at enroll.',
    })
    @IsString()
    @MinLength(FLEET_CREDENTIAL_MIN_LENGTH)
    @MaxLength(FLEET_CREDENTIAL_MAX_LENGTH)
    secret: string;
}

/**
 * Request body for the PUBLIC `POST /api/fleet/pause` — a node draining
 * (or resuming) ITSELF with its own heartbeat credential, so an
 * operator at the machine's keyboard does not need a platform session.
 */
export class FleetNodePauseDto extends FleetNodeCredentialDto {
    @ApiProperty({
        description:
            'true drains this node (no new work is leased onto it; in-flight jobs still report); false resumes it.',
    })
    @IsBoolean()
    paused: boolean;
}

/**
 * Request body for the PUBLIC `POST /api/fleet/unenroll` — a node
 * retiring its own registration. Deleting the row is what makes the
 * credential worthless from that moment on.
 */
export class FleetUnenrollDto extends FleetNodeCredentialDto {}

/**
 * Request body for `PUT /api/fleet/execution-preference` — set (or
 * change) where runs in one scope should execute.
 *
 * `scopeId` is conditionally required rather than blanket-optional. A
 * `work` row without an id would silently behave like an account-wide
 * default and a `user` row carrying one would be invisible to
 * resolution: both are "saved fine, did nothing" failures, and the
 * service re-validates the same pairing as the single source of truth.
 */
export class SetFleetExecutionPreferenceDto {
    @ApiProperty({
        enum: FLEET_EXECUTION_SCOPE_TYPES,
        description:
            "What the preference applies to. 'user' is the account-wide default; 'work' and 'goal' narrow it.",
    })
    @IsIn(FLEET_EXECUTION_SCOPE_TYPES)
    scopeType: FleetExecutionScopeType;

    @ApiProperty({
        required: false,
        format: 'uuid',
        description:
            "Id of the Work or Goal. REQUIRED for scopeType 'work'/'goal'; must be omitted for 'user'.",
    })
    // Only validated (and only allowed) for the narrowing scopes — a
    // `user` row must not carry an id at all.
    @ValidateIf((dto: SetFleetExecutionPreferenceDto) => dto.scopeType !== 'user')
    @IsUUID()
    scopeId?: string;

    @ApiProperty({
        enum: FLEET_EXECUTION_MODES,
        description:
            "'local-wait' runs on the fleet and waits for a free runner slot; 'local-fallback' prefers the fleet but runs in the cloud (with a notification) when no runner can take it; 'cloud' always uses the platform runtime.",
    })
    @IsIn(FLEET_EXECUTION_MODES)
    mode: FleetExecutionMode;
}

/**
 * Query for `DELETE /api/fleet/execution-preference` — clear one scope
 * so it inherits from the next scope out.
 */
export class ClearFleetExecutionPreferenceDto {
    @ApiProperty({ enum: FLEET_EXECUTION_SCOPE_TYPES })
    @IsIn(FLEET_EXECUTION_SCOPE_TYPES)
    scopeType: FleetExecutionScopeType;

    @ApiProperty({ required: false, format: 'uuid' })
    @ValidateIf((dto: ClearFleetExecutionPreferenceDto) => dto.scopeType !== 'user')
    @IsUUID()
    scopeId?: string;
}
