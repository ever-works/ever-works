// Tiptap 3 migration (Gauzy Ever Works #363) — the editor specs mock Tiptap
// away, so this one builds a REAL editor with the workbench's extension set
// and pins the behaviour the v2 → v3 move could silently change.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { WorkbenchWikilinkExtension } from './extensions/wikilink-suggestion';
import { createWorkbenchMentionExtension } from './extensions/mention-suggestion';

const noopRenderer = () => ({
    onStart: () => undefined,
    onUpdate: () => undefined,
    onKeyDown: () => false,
    onExit: () => undefined,
});

function markdownOf(editor: Editor): string {
    const storage = editor.storage as unknown as Record<string, { getMarkdown?: () => string }>;
    return storage.markdown?.getMarkdown?.() ?? '';
}

const editors: Editor[] = [];

/** The same extension list `TiptapEditor` builds (renderers stubbed). */
function makeEditor(content: string, onUpdate?: () => void): Editor {
    const editor = new Editor({
        element: document.createElement('div'),
        extensions: [
            StarterKit.configure({
                link: false,
                underline: false,
                trailingNode: false,
                listKeymap: false,
            }),
            Link.configure({ openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer' } }),
            Placeholder.configure({ placeholder: 'Write…' }),
            Typography,
            Markdown.configure({ html: false, breaks: true, transformPastedText: true }),
            WorkbenchWikilinkExtension.configure({ workId: 'w1', render: noopRenderer }),
            createWorkbenchMentionExtension({ workId: 'w1', render: noopRenderer }),
        ],
        content,
        ...(onUpdate ? { onUpdate } : {}),
    });
    editors.push(editor);
    return editor;
}

afterEach(() => {
    while (editors.length) editors.pop()?.destroy();
    vi.restoreAllMocks();
});

describe('Tiptap 3 workbench editor (real, unmocked)', () => {
    it('loads the extension set without a duplicate-extension warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const editor = makeEditor('# Title');
        const names = editor.extensionManager.extensions.map((extension) => extension.name);
        expect(names.filter((name) => name === 'link')).toHaveLength(1);
        // Kept off for v2 parity (see TiptapEditor).
        expect(names).not.toContain('underline');
        expect(names).not.toContain('trailingNode');
        expect(names).toContain('kbWorkbenchMention');
        expect(names).toContain('kbWorkbenchWikilink');
        const tiptapWarnings = warn.mock.calls.filter((call) => String(call[0]).includes('tiptap'));
        expect(tiptapWarnings).toEqual([]);
    });

    it('round-trips markdown through tiptap-markdown 0.9', () => {
        const body = '# Title\n\nSome **bold** and [a link](https://ever.works).\n\n- one\n- two';
        const editor = makeEditor(body);
        expect(markdownOf(editor)).toBe(body);
    });

    it('does not emit an update on load', () => {
        const onUpdate = vi.fn();
        makeEditor('Intro\n\n## Ends with a heading', onUpdate);
        expect(onUpdate).not.toHaveBeenCalled();
    });

    it('swaps the document silently with setContent(…, { emitUpdate: false })', () => {
        const onUpdate = vi.fn();
        const editor = makeEditor('first', onUpdate);
        editor.commands.setContent('second doc', { emitUpdate: false });
        expect(onUpdate).not.toHaveBeenCalled();
        expect(markdownOf(editor)).toBe('second doc');
        editor.commands.setContent('third doc');
        expect(onUpdate).toHaveBeenCalledTimes(1);
    });
});
