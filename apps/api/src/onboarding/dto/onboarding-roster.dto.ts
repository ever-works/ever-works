import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsIn,
    IsOptional,
    IsString,
    Length,
    Validate,
    ValidateNested,
    ValidatorConstraint,
    type ValidationArguments,
    type ValidatorConstraintInterface,
} from 'class-validator';
import {
    ROSTER_BLUEPRINT_SLUGS,
    ROSTER_LANE_KEYS,
    ROSTER_MAX_LANES,
    ROSTER_NAME_MAX,
    type RosterBlueprintSlug,
    type RosterLaneKey,
    type RosterProvisionRecord,
    type RosterProvisionState,
} from '@ever-works/contracts/api';

const LANE_KEYS: readonly string[] = ROSTER_LANE_KEYS;
const BLUEPRINT_SLUGS: readonly string[] = ROSTER_BLUEPRINT_SLUGS;

/**
 * AW-20 P1 — request + response shapes for the roster endpoints.
 *
 * Every accepted value is `@IsIn(...)` against the contract tuple, the
 * same idiom `onboarding-state.dto.ts` uses for role and team-size ids:
 * the set the API accepts can then never drift from the set the wizard
 * renders, because there is one copy of it.
 */

/** One lane the caller wants provisioned, and what to call its Agent. */
export class ProvisionRosterLaneDto {
    @ApiProperty({ enum: LANE_KEYS })
    @IsIn(LANE_KEYS)
    laneKey!: RosterLaneKey;

    @ApiProperty({ minLength: 1, maxLength: ROSTER_NAME_MAX })
    @IsString()
    @Length(1, ROSTER_NAME_MAX)
    name!: string;
}

/**
 * The two invariants that are about the SET of lanes rather than any one
 * lane, enforced here so a bad payload is a 400 from validation alone —
 * nothing is created, and no service code is involved in deciding that.
 *
 * - No duplicate lane key: two agents cannot both own research, and the
 *   partial unique index behind `agents.lane` would refuse the second
 *   anyway, halfway through a run.
 * - A `coordination` lane must be present: a roster whose ambiguous
 *   requests have nowhere to go is the shape this epic exists to stop
 *   shipping, and every blueprint opens with one.
 */
@ValidatorConstraint({ name: 'rosterLaneSet', async: false })
export class RosterLaneSetConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        if (!Array.isArray(value)) return false;
        const keys = value
            .map((lane) => (lane as { laneKey?: unknown }).laneKey)
            .filter((key): key is string => typeof key === 'string');
        if (keys.length !== value.length) return false;
        if (new Set(keys).size !== keys.length) return false;
        return keys.includes('coordination');
    }

    defaultMessage(args: ValidationArguments): string {
        const keys = Array.isArray(args.value)
            ? args.value.map((lane: { laneKey?: unknown }) => String(lane?.laneKey))
            : [];
        if (new Set(keys).size !== keys.length) {
            return 'lanes must not repeat a lane key.';
        }
        return 'lanes must include the coordination lane.';
    }
}

export class ProvisionRosterDto {
    @ApiPropertyOptional({ enum: BLUEPRINT_SLUGS })
    @IsOptional()
    @IsIn(BLUEPRINT_SLUGS)
    blueprintSlug?: RosterBlueprintSlug;

    @ApiProperty({ type: [ProvisionRosterLaneDto], maxItems: ROSTER_MAX_LANES })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(ROSTER_MAX_LANES)
    @ValidateNested({ each: true })
    @Type(() => ProvisionRosterLaneDto)
    @Validate(RosterLaneSetConstraint)
    lanes!: ProvisionRosterLaneDto[];
}

/** One lane as the wizard should render it. Labels are i18n keys, not English. */
export class RosterLaneOptionDto {
    @ApiProperty({ enum: LANE_KEYS })
    laneKey!: RosterLaneKey;

    /**
     * Leaf under `onboarding.rosterStep.lanes` / `.blurbs`. The API never
     * returns display copy — the wizard owns the words, in 21 locales.
     */
    @ApiProperty()
    labelKey!: string;

    @ApiProperty()
    templateSlug!: string;

    @ApiProperty()
    defaultName!: string;

    @ApiProperty()
    isCoordinator!: boolean;
}

export class RosterBlueprintsResponseDto {
    @ApiProperty({ enum: BLUEPRINT_SLUGS })
    blueprintSlug!: RosterBlueprintSlug;

    /** False when no roles were answered and the general blueprint was assumed. */
    @ApiProperty()
    derivedFromRoles!: boolean;

    /** How many lanes the answered team size allows. */
    @ApiProperty()
    laneCap!: number;

    @ApiProperty()
    maxLanes!: number;

    @ApiProperty()
    nameMax!: number;

    @ApiProperty({ type: [RosterLaneOptionDto] })
    proposal!: RosterLaneOptionDto[];

    /** Everything "+ Add a lane" may offer, in catalogue order. */
    @ApiProperty({ type: [RosterLaneOptionDto] })
    catalog!: RosterLaneOptionDto[];

    @ApiProperty()
    canCreateAgents!: boolean;
}

/** One provisioned roster member, as the introduction renders it. */
export class RosterAgentDto {
    @ApiProperty()
    id!: string;

    @ApiProperty()
    name!: string;

    @ApiProperty({ nullable: true })
    lane!: string | null;

    @ApiProperty({ nullable: true })
    title!: string | null;

    @ApiProperty({ nullable: true })
    reportsToAgentId!: string | null;

    @ApiProperty({ nullable: true })
    reportsToName!: string | null;

    /** Catalog skill titles, not UI copy — the same posture template names take. */
    @ApiProperty({ type: [String] })
    skills!: string[];
}

export class RosterStateResponseDto {
    @ApiProperty()
    state!: RosterProvisionState;

    @ApiProperty({ nullable: true })
    provisioning!: RosterProvisionRecord | null;

    @ApiProperty({ nullable: true })
    acknowledgedAt!: string | null;

    @ApiProperty({ type: [RosterAgentDto] })
    agents!: RosterAgentDto[];

    @ApiProperty()
    canCreateAgents!: boolean;
}

export class ProvisionRosterAcceptedDto {
    @ApiProperty()
    runId!: string;

    @ApiProperty()
    state!: RosterProvisionState;
}
