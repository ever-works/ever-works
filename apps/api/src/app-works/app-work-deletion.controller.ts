import {
    Controller,
    Get,
    NotFoundException,
    Optional,
    Param,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { isAppWorkKind } from '@ever-works/contracts';
import {
    AppRuntimeDeletionService,
    type AppDeletionDescription,
} from '@ever-works/agent/app-runtime';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { CurrentUser } from '@src/auth/decorators/user.decorator';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

/**
 * APW-06 T59 (plan §9.7:1477-1479, lane aw-safety 2026-10-26) — **what deleting an App Work will
 * remove**, read by the delete dialog (`DeleteComponent.tsx`) before the member confirms.
 *
 * Owner-only, like the delete it previews (`WorkLifecycleService.deleteWork` →
 * `ensureIsOwner`): a viewer or editor learns nothing about a Work's runtime from here. A Work
 * that is not kind `app` answers the same `404 not_found` a missing one does.
 *
 * Names, kinds and sizes only (`AppRuntimeDeletionService.describeDeletion`): no host, no
 * namespace address, no kubeconfig and no value ever reaches this shape — it is rendered in a
 * browser. Nothing is claimed, dispatched or written.
 */
@ApiTags('App Works')
@Controller('api/works')
export class AppWorkDeletionController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        // `@Optional()`: provided by the `@Global()` `AppRuntimePortsModule`. Absent (a reduced
        // graph), the route answers 503 rather than an empty preview that would read as
        // "nothing to remove".
        @Optional() private readonly deletion?: AppRuntimeDeletionService,
    ) {}

    @Get(':id/app-deletion-preview')
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Preview what deleting an App Work removes',
        description:
            'Owner only. What is removed whatever the member chooses (the App’s workloads by component, and its managed DNS record), what is kept unless "Also delete stored data" is ticked (its dependencies and their sizes), and what that box additionally destroys — plus whether a deletion or a Deployment is already in progress. Names, kinds and sizes only.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: '`AppDeletionDescription`.' })
    @ApiResponse({ status: 403, description: 'Not the Work’s owner.' })
    @ApiResponse({ status: 404, description: 'No such Work, or not kind `app`.' })
    @ApiResponse({ status: 503, description: 'The App runtime is not available in this API.' })
    async getAppDeletionPreview(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<AppDeletionDescription> {
        const { work } = await this.ownership.ensureIsOwner(id, auth.userId);
        if (!isAppWorkKind(work.kind)) {
            throw new NotFoundException({
                status: 'error',
                code: 'not_found',
                message: `Work with id '${id}' not found`,
            });
        }
        if (!this.deletion) {
            throw new ServiceUnavailableException({
                status: 'error',
                code: 'app_runtime_unavailable',
                message: 'The App runtime is not available, so the deletion cannot be previewed.',
            });
        }
        return this.deletion.describeDeletion(work.id);
    }
}
