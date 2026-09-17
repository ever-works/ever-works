import type { KbLibraryDocumentDto, KbLibraryTreeDto } from '@ever-works/contracts';

/** A shelf row with sensible defaults, for the knowledge component specs. */
export function libraryDoc(overrides: Partial<KbLibraryDocumentDto> = {}): KbLibraryDocumentDto {
    return {
        id: 'doc-1',
        workId: 'work-1',
        organizationId: null,
        path: 'playbooks/refund.md',
        slug: 'refund',
        title: 'Refund policy',
        description: 'When we refund, when we do not.',
        class: 'freeform',
        tags: [],
        categories: [],
        status: 'active',
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: null,
        tokenCount: null,
        source: 'user',
        sourceUploadId: null,
        sourceUrl: null,
        generatedByAgentRunId: null,
        createdById: null,
        updatedById: null,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-02T00:00:00Z',
        lastCommitSha: null,
        lastIndexedAt: null,
        folderId: 'support',
        folderPath: '/Playbooks/Support',
        workName: 'Support desk',
        revision: 2,
        revisionAt: '2026-09-02T06:04:00Z',
        archivedAt: null,
        archivedById: null,
        readState: 'read',
        pinnedAt: null,
        canEdit: true,
        ...overrides,
    } as KbLibraryDocumentDto;
}

/** A folder rail with one nested folder, for the knowledge component specs. */
export function libraryTree(overrides: Partial<KbLibraryTreeDto> = {}): KbLibraryTreeDto {
    return {
        folders: [
            {
                id: 'playbooks',
                name: 'Playbooks',
                path: '/Playbooks',
                parentId: null,
                depth: 1,
                documentCount: 1,
                subtreeDocumentCount: 2,
                hasUnread: false,
                children: [
                    {
                        id: 'support',
                        name: 'Support',
                        path: '/Playbooks/Support',
                        parentId: 'playbooks',
                        depth: 2,
                        documentCount: 1,
                        subtreeDocumentCount: 1,
                        hasUnread: false,
                        children: [],
                    },
                ],
            },
        ],
        unfiled: { documentCount: 3, hasUnread: false },
        documentCount: 5,
        archivedCount: 1,
        hasUnread: false,
        folderCount: 2,
        canManageFolders: true,
        ...overrides,
    };
}
