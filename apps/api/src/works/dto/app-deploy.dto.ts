import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

/**
 * APW-06 §2.2 — the request body and the answer of `POST /api/works/:id/deploy`.
 *
 * The body is deliberately tiny: §2.2 step 1 is
 * `{ buildId?, confirmClusterChange? }` and nothing else. Every other fact a
 * Deployment needs — the target, the namespace, the spec commit, the env — is
 * read by the service from the Work's own state, because a caller that could
 * name them could name a different Work's.
 */
export class AppDeployRequestDto {
    @ApiPropertyOptional({
        description:
            'The Build to deploy. Omit to deploy the Work’s newest green deployable Build. Refused ' +
            '`build_not_applicable` under `build.strategy: image`, where there is no Build to name.',
        format: 'uuid',
    })
    @IsOptional()
    @IsUUID()
    buildId?: string;

    @ApiPropertyOptional({
        description:
            'S29’s confirmation that this Deployment may go to a cluster different from the one the ' +
            'last check saw. Without it, a changed cluster fingerprint is an unmet precondition — the ' +
            'member is shown what changed before their app moves.',
    })
    @IsOptional()
    @IsBoolean()
    confirmClusterChange?: boolean;
}

/** One precondition, warning or advisory entry, as the route renders it. */
export class AppDeployPreconditionDto {
    @ApiProperty({ description: 'The stable code the web app keys its copy off.' })
    code: string;

    @ApiProperty({ description: 'One sentence naming the rule — never a value, never log text.' })
    message: string;
}

/**
 * What the route answers, for **every** status.
 *
 * One shape for `202`, `409` and `422` on purpose: the web app renders the same
 * card whatever happened, and a refusal that arrived in a different shape from
 * an acceptance is a second parser to keep in step.
 */
export class AppDeployResponseDto {
    @ApiProperty({
        description:
            '`accepted` — a row exists and a dispatch was attempted. `queued` — a row exists in the ' +
            'latest-wins queue of one. `refused` — nothing was created.',
        enum: ['accepted', 'queued', 'refused'],
    })
    status: 'accepted' | 'queued' | 'refused';

    @ApiProperty({
        nullable: true,
        description:
            'The refusal code — `APP_DEPLOY_PRECONDITIONS`, `APP_DEPLOY_IN_PROGRESS`, ' +
            '`worker_not_isolated`, `build_not_applicable` … `null` when nothing was refused.',
    })
    code: string | null;

    @ApiProperty({
        nullable: true,
        description:
            'The Deployment this request owns: created, queued, or returned by the dedupe.',
    })
    deploymentId: string | null;

    @ApiProperty({
        nullable: true,
        description: 'The queue entry after this request, when it queued.',
    })
    queuedDeploymentId: string | null;

    @ApiProperty({
        nullable: true,
        description: 'The Deployment holding the lock, for the `409` answer.',
    })
    runningDeploymentId: string | null;

    @ApiProperty({ description: '`true` ⇔ the dispatcher answered inside the 2 s budget.' })
    dispatched: boolean;

    @ApiProperty({
        description:
            '`true` ⇔ this request found the same identity already queued and created nothing.',
    })
    deduplicated: boolean;

    @ApiProperty({
        type: [AppDeployPreconditionDto],
        description:
            'The preconditions that refused. Empty unless `code` is `APP_DEPLOY_PRECONDITIONS`.',
    })
    unmet: AppDeployPreconditionDto[];

    @ApiProperty({
        type: [AppDeployPreconditionDto],
        description:
            'Preconditions that did NOT refuse but the member should see — `primary_domain_missing` ' +
            'and its kind. Present on an accepted Deployment too.',
    })
    advisory: AppDeployPreconditionDto[];

    @ApiProperty({
        type: [AppDeployPreconditionDto],
        description: 'Non-blocking notes from the pass.',
    })
    warnings: AppDeployPreconditionDto[];
}
