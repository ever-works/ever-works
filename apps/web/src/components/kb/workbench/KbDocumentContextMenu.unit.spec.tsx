import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
        if (!vars) return key;
        return Object.entries(vars).reduce<string>(
            (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
            key,
        );
    },
}));

const routerPushMock = vi.fn();
const routerRefreshMock = vi.fn();
const routerReplaceMock = vi.fn();

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({
        push: routerPushMock,
        refresh: routerRefreshMock,
        replace: routerReplaceMock,
        back: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
    }),
    usePathname: () => '/',
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
}));

const updateActionMock = vi.fn();
const deleteActionMock = vi.fn();
const lockActionMock = vi.fn();
const unlockActionMock = vi.fn();

vi.mock('@/app/actions/works/kb-document', () => ({
    updateKbDocumentAction: (...args: unknown[]) => updateActionMock(...args),
    deleteKbDocumentAction: (...args: unknown[]) => deleteActionMock(...args),
}));
vi.mock('@/app/actions/works/kb-lock', () => ({
    lockKbDocumentAction: (...args: unknown[]) => lockActionMock(...args),
    unlockKbDocumentAction: (...args: unknown[]) => unlockActionMock(...args),
}));

import { KbDocumentContextMenu, makeDuplicatePath } from './KbDocumentContextMenu';
import type { KbDocumentDto } from '@ever-works/contracts';

function doc(overrides: Partial<KbDocumentDto> = {}): KbDocumentDto {
    return {
        id: 'doc-1',
        workId: 'work-1',
        organizationId: null,
        path: 'brand/voice.md',
        slug: 'voice',
        title: 'Brand voice',
        description: null,
        class: 'brand',
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
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T00:00:00Z',
        lastCommitSha: null,
        lastIndexedAt: null,
        ...overrides,
    };
}

function openMenu(testId = 'kb-workbench-context-menu-wrapper-doc-1') {
    fireEvent.contextMenu(screen.getByTestId(testId), { clientX: 10, clientY: 10 });
}

