import { Extension, type Range } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import type { KbDocumentDto } from '@ever-works/contracts';

/**
 * EW-641 slice B — workbench wikilink autocomplete.
 *
 * Sibling of the slice-A `kb-wikilink-suggestion` plugin shipped in
 * `components/works/detail/kb/extensions/WikiLinkExtension.ts`.
 *
 * Behaviour:
 *  1. Operator types `[[` followed by a query.
 *  2. A popover lists matching docs from the same search proxy slice A
 *     already uses (`/api/works/:id/kb/search?q=&limit=10`).
 *  3. Enter / click commits: the `[[query` trigger text is wiped and an
 *     inline anchor + space are inserted via Tiptap's built-in Link mark.
 *     `href` points to the new workbench URL
 *     (`/works/{workId}/kb/{doc.path}`), display text = the doc title.
 *  4. The closing `]]` characters are intentionally NOT inserted — slice
 *     B switches the wire format from `[[title|path]] ` to a proper
 *     anchor so the round-trip serializer (`tiptap-markdown`) emits
 *     `[Title](/works/…/kb/…)` instead of raw wikilink syntax.
 *
 * Renderer is supplied by `TiptapEditor` via the `render` option, so the
 * extension stays UI-agnostic and matches the wider pattern in this
 * codebase. The custom 2-char `[[` matcher mirrors the slice-A regex.
 */

export type WikilinkSuggestionItem = Pick<KbDocumentDto, 'id' | 'path' | 'title' | 'class'>;

export interface WikilinkSuggestionRenderProps {
    items: WikilinkSuggestionItem[];
    command: (item: WikilinkSuggestionItem) => void;
    clientRect: (() => DOMRect | null) | null;
    query: string;
    loading: boolean;
}

export interface WikilinkSuggestionRenderer {
    onStart: (props: WikilinkSuggestionRenderProps) => void;
    onUpdate: (props: WikilinkSuggestionRenderProps) => void;
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
    onExit: () => void;
}

export interface WikilinkSuggestionOptions {
    workId: string;
    render: () => WikilinkSuggestionRenderer;
    /** Override for tests — defaults to the slice-A /api/works/:id/kb/search proxy. */
    searchEndpoint?: (workId: string, query: string) => string;
    /** Build the href baked into the inserted link. Defaults to `/works/{workId}/kb/{path}`. */
    buildHref?: (workId: string, doc: WikilinkSuggestionItem) => string;
}

export const WORKBENCH_WIKILINK_PLUGIN_KEY = new PluginKey('kb-workbench-wikilink-suggestion');

export const WorkbenchWikilinkExtension = Extension.create<WikilinkSuggestionOptions>({
    name: 'kbWorkbenchWikilink',

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
            buildHref: (workId, doc) =>
                `/works/${encodeURIComponent(workId)}/kb/${doc.path
                    .split('/')
                    .map(encodeURIComponent)
                    .join('/')}`,
        };
    },

    addProseMirrorPlugins() {
        const options = this.options;
        const suggestionOptions: SuggestionOptions<WikilinkSuggestionItem> = {
            editor: this.editor,
            pluginKey: WORKBENCH_WIKILINK_PLUGIN_KEY,
            // Required by the upstream's types; the custom matcher below ignores it.
            char: '[[',
            allowSpaces: true,
            startOfLine: false,
            findSuggestionMatch: ({ $position }) => {
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
                        items?: WikilinkSuggestionItem[];
                    };
                    return (json.items ?? []).slice(0, 10);
                } catch {
                    return [];
                }
            },
            command: ({ editor, range, props }) => {
                const label = props.title || props.path.replace(/\.md$/i, '');
                const href = options.buildHref!(options.workId, props);
                // Wipe the `[[query` trigger, then insert an inline link
                // node with the doc title as the visible text. Trailing
                // space stops the link mark from absorbing further typing.
                editor
                    .chain()
                    .focus()
                    .deleteRange({ from: range.from, to: range.to })
                    .insertContentAt(range.from, [
                        {
                            type: 'text',
                            text: label,
                            marks: [
                                {
                                    type: 'link',
                                    attrs: {
                                        href,
                                        'data-kb-doc-id': props.id,
                                        'data-kb-doc-path': props.path,
                                    },
                                },
                            ],
                        },
                        { type: 'text', text: ' ' },
                    ])
                    .run();
            },
            render: () => {
                const renderer = options.render();
                let lastQuery = '';
                return {
                    onStart: (props) => {
                        lastQuery = props.query;
                        renderer.onStart({
                            items: props.items,
                            command: (item) => props.command(item),
                            clientRect: props.clientRect ?? null,
                            query: props.query,
                            // First paint is loading whenever the user has
                            // typed something — the items array starts empty
                            // until the upstream fetch resolves.
                            loading: props.query.trim().length > 0 && props.items.length === 0,
                        });
                    },
                    onUpdate: (props) => {
                        const queryChanged = props.query !== lastQuery;
                        lastQuery = props.query;
                        renderer.onUpdate({
                            items: props.items,
                            command: (item) => props.command(item),
                            clientRect: props.clientRect ?? null,
                            query: props.query,
                            loading:
                                queryChanged &&
                                props.query.trim().length > 0 &&
                                props.items.length === 0,
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
