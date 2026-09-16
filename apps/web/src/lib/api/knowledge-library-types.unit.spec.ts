import { describe, expect, it } from 'vitest';
import type { KbLibraryFolderNodeDto } from '@ever-works/contracts';
import {
    buildLibraryQuery,
    flattenLibraryFolders,
    formatFolderPath,
    KNOWLEDGE_LIBRARY_BFF,
} from './knowledge-library-types';

function node(
    id: string,
    path: string,
    children: KbLibraryFolderNodeDto[] = [],
): KbLibraryFolderNodeDto {
    const segments = path.split('/').filter(Boolean);
    return {
        id,
        name: segments[segments.length - 1] ?? id,
        path,
        parentId: null,
        depth: segments.length,
        documentCount: 1,
        subtreeDocumentCount: 1 + children.length,
        hasUnread: false,
        children,
    };
}

describe('buildLibraryQuery', () => {
    it('is empty when nothing is set, so the API applies its own defaults', () => {
        expect(buildLibraryQuery()).toBe('');
        expect(buildLibraryQuery({ q: '   ', classes: [] })).toBe('');
    });

    it('writes every set filter, repeating classes and trimming the search', () => {
        expect(
            buildLibraryQuery({
                folderId: 'unfiled',
                archived: 'only',
                q: '  refund policy ',
                classes: ['style', 'brand'],
                workId: 'work-1',
                sort: 'title',
                limit: 50,
                cursor: 'eyJvIjo1MH0',
            }),
        ).toBe(
            '?folderId=unfiled&archived=only&q=refund+policy&class=style&class=brand&workId=work-1&sort=title&limit=50&cursor=eyJvIjo1MH0',
        );
    });
});

describe('KNOWLEDGE_LIBRARY_BFF', () => {
    it('encodes ids and names shared folders by their scope on the existing folder routes', () => {
        expect(KNOWLEDGE_LIBRARY_BFF.document('a/b')).toBe('/api/knowledge/documents/a%2Fb');
        expect(KNOWLEDGE_LIBRARY_BFF.exportMarkdown('d1')).toBe(
            '/api/knowledge/documents/d1/export?format=md',
        );
        expect(KNOWLEDGE_LIBRARY_BFF.sharedFolder('f 1')).toBe(
            '/api/memory/files/folders/f%201?scope=organization',
        );
        expect(KNOWLEDGE_LIBRARY_BFF.library({ sort: 'recent' })).toBe(
            '/api/knowledge/library?sort=recent',
        );
    });
});

describe('flattenLibraryFolders', () => {
    it('walks depth-first with parents before children', () => {
        const tree = [
            node('p', '/Playbooks', [node('s', '/Playbooks/Support'), node('o', '/Playbooks/On')]),
            node('r', '/Reports'),
        ];
        const flat = flattenLibraryFolders(tree);
        expect(flat.map((f) => f.id)).toEqual(['p', 's', 'o', 'r']);
        expect(flat[0]).toMatchObject({ depth: 1, hasChildren: true, name: 'Playbooks' });
        expect(flat[1]).toMatchObject({ depth: 2, hasChildren: false });
    });

    it('is empty for an empty tree', () => {
        expect(flattenLibraryFolders([])).toEqual([]);
    });
});

describe('formatFolderPath', () => {
    it('reads a materialized path as a breadcrumb', () => {
        expect(formatFolderPath('/Playbooks/Support')).toBe('Playbooks / Support');
    });

    it('returns null for Unfiled', () => {
        expect(formatFolderPath(null)).toBeNull();
        expect(formatFolderPath('/')).toBeNull();
    });
});
