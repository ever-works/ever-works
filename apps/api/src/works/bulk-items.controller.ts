import {
    BadRequestException,
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Logger,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsOptional,
    IsString,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AuthService } from '../auth/services/auth.service';
import { AuthSessionGuard } from '../auth/guards/auth-session.guard';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import { WorkGenerationService, WorkOwnershipService } from '@ever-works/agent/services';

/** Per-batch cap. Larger batches should use the import-items endpoint. */
const MAX_BATCH_SIZE = 100;

class BulkDeleteItemsDto {
    @IsArray()
    @ArrayMaxSize(MAX_BATCH_SIZE, {
        message: `Cannot delete more than ${MAX_BATCH_SIZE} items per batch`,
    })
    @IsString({ each: true })
    item_slugs: string[];

    @IsOptional()
    @IsString()
    reason?: string;
}

class BulkUpdateItemDto {
    @IsString()
    item_slug: string;

    @IsOptional()
    @IsBoolean()
    featured?: boolean;

    @IsOptional()
    @IsBoolean()
    published?: boolean;
}

class BulkUpdateItemsDto {
    @IsArray()
    @ArrayMaxSize(MAX_BATCH_SIZE, {
        message: `Cannot update more than ${MAX_BATCH_SIZE} items per batch`,
    })
    @ValidateNested({ each: true })
    @Type(() => BulkUpdateItemDto)
    updates: BulkUpdateItemDto[];
}

class BulkPublishItemsDto {
    @IsArray()
    @ArrayMaxSize(MAX_BATCH_SIZE, {
        message: `Cannot publish more than ${MAX_BATCH_SIZE} items per batch`,
    })
    @IsString({ each: true })
    item_slugs: string[];

    @IsOptional()
    @IsBoolean()
    published?: boolean;
}

interface BulkResultSummary {
    requested: number;
    succeeded: number;
    failed: number;
    errors: Array<{ item_slug: string; message: string }>;
}

/**
 * Work-scoped bulk item operations. Each endpoint:
 *  - Requires authentication (global AuthSessionGuard)
 *  - Calls workOwnershipService.ensureCanEdit() so a stranger gets
 *    403, not "operation succeeded on 0 items"
 *  - Caps at 100 items per batch — class-validator's @ArrayMaxSize
 *    enforces this at the DTO layer so the loop body never sees a
 *    runaway list
 *  - Reports a per-item summary so the client knows which slugs failed
 *  - Throttled tighter than the global cap (10 / min) — bulk ops touch
 *    git + file system and are an obvious abuse target
 *
 * These are thin wrappers around the existing single-item operations
 * (`workGenerationService.removeItem` / `updateItemMetadata`). The
 * sequential loop is intentional: each `removeItem` writes to git,
 * so parallel execution would deadlock on the repo lock.
 */
@ApiTags('Works (bulk items)')
@ApiBearerAuth('JWT-auth')
@Controller('api/works')
@UseGuards(AuthSessionGuard)
export class BulkItemsController {
    private readonly logger = new Logger(BulkItemsController.name);

    constructor(
        private readonly authService: AuthService,
        private readonly workGenerationService: WorkGenerationService,
        private readonly workOwnershipService: WorkOwnershipService,
        private readonly activityLogService: ActivityLogService,
    ) {}

