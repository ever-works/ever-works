import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    Max,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';
import { TASK_DELIVERY_STATES, type TaskDeliveryState } from '@ever-works/contracts';

/**
 * APW-08 T29 — the fixture shapes `POST /api/e2e/app-works/task-seed` accepts.
 *
 * The route exists because the columns these fixtures write are written by the worker only — the
 * delivery chain (`TaskDeliveryService`: the PR-status sweep's merge hook and the
 * `app-change-delivery` reconciler) and the workspace finalize path (`branchRef`, `branchState`,
 * `branchGuardRefusal`) — and the Task PATCH DTO rejects every one of them. A Playwright lane on an
 * in-memory SQLite API cannot reach a merged, built, deployed or guard-refused App Work change any
 * other way: there is no git provider, no Build and no Deployment behind it.
 *
 * Every shape is closed (`forbidNonWhitelisted` applies, as on every DTO) and bounded, so a fixture
 * cannot write a value the product never writes:
 *
 *   - `delivery.state` — one of `TASK_DELIVERY_STATES`;
 *   - `delivery.deployment.state` — the four `work_deployments.state` spellings the chain reads;
 *   - `guard` — the INPUTS of the real `AppChangeGuard` (rules and a diff), never its output: the
 *     refusal text the Task page shows is the guard's own sentence, computed by the route.
 */

/** A commit id as the chain stores it (`varchar(64)`, lower-case hex). */
export const E2E_TASK_SEED_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/** The `work_deployments.state` spellings the delivery chain reads (`task-delivery.rules.ts`). */
export const E2E_TASK_SEED_DEPLOYMENT_STATES = [
    'READY',
    'ERROR',
    'ROLLED_BACK',
    'BUILDING',
] as const;
export type E2eTaskSeedDeploymentState = (typeof E2E_TASK_SEED_DEPLOYMENT_STATES)[number];

/** `GitDiffFile.status` values a fixture may name. */
export const E2E_TASK_SEED_FILE_STATUSES = ['added', 'modified', 'removed', 'renamed'] as const;

/** Bounds — a fixture, not a load test. */
export const E2E_TASK_SEED_MAX_FILES = 50;
export const E2E_TASK_SEED_MAX_PATHS = 50;

/** The deciding Deployment of a `live` / `deploy_failed` / `deploying` change. */
export class E2eTaskSeedDeploymentDto {
    @IsIn(E2E_TASK_SEED_DEPLOYMENT_STATES)
    state: E2eTaskSeedDeploymentState;

    /** The live address (`work_deployments.website`); the chip links to it in `live`. */
    @IsOptional()
    @IsString()
    @MaxLength(512)
    @Matches(/^https?:\/\/[^\s]+$/)
    website?: string;

    /** The commit the Deployment carried. Defaults to the merge commit; another sha = "a later change". */
    @IsOptional()
    @IsString()
    @Matches(E2E_TASK_SEED_SHA_PATTERN)
    commitSha?: string;

    /** `ERROR` written by a failed rollback (`appRender.failure.code = 'rollback_failed'`). */
    @IsOptional()
    @IsBoolean()
    rollbackFailed?: boolean;

    /** `READY` with render warnings (`appRender.warnings`) — "Live with warnings". */
    @IsOptional()
    @IsBoolean()
    withWarnings?: boolean;
}

/** Where the merged change stands. */
export class E2eTaskSeedDeliveryDto {
    @IsIn(TASK_DELIVERY_STATES)
    state: TaskDeliveryState;

    /** Defaults to a fresh 40-hex sha (the column is unique per Work). */
    @IsOptional()
    @IsString()
    @Matches(E2E_TASK_SEED_SHA_PATTERN)
    mergeCommitSha?: string;

    /** The merged pull request's number; `prState` is written `merged` with it. */
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(1_000_000)
    prNumber?: number;

    @IsOptional()
    @ValidateNested()
    @Type(() => E2eTaskSeedDeploymentDto)
    deployment?: E2eTaskSeedDeploymentDto;
}

/** One file of the diff the guard judges (`GitDiffFile`). */
export class E2eTaskSeedGuardFileDto {
    @IsString()
    @MaxLength(512)
    path: string;

    @IsOptional()
    @IsString()
    @MaxLength(512)
    previousPath?: string;

    @IsOptional()
    @IsIn(E2E_TASK_SEED_FILE_STATUSES)
    status?: (typeof E2E_TASK_SEED_FILE_STATUSES)[number];

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(1_000_000)
    additions?: number;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(1_000_000)
    deletions?: number;
}

/** The real `AppChangeGuard`'s inputs: the App rules at the base commit and the branch's diff. */
export class E2eTaskSeedGuardDto {
    /** `display.protectedPaths` of the App spec (globs, APW-03's matcher). */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(E2E_TASK_SEED_MAX_PATHS)
    @IsString({ each: true })
    @MaxLength(200, { each: true })
    protectedPaths?: string[];

    /** `agents.maxPullRequestChangedLines`; defaults to the platform's `DEFAULT_SIZE_GUIDANCE`. */
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100_000)
    sizeGuidance?: number;

    @IsArray()
    @ArrayMaxSize(E2E_TASK_SEED_MAX_FILES)
    @ValidateNested({ each: true })
    @Type(() => E2eTaskSeedGuardFileDto)
    files: E2eTaskSeedGuardFileDto[];

    /**
     * Files the provider reported before its cap (`GitDiffResult.totalFiles`). Defaults to
     * `files.length`; a value at or over the guard's `MAX_FILES` is the "too many files" diff.
     */
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(100_000)
    totalFiles?: number;
}

/** `POST /api/e2e/app-works/task-seed`. */
export class E2eTaskSeedDto {
    /** A Task the signed-in person can see, on an App Work. */
    @IsUUID()
    taskId: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => E2eTaskSeedDeliveryDto)
    delivery?: E2eTaskSeedDeliveryDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => E2eTaskSeedGuardDto)
    guard?: E2eTaskSeedGuardDto;
}