describe('KbDocumentContextMenu', () => {
    beforeEach(() => {
        updateActionMock.mockReset();
        deleteActionMock.mockReset();
        lockActionMock.mockReset();
        unlockActionMock.mockReset();
        routerPushMock.mockReset();
        routerRefreshMock.mockReset();
        routerReplaceMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not render the menu until right-click fires', () => {
        render(
            <KbDocumentContextMenu workId="work-1" document={doc()}>
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        expect(screen.queryByTestId('kb-workbench-context-menu-doc-1')).toBeNull();
    });

    it('opens the menu on right-click and renders every action item', () => {
        render(
            <KbDocumentContextMenu workId="work-1" document={doc()}>
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        expect(screen.getByTestId('kb-workbench-context-menu-doc-1')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-context-rename')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-context-duplicate')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-context-lock')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-context-archive')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-context-copy-path')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-context-copy-wikilink')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-context-delete')).toBeTruthy();
    });

    it('opens the lock submenu and locks with the selected mode', async () => {
        lockActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ locked: true, lockMode: 'additions-only' }),
        });

        render(
            <KbDocumentContextMenu workId="work-1" document={doc()}>
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        fireEvent.click(screen.getByTestId('kb-workbench-context-lock'));
        fireEvent.click(screen.getByTestId('kb-workbench-context-lock-additions'));

        await waitFor(() => {
            expect(lockActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                path: 'brand/voice.md',
                mode: 'additions-only',
            });
        });
    });

    it('shows Unlock instead of Lock when document is locked', () => {
        render(
            <KbDocumentContextMenu
                workId="work-1"
                document={doc({ locked: true, lockMode: 'full' })}
            >
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        expect(screen.getByTestId('kb-workbench-context-unlock')).toBeTruthy();
        expect(screen.queryByTestId('kb-workbench-context-lock')).toBeNull();
    });

    it('unlocks via unlockKbDocumentAction', async () => {
        unlockActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ locked: false, lockMode: null }),
        });
        render(
            <KbDocumentContextMenu
                workId="work-1"
                document={doc({ locked: true, lockMode: 'full' })}
            >
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        fireEvent.click(screen.getByTestId('kb-workbench-context-unlock'));
        await waitFor(() => {
            expect(unlockActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                path: 'brand/voice.md',
            });
        });
    });

    it('archives via updateKbDocumentAction with status=archived', async () => {
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ status: 'archived' }),
        });
        render(
            <KbDocumentContextMenu workId="work-1" document={doc()}>
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        fireEvent.click(screen.getByTestId('kb-workbench-context-archive'));
        await waitFor(() => {
            expect(updateActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                body: { status: 'archived' },
            });
        });
    });

    it('copies the path to the clipboard via the test clipboard seam', async () => {
        const writes: string[] = [];
        render(
            <KbDocumentContextMenu
                workId="work-1"
                document={doc()}
                clipboardWrite={(text) => {
                    writes.push(text);
                }}
            >
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        fireEvent.click(screen.getByTestId('kb-workbench-context-copy-path'));
        await waitFor(() => {
            expect(writes).toContain('brand/voice.md');
        });
    });

    it('copies a wikilink to the clipboard', async () => {
        const writes: string[] = [];
        render(
            <KbDocumentContextMenu
                workId="work-1"
                document={doc()}
                clipboardWrite={(text) => {
                    writes.push(text);
                }}
            >
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        fireEvent.click(screen.getByTestId('kb-workbench-context-copy-wikilink'));
        await waitFor(() => {
            expect(writes).toContain('[[brand/voice.md]]');
        });
    });

    it('disables rename / duplicate / delete when the document is fully locked', () => {
        render(
            <KbDocumentContextMenu
                workId="work-1"
                document={doc({ locked: true, lockMode: 'full' })}
            >
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();

        const rename = screen.getByTestId('kb-workbench-context-rename') as HTMLButtonElement;
        const duplicate = screen.getByTestId('kb-workbench-context-duplicate') as HTMLButtonElement;
        const del = screen.getByTestId('kb-workbench-context-delete') as HTMLButtonElement;

        expect(rename.disabled).toBe(true);
        expect(duplicate.disabled).toBe(true);
        expect(del.disabled).toBe(true);
    });

    it('does not disable rename / duplicate when only additions-only locked', () => {
        // EW-643 slice 1 semantics: full lock blocks the destructive trio,
        // additions-only does not — verify the partial-lock branch.
        render(
            <KbDocumentContextMenu
                workId="work-1"
                document={doc({ locked: true, lockMode: 'additions-only' })}
            >
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        // Locked → Unlock surfaced (not Lock submenu). Rename + Duplicate
        // are not subject to the full-lock guard at this granularity.
        const rename = screen.getByTestId('kb-workbench-context-rename') as HTMLButtonElement;
        expect(rename.disabled).toBe(false);
    });

    it('opens rename dialog and PATCHes with the new path', async () => {
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ path: 'brand/voice-v2.md' }),
        });

        render(
            <KbDocumentContextMenu workId="work-1" document={doc()}>
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        fireEvent.click(screen.getByTestId('kb-workbench-context-rename'));

        const input = (await screen.findByTestId(
            'kb-workbench-context-rename-input',
        )) as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'brand/voice-v2.md' } });
        fireEvent.click(screen.getByTestId('kb-workbench-context-rename-submit'));

        await waitFor(() => {
            expect(updateActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                body: { path: 'brand/voice-v2.md' },
            });
        });
    });

    it('delete confirmation requires the doc name before the confirm button enables', async () => {
        deleteActionMock.mockResolvedValueOnce({ success: true, data: { id: 'doc-1' } });
        render(
            <KbDocumentContextMenu workId="work-1" document={doc()}>
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        fireEvent.click(screen.getByTestId('kb-workbench-context-delete'));

        const confirm = (await screen.findByTestId(
            'kb-workbench-context-delete-confirm',
        )) as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);

        // Wrong name keeps it disabled.
        fireEvent.change(screen.getByTestId('kb-workbench-context-delete-input'), {
            target: { value: 'wrong' },
        });
        expect(confirm.disabled).toBe(true);

        // Right name (matches `title`) enables.
        fireEvent.change(screen.getByTestId('kb-workbench-context-delete-input'), {
            target: { value: 'Brand voice' },
        });
        expect(confirm.disabled).toBe(false);

        fireEvent.click(confirm);
        await waitFor(() => {
            expect(deleteActionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                path: 'brand/voice.md',
            });
        });
        await waitFor(() => {
            expect(routerPushMock).toHaveBeenCalledWith('/works/work-1/kb');
        });
    });

    it('duplicate posts to the duplicate endpoint and routes to the new doc', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify({ id: 'doc-2', path: 'brand/voice-copy.md' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        render(
            <KbDocumentContextMenu workId="work-1" document={doc()}>
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        fireEvent.click(screen.getByTestId('kb-workbench-context-duplicate'));

        await waitFor(() => {
            expect(fetchSpy).toHaveBeenCalled();
        });
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/api/works/work-1/kb/documents/doc-1/duplicate');
        expect(init?.method).toBe('POST');
        await waitFor(() => {
            expect(routerPushMock).toHaveBeenCalledWith('/works/work-1/kb/brand/voice-copy.md');
        });
    });

    it('Escape closes the menu', () => {
        render(
            <KbDocumentContextMenu workId="work-1" document={doc()}>
                <a data-testid="row">row</a>
            </KbDocumentContextMenu>,
        );
        openMenu();
        expect(screen.getByTestId('kb-workbench-context-menu-doc-1')).toBeTruthy();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('kb-workbench-context-menu-doc-1')).toBeNull();
    });
});

describe('makeDuplicatePath', () => {
    it('appends -copy before the extension', () => {
        expect(makeDuplicatePath('brand/voice.md')).toBe('brand/voice-copy.md');
    });
    it('bumps the counter on already-copied paths', () => {
        expect(makeDuplicatePath('brand/voice-copy.md')).toBe('brand/voice-copy-2.md');
        expect(makeDuplicatePath('brand/voice-copy-3.md')).toBe('brand/voice-copy-4.md');
    });
});
