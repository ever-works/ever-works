import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { KbTagDto } from '@ever-works/contracts';

vi.mock('next-intl', () => ({
    useTranslations: (namespace?: string) => (key: string) =>
        namespace ? `${namespace}.${key}` : key,
}));

vi.mock('@/components/ui/button', () => ({
    Button: ({
        children,
        onClick,
        disabled,
        ...rest
    }: {
        children: ReactNode;
        onClick?: () => void;
        disabled?: boolean;
    } & Record<string, unknown>) => (
        <button type="button" onClick={onClick} disabled={disabled} {...rest}>
            {children}
        </button>
    ),
}));

import { KbClassifyModal, type KbClassifyResult } from './KbClassifyModal';

const sampleFiles = [
    { index: 0, name: 'voice.md', title: 'voice' },
    { index: 1, name: 'tone.md', title: 'tone' },
];

function sampleTags(): KbTagDto[] {
    return [
        {
            id: 't1',
            workId: 'work-1',
            slug: 'tier-1',
            name: 'Tier 1',
            color: null,
            description: null,
            createdAt: '2026-05-22T00:00:00Z',
            updatedAt: '2026-05-22T00:00:00Z',
        },
        {
            id: 't2',
            workId: 'work-1',
            slug: 'audience-us',
            name: 'Audience: US',
            color: null,
            description: null,
            createdAt: '2026-05-22T00:00:00Z',
            updatedAt: '2026-05-22T00:00:00Z',
        },
    ];
}

let lastResult: KbClassifyResult | null = null;
let cancelCalls = 0;
const onConfirm = (result: KbClassifyResult) => {
    lastResult = result;
};
const onCancel = () => {
    cancelCalls += 1;
};

