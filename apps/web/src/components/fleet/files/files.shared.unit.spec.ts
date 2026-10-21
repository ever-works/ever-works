import { describe, expect, it } from 'vitest';
import {
    FLEET_FILES_LIMITS,
    FLEET_FILES_MAX_BYTES_RECORD,
    FLEET_FILES_RECORD_TAGS,
    decodeFleetFilesRecords,
    type FleetFileEntryView,
} from '@ever-works/contracts';
import {
    breadcrumbSegments,
    buildUploadStream,
    conflictPolicy,
    deleteConfirmMatches,
    deleteConfirmName,
    filesApiPath,
    filesTabCard,
    formatFileBytes,
    isUploadRefusal,
    operationNotice,
    parentFilePath,
    rootsSummary,
    sortFileEntries,
} from './files.shared';

/** Files on computers (FL-11, T-11, T-12) — the pure half of the Files tab. Written, not run (fast-build rule). */

const node = { kind: 'node', status: 'online', lastHeartbeatAt: null } as const;

function entry(
    name: string,
    kind: FleetFileEntryView['kind'],
    extra: Partial<FleetFileEntryView> = {},
): FleetFileEntryView {
    return {
        name,
        kind,
        size: 0,
        modifiedAt: null,
        hidden: false,
        credentialShaped: false,
        linkInsideRoot: null,
        ...extra,
    };
}

describe('filesTabCard (spec §5.7)', () => {
    it('says the one reason, in order', () => {
        expect(filesTabCard({ ...node, kind: 'desktop-node' }, null, null)).toEqual({
            kind: 'desktop-node',
        });
        expect(filesTabCard({ ...node, status: 'offline' }, null, null)).toMatchObject({
            kind: 'offline',
        });
        expect(
            filesTabCard(
                node,
                { code: 'consent_missing', hint: null, details: {}, status: 409 },
                null,
            ),
        ).toEqual({ kind: 'consent-missing', command: 'ever-works-node start --manage' });
        expect(filesTabCard(node, null, [])).toEqual({
            kind: 'no-roots',
            command: 'ever-works-node start --manage --files-root <dir>',
        });
        expect(filesTabCard(node, null, null)).toBeNull();
    });
});

describe('entries', () => {
    it('sorts folders (and inside folder links) first, then by name with numbers in order', () => {
        const sorted = sortFileEntries([
            entry('b.ts', 'file'),
            entry('file10', 'file'),
            entry('file2', 'file'),
            entry('src', 'folder'),
            entry('current', 'link', { linkInsideRoot: true, linkKind: 'folder' }),
        ]);
        expect(sorted.map((item) => item.name)).toEqual([
            'current',
            'src',
            'b.ts',
            'file2',
            'file10',
        ]);
    });

    it('formats sizes', () => {
        expect(formatFileBytes(312)).toBe('312 B');
        expect(formatFileBytes(4.1 * 1024)).toBe('4.1 KB');
        expect(formatFileBytes(18 * 1024 * 1024)).toBe('18 MB');
    });

    it('walks the breadcrumb', () => {
        expect(breadcrumbSegments('src/server')).toEqual([
            { name: 'src', path: 'src' },
            { name: 'server', path: 'src/server' },
        ]);
        expect(parentFilePath('src/server')).toBe('src');
        expect(parentFilePath('src')).toBe('');
    });

    it('summarises the roots for the footer (spec S1)', () => {
        expect(
            rootsSummary([
                { id: 'a', kind: 'checkout', label: 'api', path: '/srv/api' },
                { id: 'b', kind: 'checkout', label: 'web', path: '/srv/web' },
                { id: 'c', kind: 'workspace', label: '/ws', path: '/ws' },
                { id: 'd', kind: 'listed', label: '/srv/shared', path: '/srv/shared' },
            ]),
        ).toEqual({ checkouts: 2, workspace: true, listed: ['/srv/shared'] });
    });
});

describe('delete (FR-18, spec §5.3)', () => {
    const root = { path: '/srv/acme-api' };
    it('asks for the entry, the folder, or the root folder', () => {
        expect(deleteConfirmName(['old-build'], 'build', root)).toBe('old-build');
        expect(deleteConfirmName(['a', 'b'], 'acme/src', root)).toBe('src');
        expect(deleteConfirmName(['a', 'b'], '', root)).toBe('acme-api');
        expect(deleteConfirmName(['a', 'b'], '', { path: 'C:\\work\\shared' })).toBe('shared');
    });

    it('enables only on an exact match', () => {
        expect(deleteConfirmMatches('old-build', 'old-build')).toBe(true);
        expect(deleteConfirmMatches('Old-build', 'old-build')).toBe(false);
        expect(deleteConfirmMatches(' old-build', 'old-build')).toBe(false);
        expect(deleteConfirmMatches('', '')).toBe(false);
    });
});

