import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
        if (!vars) return key;
        // The real messages interpolate `{source}` etc; the mock appends
        // the values so specs can assert on them without duplicating copy.
        return `${key} ${Object.values(vars).join(' ')}`;
    },
}));

const routerRefreshMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({
        push: vi.fn(),
        refresh: routerRefreshMock,
        back: vi.fn(),
        replace: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
    }),
    usePathname: () => '/',
}));

const listProposedMock = vi.fn();
const acceptMock = vi.fn();
const archiveMock = vi.fn();
const supersedeMock = vi.fn();
const bodyMock = vi.fn();
const candidatesMock = vi.fn();

vi.mock('@/app/actions/works/kb-review', () => ({
    listProposedKbDocumentsAction: (...args: unknown[]) => listProposedMock(...args),
    acceptKbDocumentAction: (...args: unknown[]) => acceptMock(...args),
    archiveKbDocumentAction: (...args: unknown[]) => archiveMock(...args),
    supersedeKbDecisionAction: (...args: unknown[]) => supersedeMock(...args),
    getKbDocumentBodyAction: (...args: unknown[]) => bodyMock(...args),
    listSupersedeCandidatesAction: (...args: unknown[]) => candidatesMock(...args),
}));

import { KbReviewQueue, truncate } from './KbReviewQueue';
import type { KbDocumentDto } from '@ever-works/contracts';

function doc(overrides: Partial<KbDocumentDto> = {}): KbDocumentDto {
    return {
        id: 'doc-1',
        workId: 'work-1',
        organizationId: null,
        path: 'output/agent-note.md',
        slug: 'agent-note',
        title: 'Agent note',
        description: 'What the agent learned.',
        class: 'output',
        tags: [],
        categories: [],
        status: 'active',
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: null,
        tokenCount: null,
        source: 'agent',
        sourceUploadId: null,
        sourceUrl: null,
        generatedByAgentRunId: null,
        createdById: null,
        updatedById: null,
        createdAt: '2026-07-02T09:00:00.000Z',
        updatedAt: '2026-07-02T09:00:00.000Z',
        lastCommitSha: null,
        lastIndexedAt: null,
        reviewState: 'proposed',
        ...overrides,
    };
}

describe('truncate', () => {
    it('returns short text unchanged', () => {
        expect(truncate('hello world', 100)).toBe('hello world');
    });

    it('cuts on a word boundary and appends an ellipsis', () => {
        const out = truncate('alpha beta gamma delta epsilon', 20);
        expect(out.endsWith('…')).toBe(true);
        expect(out.length).toBeLessThanOrEqual(21);
    });
});