beforeEach(() => {
    lastResult = null;
    cancelCalls = 0;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/**
 * EW-641 Phase 1B/d row 8 — `KbClassifyModal` is the per-batch
 * classification step that opens between picking files and the actual
 * upload. Tests lock the wiring the row #7 zone + Playwright A12 lean
 * on:
 *  - selectors stable (modal, class select, description, tag input,
 *    suggestions, chips, confirm/cancel, file rows)
 *  - confirm hands back `{ targetClass, description, tags, titles }`
 *  - per-file title input edits the `titles[index]` map
 *  - tag suggestions filter by query + ignore selected
 *  - Enter adds a tag; Backspace on empty input removes the last
 *  - tags-fetch failure shows a non-fatal banner
 *  - cancel + ESC fire `onCancel`
 *  - lazy tag fetch hits `/api/works/:id/kb/tags`
 */
describe('KbClassifyModal', () => {
    it('renders the dialog, class select, description, tag input, and file rows', () => {
        render(
            <KbClassifyModal
                workId="work-1"
                files={sampleFiles}
                initialClass="brand"
                initialTags={sampleTags()}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );

        const modal = screen.getByTestId('kb-classify-modal');
        expect(modal).toBeTruthy();
        expect(modal.getAttribute('role')).toBe('dialog');
        expect(modal.getAttribute('aria-modal')).toBe('true');

        const select = screen.getByTestId('kb-classify-class') as HTMLSelectElement;
        expect(select.value).toBe('brand');

        expect(screen.getByTestId('kb-classify-description')).toBeTruthy();
        expect(screen.getByTestId('kb-classify-tag-input')).toBeTruthy();
        const files = screen.getAllByTestId('kb-classify-file');
        expect(files).toHaveLength(2);
        expect(files[0].getAttribute('data-file-index')).toBe('0');
        expect(files[0].textContent).toContain('voice.md');
    });

    it('defaults targetClass to "freeform" when no initialClass is provided', () => {
        render(
            <KbClassifyModal
                workId="work-1"
                files={sampleFiles}
                initialTags={sampleTags()}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );
        const select = screen.getByTestId('kb-classify-class') as HTMLSelectElement;
        expect(select.value).toBe('freeform');
    });

    it('hands back per-file titles + chosen class on confirm', async () => {
        render(
            <KbClassifyModal
                workId="work-1"
                files={sampleFiles}
                initialClass="brand"
                initialTags={sampleTags()}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );

        // Edit the first file's title.
        const titleInputs = screen.getAllByTestId('kb-classify-file-title');
        await act(async () => {
            fireEvent.change(titleInputs[0], { target: { value: 'Brand Voice' } });
        });

        // Edit the description.
        await act(async () => {
            fireEvent.change(screen.getByTestId('kb-classify-description'), {
                target: { value: 'How we talk' },
            });
        });

        // Change the class.
        await act(async () => {
            fireEvent.change(screen.getByTestId('kb-classify-class'), {
                target: { value: 'legal' },
            });
        });

        await act(async () => {
            fireEvent.click(screen.getByTestId('kb-classify-confirm'));
        });

        expect(lastResult).not.toBeNull();
        expect(lastResult!.targetClass).toBe('legal');
        expect(lastResult!.description).toBe('How we talk');
        expect(lastResult!.titles[0]).toBe('Brand Voice');
        // Untouched second file keeps its derived title.
        expect(lastResult!.titles[1]).toBe('tone');
    });

    it('suggests matching tags as the user types + adds via click', async () => {
        render(
            <KbClassifyModal
                workId="work-1"
                files={sampleFiles}
                initialTags={sampleTags()}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );

        const input = screen.getByTestId('kb-classify-tag-input') as HTMLInputElement;
        await act(async () => {
            fireEvent.change(input, { target: { value: 'tier' } });
        });

        const suggestions = screen.getAllByTestId('kb-classify-tag-suggestion');
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].getAttribute('data-tag-slug')).toBe('tier-1');

        await act(async () => {
            fireEvent.click(suggestions[0]);
        });

        const chips = screen.getAllByTestId('kb-classify-tag-chip');
        expect(chips.map((c) => c.textContent?.replace('×', '').trim())).toEqual(['tier-1']);
        expect(input.value).toBe(''); // input cleared after add
    });

    it('adds a free-text tag on Enter + removes the last chip on Backspace', async () => {
        render(
            <KbClassifyModal
                workId="work-1"
                files={sampleFiles}
                initialTags={sampleTags()}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );
        const input = screen.getByTestId('kb-classify-tag-input') as HTMLInputElement;

        await act(async () => {
            fireEvent.change(input, { target: { value: 'custom-tag' } });
            fireEvent.keyDown(input, { key: 'Enter' });
        });
        expect(screen.getAllByTestId('kb-classify-tag-chip')).toHaveLength(1);
        expect(input.value).toBe('');

        await act(async () => {
            fireEvent.keyDown(input, { key: 'Backspace' });
        });
        expect(screen.queryByTestId('kb-classify-tag-chip')).toBeNull();
    });

    it('cancel button fires onCancel', async () => {
        render(
            <KbClassifyModal
                workId="work-1"
                files={sampleFiles}
                initialTags={sampleTags()}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('kb-classify-cancel'));
        });
        expect(cancelCalls).toBe(1);
    });

    it('ESC fires onCancel', async () => {
        render(
            <KbClassifyModal
                workId="work-1"
                files={sampleFiles}
                initialTags={sampleTags()}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );
        await act(async () => {
            fireEvent.keyDown(document, { key: 'Escape' });
        });
        expect(cancelCalls).toBe(1);
    });

    it('lazily fetches tags from /api/works/:id/kb/tags', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => sampleTags(),
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        render(
            <KbClassifyModal
                workId="work-99"
                files={sampleFiles}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(fetchMock.mock.calls[0][0]).toBe('/api/works/work-99/kb/tags');

        // Type a query → suggestion appears.
        await act(async () => {
            fireEvent.change(screen.getByTestId('kb-classify-tag-input'), {
                target: { value: 'audience' },
            });
        });
        await waitFor(() => {
            expect(
                screen
                    .getAllByTestId('kb-classify-tag-suggestion')[0]
                    .getAttribute('data-tag-slug'),
            ).toBe('audience-us');
        });
    });

    it('surfaces a non-fatal banner when the tags fetch fails', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({}),
            text: async () => 'boom',
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        render(
            <KbClassifyModal
                workId="work-99"
                files={sampleFiles}
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await waitFor(() => {
            // The error string is interpolated into the i18n key
            // (`tagsFetchFailed` placeholder); the mock returns the key
            // verbatim — confirming the banner rendered is enough.
            expect(screen.getByTestId('kb-classify-modal').textContent).toContain(
                'tagsFetchFailed',
            );
        });
        // Still allows confirm so a transient tags failure doesn't
        // block the upload entirely.
        expect(screen.getByTestId('kb-classify-confirm')).toBeTruthy();
    });
});
