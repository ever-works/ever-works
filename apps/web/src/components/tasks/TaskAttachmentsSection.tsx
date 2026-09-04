'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    EntityAttachmentsSection,
    type EntityAttachmentRow,
} from '@/components/common/EntityAttachmentsSection';
import { cn } from '@/lib/utils/cn';
import { attachUploadAction, detachAttachmentAction } from '@/app/actions/tasks';
import type { TaskAttachmentRole, TaskAttachmentRow } from '@/lib/api/tasks';

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
    // Which side of the Task the NEXT attachment lands on. `initial` is
    // the default (input material the requester brings); `result` marks a
    // worked output and is what puts the corner chip on the tile. Without
    // this control nothing in the product could ever produce a `result`
    // row, so the chip below could never render.
    const [role, setRole] = useState<TaskAttachmentRole>('initial');

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
        // Role chip: `result` marks agent/worked output; the default
        // `initial` role is the unmarked common case (no chip noise).
        badge: row.role === 'result' ? t('attachmentRoleResult') : null,
    });

    const uploader = async (file: File): Promise<{ id: string; url?: string }> => {
        if (!workId) {
            throw new Error('Attachments are available for Work-scoped tasks.');
        }
        const form = new FormData();
        form.append('file', file);
        // eslint-disable-next-line no-restricted-syntax -- EW-790 ok
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

    const ROLE_LABEL: Record<TaskAttachmentRole, string> = {
        initial: t('attachmentRoleInitial'),
        result: t('attachmentRoleResult'),
    };

    return (
        <div className="space-y-2">
            {workId && (
                <div
                    role="radiogroup"
                    aria-label={t('attachmentAttachAs')}
                    className="flex items-center gap-1.5"
                >
                    <span className="text-[10px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                        {t('attachmentAttachAs')}
                    </span>
                    {(Object.keys(ROLE_LABEL) as TaskAttachmentRole[]).map((value) => (
                        <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={role === value}
                            onClick={() => setRole(value)}
                            data-testid={`task-attachment-role-${value}`}
                            className={cn(
                                'px-2 py-0.5 text-[11px] font-medium rounded border transition-colors',
                                role === value
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-border/60 dark:border-border-dark/60 text-text-secondary hover:text-text dark:hover:text-text-dark',
                            )}
                        >
                            {ROLE_LABEL[value]}
                        </button>
                    ))}
                </div>
            )}
            <EntityAttachmentsSection<EntityAttachmentRow>
                initial={initial.map(toTile)}
                initialError={initialError}
                onAttach={async (uploadId) =>
                    toTile(await attachUploadAction(taskId, uploadId, role))
                }
                onDetach={(attachmentId) => detachAttachmentAction(taskId, attachmentId)}
                uploader={uploader}
                disabled={!workId}
                disabledMessage={t('attachmentsWorkOnly')}
                testId="task-attachments"
            />
        </div>
    );
}
