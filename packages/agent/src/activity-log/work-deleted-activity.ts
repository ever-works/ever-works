import {
    ActivityActionType,
    ActivityStatus,
    type CreateActivityLogDto,
} from '../entities/activity-log.types';
import type { DeleteWorkResponseDto } from '../items-generator/dto/delete-items-generator.dto';

/**
 * The Activity record of a Work deletion — ACC-NEG-07: "Activity records the deletion and names
 * what was kept". Shared by every surface that deletes a Work: the API, and the internal CLI, which
 * used to write none (C-13).
 *
 * `activity_log.workId` is a foreign key to `works`, and a completed delete has already removed that
 * row, so a record that names it as `workId` is refused: the deletion would never be recorded. Only
 * an App Work whose removal the App runtime took over keeps its row (APW-01 T39, FR-40a — it reads
 * **Deleting…**), so only that record may reference it; the key's `SET NULL` clears it once
 * `completeAppWorkDeletion` runs. The Work's identity and the outcome — including the `Kept: …` notes
 * the service writes into `message` — travel in `details` either way.
 *
 * A pending delete's row keeps its **Deleting work** summary: it records the member's request, and
 * nothing rewrites it. The END of that removal is a different record (APW-06's
 * `AppRuntimeDeletionService` writes `app.deploy.removed`).
 */
export function workDeletedActivity(
    userId: string,
    workId: string,
    result: DeleteWorkResponseDto,
): CreateActivityLogDto {
    const rowRemains = result.status === 'pending' || result.deleting === true;
    return {
        userId,
        ...(rowRemains ? { workId } : {}),
        actionType: ActivityActionType.WORK_DELETED,
        action: 'work.deleted',
        status: ActivityStatus.COMPLETED,
        summary: rowRemains ? 'Deleting work' : 'Deleted work',
        details: {
            workId,
            slug: result.slug,
            deletedRepositories: result.deleted_repositories ?? [],
            message: result.message,
        },
    };
}
