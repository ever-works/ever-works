'use client';

import { useTranslations } from 'next-intl';
import {
    EntityAttachmentsSection,
    type EntityAttachmentRow,
} from '@/components/common/EntityAttachmentsSection';
import { attachUploadAction, detachAttachmentAction } from '@/app/actions/tasks';
import type { TaskAttachmentRow } from '@/lib/api/tasks';

interface Props {
    taskId: string;
    workId?: string | null;
    initial: TaskAttachmentRow[];
    initialError?: string | null;
}

/**
 * FU-5 — task attachments panel mounted between transitions and
 * conversation on TaskDetailClient.
 *
 * Presentation is the shared {@link EntityAttachmentsSection} (same
 * Drive-style tile grid the Agent / Mission / Idea detail pages use);
 * this wrapper only supplies the Task-specific plumbing:
 *
 *   - Bytes upload through the Work KB proxy
 *     (`POST /api/works/:workId/kb/uploads`) rather than the shared
 *     `/api/uploads/file` endpoint, so the Work's own MIME/size policy
 *     applies. Upstream errors are surfaced verbatim so the user sees
 *     the right 413 / 415 / 400 message.
 *   - The returned upload id is wired into the Task via
 *     `POST /api/tasks/:id/attachments`.
 *   - Tiles open/preview through the KB download proxy
 *     (`/api/works/:workId/kb/uploads/:uploadId/download`), which
 *     forwards to the owner/viewer-gated NestJS route.
 *
 * Tasks without a Work can't own attachments at all, so the drop zone
 * is replaced by the `attachmentsWorkOnly` explainer.
 */
export function TaskAttachmentsSection({ taskId, workId, initial, initialError = null }: Props) {
    const t = useTranslations('dashboard.tasksPage.detail');

    const downloadUrl = (uploadId: string): string | null =>
        workId ? `/api/works/${workId}/kb/uploads/${uploadId}/download` : null;

    // Task rows nest their joined upload metadata under `upload`; the
    // shared panel reads it flat, so normalize on the way in.
    const toTile = (row: TaskAttachmentRow): EntityAttachmentRow => ({
        id: row.id,
        uploadId: row.uploadId,
        createdAt: row.createdAt,
        filename: row.upload?.filename ?? null,
        mimeType: row.upload?.contentType ?? null,
        sizeBytes: row.upload?.sizeBytes ?? null,
        url: row.upload?.downloadUrl ?? downloadUrl(row.uploadId),
    });

    const uploader = async (file: File): Promise<{ id: string; url?: string }> => {
        if (!workId) {
            throw new Error('Attachments are available for Work-scoped tasks.');
        }
        const form = new FormData();
        form.append('file', file);
        const resp = await fetch(`/api/works/${workId}/kb/uploads`, {
            method: 'POST',
            body: form,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(text || `Upload failed (${resp.status})`);
        }
        const body = (await resp.json()) as { id?: string; upload?: { id?: string } };
        const uploadId = body.upload?.id ?? body.id;
        if (!uploadId) {
            throw new Error('Upload succeeded but response missing upload id.');
        }
        return { id: uploadId, url: downloadUrl(uploadId) ?? undefined };
    };

    return (
        <EntityAttachmentsSection<EntityAttachmentRow>
            initial={initial.map(toTile)}
            initialError={initialError}
            onAttach={async (uploadId) => toTile(await attachUploadAction(taskId, uploadId))}
            onDetach={(attachmentId) => detachAttachmentAction(taskId, attachmentId)}
            uploader={uploader}
            disabled={!workId}
            disabledMessage={t('attachmentsWorkOnly')}
            testId="task-attachments"
        />
    );
}