describe('conflict policy (FR-13)', () => {
    it('skips by default, names replaced entries, or replaces all', () => {
        expect(conflictPolicy({ 'app.ts': 'skip', 'README.md': 'skip' })).toEqual({});
        expect(conflictPolicy({ 'app.ts': 'replace', 'README.md': 'skip' })).toEqual({
            replace: ['app.ts'],
        });
        expect(conflictPolicy({ 'app.ts': 'replace', 'README.md': 'replace' })).toEqual({
            replaceAll: true,
        });
    });
});

describe('the upload stream', () => {
    it('builds folder headers first, then each file and its byte records', async () => {
        const stream = buildUploadStream([
            { file: new File(['hello'], 'a.txt'), path: 'docs/a.txt' },
            { file: new File([''], 'empty.txt'), path: 'empty.txt' },
        ]);
        expect(isUploadRefusal(stream)).toBe(false);
        if (isUploadRefusal(stream)) return;
        expect(stream.entries).toBe(3);
        expect(stream.bytes).toBe(5);
        expect(stream.tops).toEqual(['docs', 'empty.txt']);
        const records = decodeFleetFilesRecords(new Uint8Array(await stream.blob.arrayBuffer()))!;
        expect(
            records.map((record) =>
                record.tag === FLEET_FILES_RECORD_TAGS.header ? record.header.path : 'bytes',
            ),
        ).toEqual(['docs', 'docs/a.txt', 'bytes', 'empty.txt']);
    });

    it('slices a large file into records of at most one frame', async () => {
        const big = new File([new Uint8Array(FLEET_FILES_MAX_BYTES_RECORD + 10)], 'big.bin');
        const stream = buildUploadStream([{ file: big, path: 'big.bin' }]);
        if (isUploadRefusal(stream)) throw new Error('refused');
        const records = decodeFleetFilesRecords(new Uint8Array(await stream.blob.arrayBuffer()))!;
        expect(
            records.filter((record) => record.tag === FLEET_FILES_RECORD_TAGS.bytes),
        ).toHaveLength(2);
    });

    it('refuses names that leave the folder and more than 5 000 entries (U8)', () => {
        expect(buildUploadStream([{ file: new File(['x'], 'x'), path: '../x' }])).toMatchObject({
            reason: 'name',
        });
        const many = Array.from({ length: FLEET_FILES_LIMITS.maxEntries + 1 }, (_, i) => ({
            file: new File([''], `f${i}`),
            path: `f${i}`,
        }));
        expect(buildUploadStream(many)).toMatchObject({
            code: 'limit_exceeded',
            reason: 'entries',
        });
    });
});

describe('urls and notices', () => {
    it('builds the BFF path with repeated entries', () => {
        expect(
            filesApiPath('n1', 'download', {
                root: 'r',
                path: '',
                entries: ['a', 'b'],
                confirm: undefined,
            }),
        ).toBe('/api/fleet/nodes/n1/files/download?root=r&entries=a&entries=b');
    });

    it('reads an ended transfer as one sentence (spec §5.6)', () => {
        const base = {
            id: 't',
            operationId: null,
            kind: 'upload' as const,
            nodeId: 'n',
            peerNodeId: null,
            label: 'dist',
            root: 'r',
            path: '',
            entries: 1,
            bytes: 420,
            totalBytes: 1200,
            startedAt: '2026-10-21T09:00:00.000Z',
            endedAt: '2026-10-21T09:00:26.000Z',
            bytesPerSec: null,
        };
        expect(operationNotice({ ...base, state: 'done' }, 'build-02')).toEqual({
            key: 'done',
            bytes: 420,
            seconds: 26,
        });
        expect(operationNotice({ ...base, state: 'cancelled' }, 'build-02')).toMatchObject({
            key: 'cancelled',
            nodeName: 'build-02',
        });
        expect(operationNotice({ ...base, state: 'running', endedAt: null }, 'build-02')).toEqual({
            key: 'running',
            percent: 35,
        });
    });
});