describe('KbReviewQueue', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('renders the empty state when nothing is awaiting review', () => {
        render(<KbReviewQueue workId="work-1" initialDocuments={[]} />);
        expect(screen.getByTestId('kb-review-queue-empty')).toBeTruthy();
        expect(listProposedMock).not.toHaveBeenCalled();
    });

    it('renders the error state with a retry that re-fetches', async () => {
        listProposedMock.mockResolvedValue({ success: true, data: { items: [], total: 0 } });
        render(<KbReviewQueue workId="work-1" initialDocuments={[]} initialError="boom" />);
        expect(screen.getByTestId('kb-review-queue-error').textContent).toContain('boom');
        fireEvent.click(screen.getByTestId('kb-review-queue-retry'));
        await waitFor(() => expect(listProposedMock).toHaveBeenCalledWith('work-1'));
    });

    it('fetches on mount when no server-rendered page was supplied', async () => {
        listProposedMock.mockResolvedValue({
            success: true,
            data: { items: [doc()], total: 1 },
        });
        render(<KbReviewQueue workId="work-1" />);
        await waitFor(() => expect(screen.getByTestId('kb-review-row-doc-1')).toBeTruthy());
    });

    it('shows source, created-at and the count badge for each row', () => {
        render(<KbReviewQueue workId="work-1" initialDocuments={[doc()]} />);
        expect(screen.getByTestId('kb-review-queue-count').textContent).toBe('1');
        expect(screen.getByTestId('kb-review-row-doc-1-source').textContent).toContain('agent');
        expect(screen.getByTestId('kb-review-row-doc-1-created').textContent).not.toBe('—');
    });

    it('lazily loads a content preview when a row is expanded', async () => {
        bodyMock.mockResolvedValue({ success: true, data: { body: 'the note body' } });
        render(<KbReviewQueue workId="work-1" initialDocuments={[doc()]} />);
        expect(screen.queryByTestId('kb-review-row-doc-1-preview')).toBeNull();

        fireEvent.click(screen.getByTestId('kb-review-row-doc-1-toggle'));
        await waitFor(() =>
            expect(screen.getByTestId('kb-review-row-doc-1-preview').textContent).toContain(
                'the note body',
            ),
        );
        expect(bodyMock).toHaveBeenCalledWith('work-1', 'doc-1');
    });

    it('accepts a document and drops it from the queue', async () => {
        acceptMock.mockResolvedValue({ success: true, data: doc({ reviewState: 'accepted' }) });
        render(<KbReviewQueue workId="work-1" initialDocuments={[doc()]} />);

        fireEvent.click(screen.getByTestId('kb-review-row-doc-1-accept'));
        await waitFor(() => expect(screen.queryByTestId('kb-review-row-doc-1')).toBeNull());
        expect(acceptMock).toHaveBeenCalledWith({
            workId: 'work-1',
            docId: 'doc-1',
            path: 'output/agent-note.md',
        });
    });

    it('archives a document via the existing archive endpoint', async () => {
        archiveMock.mockResolvedValue({ success: true, data: doc({ status: 'archived' }) });
        render(<KbReviewQueue workId="work-1" initialDocuments={[doc()]} />);

        fireEvent.click(screen.getByTestId('kb-review-row-doc-1-archive'));
        await waitFor(() => expect(archiveMock).toHaveBeenCalled());
    });

    it('surfaces a per-row error and keeps the row when an action fails', async () => {
        acceptMock.mockResolvedValue({ success: false, error: 'nope' });
        render(<KbReviewQueue workId="work-1" initialDocuments={[doc()]} />);

        fireEvent.click(screen.getByTestId('kb-review-row-doc-1-accept'));
        await waitFor(() =>
            expect(screen.getByTestId('kb-review-row-doc-1-error').textContent).toBe('nope'),
        );
        expect(screen.getByTestId('kb-review-row-doc-1')).toBeTruthy();
    });

    it('offers Edit & accept as a link into the existing editor', () => {
        render(<KbReviewQueue workId="work-1" initialDocuments={[doc()]} />);
        expect(screen.getByTestId('kb-review-row-doc-1-edit').getAttribute('href')).toBe(
            '/works/work-1/kb/output/agent-note.md',
        );
    });

    it('hides Supersede for non-decision documents (the status machine is decision-scoped)', () => {
        render(<KbReviewQueue workId="work-1" initialDocuments={[doc()]} />);
        expect(screen.queryByTestId('kb-review-row-doc-1-supersede')).toBeNull();
    });

    it('offers Supersede for decision-class documents', () => {
        render(
            <KbReviewQueue
                workId="work-1"
                initialDocuments={[doc({ class: 'decision', path: 'decision/db.md' })]}
            />,
        );
        expect(screen.getByTestId('kb-review-row-doc-1-supersede')).toBeTruthy();
    });

    it('supersedes a decision through the decision-status transition with the chosen survivor', async () => {
        candidatesMock.mockResolvedValue({
            success: true,
            data: [doc({ id: 'survivor-1', title: 'New call', class: 'decision' })],
        });
        supersedeMock.mockResolvedValue({ success: true, data: doc() });
        render(
            <KbReviewQueue
                workId="work-1"
                initialDocuments={[doc({ class: 'decision', path: 'decision/db.md' })]}
            />,
        );

        fireEvent.click(screen.getByTestId('kb-review-row-doc-1-supersede'));
        await waitFor(() =>
            expect(screen.getByTestId('kb-review-row-doc-1-survivor-select')).toBeTruthy(),
        );
        await waitFor(() => expect(candidatesMock).toHaveBeenCalledWith('work-1', 'doc-1'));

        fireEvent.change(screen.getByTestId('kb-review-row-doc-1-survivor-select'), {
            target: { value: 'survivor-1' },
        });
        fireEvent.click(screen.getByTestId('kb-review-row-doc-1-supersede-confirm'));

        await waitFor(() =>
            expect(supersedeMock).toHaveBeenCalledWith({
                workId: 'work-1',
                docId: 'doc-1',
                supersededByDocId: 'survivor-1',
                path: 'decision/db.md',
            }),
        );
    });
});
