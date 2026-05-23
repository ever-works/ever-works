import { Extension, type Range } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import type { KbDocumentDto } from '@ever-works/contracts';

/**
 * EW-641 Phase 1B/d row 17 — `@mention` picker.
 *
 * Sibling of row 16b's wikilink extension. Uses the same
 * `@tiptap/suggestion` primitive but with the simpler single-char `@`
 * trigger — the upstream's default `findSuggestionMatch` handles it
 * natively, so we don't override it.
 *
 * Item kinds:
 *  - **doc** — a KB document. Insert syntax: `@kb:<path> `
 *  - **agent** — a pipeline / AI agent. Insert syntax: `@agent:<id> `
 *
 * For this first cut only docs are populated — the agent endpoint
 * isn't shipped yet (see row 17b in the handoff). The popover still
 * renders an empty Agents section so the wire format + selectors are
 * already locked for Playwright A12-A17.
 */

export type MentionDoc = Pick<KbDocumentDto, 'id' | 'path' | 'title' | 'class'> & {
    kind: 'doc';
};
export interface MentionAgent {
    id: string;
    name: string;
    kind: 'agent';
}
export type MentionItem = MentionDoc | MentionAgent;

export interface MentionRenderProps {
    items: MentionItem[];
    command: (item: MentionItem) => void;
    clientRect: (() => DOMRect | null) | null;
    query: string;
}

export interface MentionRenderer {
    onStart: (props: MentionRenderProps) => void;
    onUpdate: (props: MentionRenderProps) => void;
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
    onExit: () => void;
}

interface MentionOptions {
    workId: string;
    render: () => MentionRenderer;
    searchEndpoint?: (workId: string, query: string) => string;
    /**
     * Overridable agent fetcher — defaults to an empty list. Row 17b
     * will swap this for a real `/api/works/:id/agents` call once the
     * endpoint exists.
     */
    fetchAgents?: (workId: string, query: string) => Promise<MentionAgent[]>;
}

export const MENTION_PLUGIN_KEY = new PluginKey('kb-mention-suggestion');

export const MentionExtension = Extension.create<MentionOptions>({
    name: 'kbMention',

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
                )}&limit=8`,
            fetchAgents: async () => [],
        };
    },

    addProseMirrorPlugins() {
        const options = this.options;
        const suggestionOptions: SuggestionOptions<MentionItem> = {
            editor: this.editor,
            pluginKey: MENTION_PLUGIN_KEY,
            char: '@',
            // Don't trigger inside email addresses / handles already
            // adjacent to a word boundary.
            allowedPrefixes: [' ', '\n'],
            startOfLine: false,
            items: async ({ query }) => {
                const trimmed = query.trim();
                if (trimmed.length === 0) return [];
                try {
                    const [docResults, agentResults] = await Promise.all([
                        fetch(options.searchEndpoint!(options.workId, trimmed), {
                            cache: 'no-store',
                        })
                            .then((r) => (r.ok ? r.json() : { items: [] }))
                            .then((json: { items?: Array<Omit<MentionDoc, 'kind'>> }) =>
                                (json.items ?? []).map(
                                    (doc): MentionDoc => ({ ...doc, kind: 'doc' }),
                                ),
                            )
                            .catch(() => [] as MentionDoc[]),
                        options.fetchAgents!(options.workId, trimmed).catch(
                            () => [] as MentionAgent[],
                        ),
                    ]);
                    // Docs first, then agents — the popover renders them
                    // as two sections but the flat list keeps the
                    // suggestion plugin's index math simple.
                    return [...docResults.slice(0, 8), ...agentResults.slice(0, 8)];
                } catch {
                    return [];
                }
            },
            command: ({ editor, range, props }) => {
                const replacement =
                    props.kind === 'doc' ? `@kb:${props.path} ` : `@agent:${props.id} `;
                editor
                    .chain()
                    .focus()
                    .insertContentAt({ from: range.from, to: range.to } as Range, replacement)
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
