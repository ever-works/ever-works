import { Injectable, NotFoundException } from '@nestjs/common';
import { MemoryFolder } from '../entities/memory-folder.entity';
import { MemoryFolderRepository } from '../database/repositories/memory-folder.repository';
import { UserUploadRepository } from '../database/repositories/user-upload.repository';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import {
    AgentAttachmentRepository,
    MissionAttachmentRepository,
    WorkProposalAttachmentRepository,
} from '../database/repositories/attachment.repositories';
import { TaskAttachmentRepository } from '../database/repositories/task-side.repositories';

/** Which upload spine a unified row came from. */
export type MemoryFileSource = 'upload' | 'kb-upload';

/** Where a file came from / what references it. All fields optional. */
export interface MemoryFileProvenance {
    workId?: string;
    taskId?: string;
    missionId?: string;
    ideaId?: string;
    agentId?: string;
    /** True when the file arrived via the chat composer / plain upload with no other edge. */
    chat?: boolean;
}

/** One row of the unified /memory Files list. */
export interface MemoryFileRow {
    /** Primary id of the underlying row (user_uploads.id / work_knowledge_uploads.id). */
    id: string;
    source: MemoryFileSource;
    filename: string;
    mime: string | null;
    size: number | null;
    folderId: string | null;
    /** The folder's ownerAgentId (NULL for Global / unfiled files). */
    ownerAgentId: string | null;
    provenance: MemoryFileProvenance;
    updatedAt: string;
    /** Content hash — present for `upload` rows (it is their public id). */
    sha256?: string;
}

export interface ListMemoryFilesOptions {
    /** Active organization — scopes which org KB originals are visible. */
    organizationId?: string;
    /**
     * Folder to list: a folder id for that folder's direct files, `null`
     * for unfiled (root). Omit for "everywhere" (used with `q` search).
     */
    folderId?: string | null;
    source?: MemoryFileSource;
    q?: string;
    limit?: number;
    /**
     * Agent-context read: agent-private folders belong to exactly one
     * agent, so files filed under a folder owned by ANOTHER agent are
     * dropped from the result. Human/API reads omit this (the user owns
     * all their folders).
     */
    agentId?: string;
}

const DEFAULT_LIMIT = 200;

/**
 * Memory Files — the unified read/move surface over BOTH upload spines:
 *
 *   - `user_uploads` (chat composer / plain `POST /api/uploads` files)
 *   - `work_knowledge_uploads` (KB originals: per-Work + org Memory)
 *
 * Rows are merged into one `MemoryFileRow` shape with PROVENANCE mapped
 * from the attachment edge tables in batch (one query per edge table —
 * no N+1): mission/idea/agent edges key on the upload's sha256, Task
 * edges key on the KB upload row id.
 *
 * Agent access rule: folders with `ownerAgentId` are private to that
 * agent. There is no agent runtime read path over `user_uploads` today,
 * so the rule is enforced HERE (the `agentId` list option) and at the
 * API layer — the runtime wiring is a documented follow-up.
 */
@Injectable()
export class MemoryFilesService {
    constructor(
        private readonly folders: MemoryFolderRepository,
        private readonly userUploads: UserUploadRepository,
        private readonly kbUploads: WorkKnowledgeUploadRepository,
        private readonly taskAttachments: TaskAttachmentRepository,
        private readonly missionAttachments: MissionAttachmentRepository,
        private readonly proposalAttachments: WorkProposalAttachmentRepository,
        private readonly agentAttachments: AgentAttachmentRepository,
    ) {}

    async list(userId: string, opts: ListMemoryFilesOptions = {}): Promise<MemoryFileRow[]> {
        const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT);

        // Folder ids resolve against the CALLER's tree only — a foreign
        // folder id is a 404, not an empty list, matching the folder CRUD.
        if (typeof opts.folderId === 'string') {
            const folder = await this.folders.findById(userId, opts.folderId);
            if (!folder) {
                throw new NotFoundException({ status: 'error', message: 'Folder not found' });
            }
        }

        const [uploadRows, kbRows] = await Promise.all([
            opts.source === 'kb-upload'
                ? Promise.resolve([])
                : this.userUploads.listForMemoryFiles({
                      userId,
                      folderId: opts.folderId,
                      q: opts.q,
                      limit,
                  }),
            opts.source === 'upload'
                ? Promise.resolve([])
                : this.kbUploads.listForMemoryFiles({
                      userId,
                      organizationId: opts.organizationId,
                      folderId: opts.folderId,
                      q: opts.q,
                      limit,
                  }),
        ]);

