'use client';

import { EntityAttachmentsSection } from '@/components/common/EntityAttachmentsSection';
import { attachUploadToAgentAction, detachAgentAttachmentAction } from '@/app/actions/agents';
import type { AgentAttachmentRow } from '@/lib/api/agents';

/**
 * Client-side wrapper around {@link EntityAttachmentsSection} for the
 * Agent detail page. Supplies the onAttach / onDetach callbacks bound
 * to the matching server actions so the server-rendered Agent page
 * stays a plain RSC and only this leaf needs to be a client component.
 */
export function AgentAttachmentsPanel({
    agentId,
    initial,
}: {
    agentId: string;
    initial: ReadonlyArray<AgentAttachmentRow>;
}) {
    return (
        <EntityAttachmentsSection<AgentAttachmentRow>
            initial={initial}
            onAttach={(uploadId) => attachUploadToAgentAction(agentId, uploadId)}
            onDetach={(attachmentId) => detachAgentAttachmentAction(agentId, attachmentId)}
            testId="agent-attachments"
        />
    );
}