    @Post(':id/items/bulk-delete')
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @ApiOperation({ summary: 'Bulk-delete items from a work' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Per-item summary' })
    @ApiResponse({ status: 400, description: 'Validation failed' })
    @ApiResponse({ status: 403, description: 'Not the work owner / no edit access' })
    async bulkDelete(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Body() dto: BulkDeleteItemsDto,
    ): Promise<BulkResultSummary> {
        const user = await this.authService.getUser(auth.userId);
        await this.workOwnershipService.ensureCanEdit(workId, user.id);

        const slugs = this.dedupe(dto.item_slugs);
        if (slugs.length === 0) {
            return { requested: 0, succeeded: 0, failed: 0, errors: [] };
        }

        const summary: BulkResultSummary = {
            requested: slugs.length,
            succeeded: 0,
            failed: 0,
            errors: [],
        };
        for (const slug of slugs) {
            try {
                await this.workGenerationService.removeItem(
                    workId,
                    { item_slug: slug, reason: dto.reason },
                    user,
                );
                summary.succeeded++;
            } catch (err) {
                summary.failed++;
                summary.errors.push({
                    item_slug: slug,
                    message: (err as Error).message ?? 'unknown error',
                });
            }
        }

        this.activityLogService
            .log({
                userId: auth.userId,
                workId,
                actionType: ActivityActionType.ITEM_REMOVED,
                action: 'items.bulk_deleted',
                status: summary.failed === 0 ? ActivityStatus.COMPLETED : ActivityStatus.FAILED,
                summary: `Bulk delete: ${summary.succeeded}/${summary.requested} removed`,
            })
            .catch(() => {});

        return summary;
    }

    @Post(':id/items/bulk-update')
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @ApiOperation({ summary: 'Bulk-update item metadata (featured / published)' })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Per-item summary' })
    @ApiResponse({ status: 403, description: 'Not the work owner / no edit access' })
    async bulkUpdate(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Body() dto: BulkUpdateItemsDto,
    ): Promise<BulkResultSummary> {
        const user = await this.authService.getUser(auth.userId);
        await this.workOwnershipService.ensureCanEdit(workId, user.id);

        if (!dto.updates || dto.updates.length === 0) {
            return { requested: 0, succeeded: 0, failed: 0, errors: [] };
        }
        // De-dupe by slug — the last write wins. Avoids two writes to
        // the same file in a single batch and the resulting git noise.
        const bySlug = new Map<string, BulkUpdateItemDto>();
        for (const u of dto.updates) {
            if (typeof u?.item_slug !== 'string' || u.item_slug.length === 0) continue;
            bySlug.set(u.item_slug, u);
        }
        const summary: BulkResultSummary = {
            requested: bySlug.size,
            succeeded: 0,
            failed: 0,
            errors: [],
        };
        for (const [slug, u] of bySlug) {
            try {
                // `published` is folded into `featured` because the
                // platform's item storage doesn't have a separate
                // published flag yet — featured is the closest concept
                // and it's the field the YAML supports.
                const featured =
                    typeof u.featured === 'boolean'
                        ? u.featured
                        : typeof u.published === 'boolean'
                          ? u.published
                          : undefined;
                if (featured === undefined) {
                    summary.failed++;
                    summary.errors.push({
                        item_slug: slug,
                        message: 'no update fields provided',
                    });
                    continue;
                }
                await this.workGenerationService.updateItemMetadata(
                    workId,
                    { item_slug: slug, featured },
                    user,
                );
                summary.succeeded++;
            } catch (err) {
                summary.failed++;
                summary.errors.push({
                    item_slug: slug,
                    message: (err as Error).message ?? 'unknown error',
                });
            }
        }

        this.activityLogService
            .log({
                userId: auth.userId,
                workId,
                actionType: ActivityActionType.ITEM_UPDATED,
                action: 'items.bulk_updated',
                status: summary.failed === 0 ? ActivityStatus.COMPLETED : ActivityStatus.FAILED,
                summary: `Bulk update: ${summary.succeeded}/${summary.requested} updated`,
            })
            .catch(() => {});

        return summary;
    }

    @Post(':id/items/bulk-publish')
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Bulk-publish (or unpublish) items by setting their featured flag',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Per-item summary' })
    async bulkPublish(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') workId: string,
        @Body() dto: BulkPublishItemsDto,
    ): Promise<BulkResultSummary> {
        const user = await this.authService.getUser(auth.userId);
        await this.workOwnershipService.ensureCanEdit(workId, user.id);

        const slugs = this.dedupe(dto.item_slugs);
        if (slugs.length === 0) {
            return { requested: 0, succeeded: 0, failed: 0, errors: [] };
        }
        const featured = dto.published !== false; // default to publishing

        const summary: BulkResultSummary = {
            requested: slugs.length,
            succeeded: 0,
            failed: 0,
            errors: [],
        };
        for (const slug of slugs) {
            try {
                await this.workGenerationService.updateItemMetadata(
                    workId,
                    { item_slug: slug, featured },
                    user,
                );
                summary.succeeded++;
            } catch (err) {
                summary.failed++;
                summary.errors.push({
                    item_slug: slug,
                    message: (err as Error).message ?? 'unknown error',
                });
            }
        }

        this.activityLogService
            .log({
                userId: auth.userId,
                workId,
                actionType: ActivityActionType.ITEM_UPDATED,
                action: featured ? 'items.bulk_published' : 'items.bulk_unpublished',
                status: summary.failed === 0 ? ActivityStatus.COMPLETED : ActivityStatus.FAILED,
                summary: `Bulk ${featured ? 'publish' : 'unpublish'}: ${summary.succeeded}/${summary.requested}`,
            })
            .catch(() => {});

        return summary;
    }

    private dedupe(values: string[] | undefined): string[] {
        if (!values || !Array.isArray(values)) return [];
        const seen = new Set<string>();
        const out: string[] = [];
        for (const v of values) {
            if (typeof v !== 'string' || v.length === 0) continue;
            if (seen.has(v)) continue;
            seen.add(v);
            out.push(v);
        }
        return out;
    }
}