        // Batch provenance lookups — one query per edge table.
        const shaIds = uploadRows.map((r) => r.sha256);
        const kbIds = kbRows.map((r) => r.id);
        const [missionEdges, proposalEdges, agentEdges, taskEdges] = await Promise.all([
            this.missionAttachments.findByUploadIds(shaIds),
            this.proposalAttachments.findByUploadIds(shaIds),
            this.agentAttachments.findByUploadIds(shaIds),
            this.taskAttachments.findByUploadIds(kbIds),
        ]);
        const missionBySha = new Map(missionEdges.map((e) => [e.uploadId, e.missionId]));
        const ideaBySha = new Map(proposalEdges.map((e) => [e.uploadId, e.workProposalId]));
        const agentBySha = new Map(agentEdges.map((e) => [e.uploadId, e.agentId]));
        const taskByKbId = new Map(taskEdges.map((e) => [e.uploadId, e.taskId]));

        // Folder → ownerAgentId map for the agent-privacy filter + row shape.
        const folderMap = new Map<string, MemoryFolder>();
        for (const folder of await this.folders.listByUser(userId)) {
            folderMap.set(folder.id, folder);
        }

        const rows: MemoryFileRow[] = [];
        for (const row of uploadRows) {
            const provenance: MemoryFileProvenance = {};
            if (row.workId) provenance.workId = row.workId;
            const missionId = missionBySha.get(row.sha256);
            if (missionId) provenance.missionId = missionId;
            const ideaId = ideaBySha.get(row.sha256);
            if (ideaId) provenance.ideaId = ideaId;
            const agentId = agentBySha.get(row.sha256);
            if (agentId) provenance.agentId = agentId;
            if (!missionId && !ideaId && !agentId) provenance.chat = true;
            rows.push({
                id: row.id,
                source: 'upload',
                filename: row.originalFilename ?? row.sha256,
                mime: row.mimeType ?? null,
                size:
                    row.fileSize === null || row.fileSize === undefined
                        ? null
                        : Number(row.fileSize),
                folderId: row.folderId ?? null,
                ownerAgentId: row.folderId
                    ? (folderMap.get(row.folderId)?.ownerAgentId ?? null)
                    : null,
                provenance,
                updatedAt: row.updatedAt.toISOString(),
                sha256: row.sha256,
            });
        }
        for (const row of kbRows) {
            const provenance: MemoryFileProvenance = {};
            if (row.workId) provenance.workId = row.workId;
            const taskId = taskByKbId.get(row.id);
            if (taskId) provenance.taskId = taskId;
            rows.push({
                id: row.id,
                source: 'kb-upload',
                filename: row.originalFilename,
                mime: row.mimeType ?? null,
                size:
                    row.fileSize === null || row.fileSize === undefined
                        ? null
                        : Number(row.fileSize),
                folderId: row.folderId ?? null,
                ownerAgentId: row.folderId
                    ? (folderMap.get(row.folderId)?.ownerAgentId ?? null)
                    : null,
                provenance,
                updatedAt: row.updatedAt.toISOString(),
            });
        }

        const visible =
            opts.agentId !== undefined
                ? rows.filter((r) => !r.ownerAgentId || r.ownerAgentId === opts.agentId)
                : rows;

        visible.sort((a, b) =>
            a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
        );
        return visible.slice(0, limit);
    }

    /**
     * File (or unfile, with `folderId: null`) a batch of rows. Every item
     * must be visible to the caller — an unknown / cross-user id throws
     * 404 for the whole batch, BEFORE any row is written, so a failed
     * move never half-applies.
     */
    async moveFiles(
        userId: string,
        items: Array<{ source: MemoryFileSource; id: string }>,
        folderId: string | null,
        opts: { organizationId?: string } = {},
    ): Promise<{ moved: number }> {
        if (folderId !== null) {
            const folder = await this.folders.findById(userId, folderId);
            if (!folder) {
                throw new NotFoundException({ status: 'error', message: 'Folder not found' });
            }
        }

        // Validate the whole batch first (cross-user ⇒ 404, nothing written).
        for (const item of items) {
            if (item.source === 'upload') {
                const row = await this.userUploads.findByIdOwned(item.id, userId);
                if (!row) {
                    throw new NotFoundException({ status: 'error', message: 'File not found' });
                }
            } else {
                const row = await this.kbUploads.findForMemoryFiles(item.id, {
                    userId,
                    organizationId: opts.organizationId,
                });
                if (!row) {
                    throw new NotFoundException({ status: 'error', message: 'File not found' });
                }
            }
        }

        let moved = 0;
        for (const item of items) {
            const ok =
                item.source === 'upload'
                    ? await this.userUploads.setFolder(userId, item.id, folderId)
                    : await this.kbUploads.setFolder(
                          item.id,
                          { userId, organizationId: opts.organizationId },
                          folderId,
                      );
            if (ok) moved += 1;
        }
        return { moved };
    }
}
