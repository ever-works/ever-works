import { Extension, type Range } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import type { KbDocumentDto } from '@ever-works/contracts';

/**
 * EW-641 Phase 1B/d row 16b — wikilink autocomplete extension.
 *
 * Behaviour (matches the rendering side shipped in row 16a):
 *   1. Operator types `[[` followed by some query characters.
 *   2. A popover lists matching docs from the row-15 search proxy.
 *   3. Enter or click commits: `[[query` is replaced with
 *      `[[Title|path]] ` (closing brackets + trailing space included).
 *
 * The renderer is supplied by `KbEditor` via the `render` option — this
 * extension stays UI-agnostic so the same primitive can host different
 * pickers (the row-17 `@`-mention picker reuses the shape).
 *
 * The default `@tiptap/suggestion` matcher is single-char (`@`, `#`).
 * For our 2-char `[[` trigger we override `findSuggestionMatch` with a
 * regex anchored at the cursor that captures everything between `[[`
 * and the cursor, refusing to cross `]` or `\n` or `[` (so nested
 * wikilinks don't confuse the matcher).
 */

export type WikiLinkSuggestionItem = Pick<KbDocumentDto, 'id' | 'path' | 'title' | 'class'>;

/**
 * Shape passed to the renderer's `onStart`/`onUpdate`. Mirrors the
 * subset of `@tiptap/suggestion`'s render API we actually use, so the
 * `WikiLinkSuggestionList` component doesn't have to depend on the
 * upstream's evolving types.
 */
export interface WikiLinkRenderProps {
    items: WikiLinkSuggestionItem[];
    command: (item: WikiLinkSuggestionItem) => void;
    clientRect: (() => DOMRect | null) | null;
    query: string;
}

export interface WikiLinkRenderer {
    onStart: (props: WikiLinkRenderProps) => void;
    onUpdate: (props: WikiLinkRenderProps) => void;
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
    onExit: () => void;
}

interface WikiLinkOptions {
    workId: string;
    render: () => WikiLinkRenderer;
    /** Override the search endpoint (used by the unit spec). */
    searchEndpoint?: (workId: string, query: string) => string;
}

export const WIKILINK_PLUGIN_KEY = new PluginKey('kb-wikilink-suggestion');

export const WikiLinkExtension = Extension.create<WikiLinkOptions>({
    name: 'kbWikiLink',

    addOptions() {
        return {
            workId: '',
            render: () => ({
                onStart: () => undefined,
                onUpdate: () => undefined,
                onKeyDown: () => false,
                onExit: () => undefined,
            }),
            searchEndpoint: (workId, query) =>
                `/api/works/${encodeURIComponent(workId)}/kb/search?q=${encodeURIComponent(
                    query,
                )}&limit=10`,
        };
    },

    addProseMirrorPlugins() {
        const options = this.options;
        const suggestionOptions: SuggestionOptions<WikiLinkSuggestionItem> = {
            editor: this.editor,
            pluginKey: WIKILINK_PLUGIN_KEY,
            // `char` is required by the upstream's types but our custom
            // matcher below ignores it.
            char: '[[',
            allowSpaces: true,
            startOfLine: false,
            findSuggestionMatch: ({ $position }) => {
                // Scan backwards from cursor to start of paragraph.
                const text = $position.parent.textBetween(0, $position.parentOffset, '\n', '\0');
                const match = /\[\[([^\]\n[]*)$/.exec(text);
                if (!match) return null;
                const paragraphStart = $position.start();
                const from = paragraphStart + match.index;
                const to = $position.pos;
                return {
                    range: { from, to } as Range,
                    query: match[1],
                    text: match[0],
                };
            },
            items: async ({ query }) => {
                if (query.trim().length < 1) return [];
                try {
                    const response = await fetch(
                        options.searchEndpoint!(options.workId, query.trim()),
                        { cache: 'no-store' },
                    );
                    if (!response.ok) return [];
                    const json = (await response.json()) as {
                        items?: WikiLinkSuggestionItem[];
                    };
                    return (json.items ?? []).slice(0, 10);
                } catch {
                    return [];
                }
            },
            command: ({ editor, range, props }) => {
                const label = props.title || props.path.replace(/\.md$/i, '');
                const replacement = `[[${label}|${props.path}]] `;
                editor
                    .chain()
                    .focus()
                    .insertContentAt({ from: range.from, to: range.to }, replacement)
                    .run();
            },
            render: () => {
                const renderer = options.render();
                return {
                    onStart: (props) => {
                        renderer.onStart({
                            items: props.items,
                            command: (item) => props.command(item),
                            clientRect: props.clientRect ?? null,
                            query: props.query,
                        });
                    },
                    onUpdate: (props) => {
                        renderer.onUpdate({
                            items: props.items,
                            command: (item) => props.command(item),
                            clientRect: props.clientRect ?? null,
                            query: props.query,
                        });
                    },
                    onKeyDown: (props) => renderer.onKeyDown({ event: props.event }),
                    onExit: () => renderer.onExit(),
                };
            },
        };

        return [Suggestion(suggestionOptions)];
    },
});
