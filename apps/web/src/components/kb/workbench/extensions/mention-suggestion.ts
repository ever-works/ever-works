import Mention from '@tiptap/extension-mention';
import { PluginKey } from '@tiptap/pm/state';
import type { KbDocumentDto } from '@ever-works/contracts';

/**
 * EW-641 slice B — workbench `@mention` picker.
 *
 * Built on top of `@tiptap/extension-mention` so the inserted nodes are
 * proper Tiptap Mention nodes (atomic, draggable, serialisable) rather
 * than the slice-A flat-text format. Each node carries:
 *
 *  - `id`     — doc id or agent id
 *  - `label`  — display text (`Brand voice`, `Anthropic agent`, …)
 *  - `kind`   — `'doc' | 'agent'`
 *
 * The HTMLAttributes hook renders them as a coloured pill via the
 * `data-kb-mention-kind` attribute so the chip styling can be CSS-driven
 * without an extra ReactNodeView.
 *
 * The two upstream fetchers (`/api/works/:id/kb/documents?q=&limit=10`
 * for docs and `/api/works/:id/agents?q=&limit=10` for agents) are
 * exposed as options so tests can stub them without intercepting `fetch`.
 */

export interface MentionDocItem {
    id: string;
    label: string;
    kind: 'doc';
    path: string;
    class: KbDocumentDto['class'];
}
export interface MentionAgentItem {
    id: string;
    label: string;
    kind: 'agent';
}
export type MentionSuggestionItem = MentionDocItem | MentionAgentItem;

export interface MentionSuggestionRenderProps {
    items: MentionSuggestionItem[];
    command: (item: MentionSuggestionItem) => void;
    clientRect: (() => DOMRect | null) | null;
    query: string;
    loading: boolean;
}

export interface MentionSuggestionRenderer {
    onStart: (props: MentionSuggestionRenderProps) => void;
    onUpdate: (props: MentionSuggestionRenderProps) => void;
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
    onExit: () => void;
}

export interface MentionSuggestionOptions {
    workId: string;
    render: () => MentionSuggestionRenderer;
    /** Override for tests. Defaults to the slice-A kb/search proxy. */
    fetchDocs?: (workId: string, query: string) => Promise<MentionDocItem[]>;
    /** Override for tests. Defaults to /api/works/:id/agents. */
    fetchAgents?: (workId: string, query: string) => Promise<MentionAgentItem[]>;
}

export const WORKBENCH_MENTION_PLUGIN_KEY = new PluginKey('kb-workbench-mention-suggestion');

async function defaultFetchDocs(workId: string, query: string): Promise<MentionDocItem[]> {
    try {
        const params = new URLSearchParams({ q: query, limit: '10' });
        const response = await fetch(
            `/api/works/${encodeURIComponent(workId)}/kb/search?${params.toString()}`,
            { cache: 'no-store' },
        );
        if (!response.ok) return [];
        const json = (await response.json()) as {
            items?: Array<Pick<KbDocumentDto, 'id' | 'title' | 'path' | 'class'>>;
        };
        return (json.items ?? []).slice(0, 10).map(
            (doc): MentionDocItem => ({
                id: doc.id,
                label: doc.title || doc.path,
                kind: 'doc',
                path: doc.path,
                class: doc.class,
            }),
        );
    } catch {
        return [];
    }
}

async function defaultFetchAgents(workId: string, query: string): Promise<MentionAgentItem[]> {
    try {
        const params = new URLSearchParams({ q: query, limit: '10' });
        const response = await fetch(
            `/api/works/${encodeURIComponent(workId)}/agents?${params.toString()}`,
            { cache: 'no-store' },
        );
        if (!response.ok) return [];
        const json = (await response.json()) as {
            items?: Array<{ id: string; name?: string }>;
        };
        return (json.items ?? []).slice(0, 10).map(
            (row): MentionAgentItem => ({
                id: row.id,
                label: row.name || row.id,
                kind: 'agent',
            }),
        );
    } catch {
        return [];
    }
}

/**
 * Build a configured workbench Mention extension. Returning a factory
 * (rather than a plain extension) lets `TiptapEditor` pass per-instance
 * options (workId, fetchers, renderer) without colliding with the
 * upstream extension's option registry — calling `Mention.configure`
 * directly here would mutate the singleton.
 */
export function createWorkbenchMentionExtension(options: MentionSuggestionOptions) {
    const fetchDocs = options.fetchDocs ?? defaultFetchDocs;
    const fetchAgents = options.fetchAgents ?? defaultFetchAgents;

    // Build the `suggestion` config as `unknown` first — the upstream
    // Mention plugin types it against a fixed `MentionNodeAttrs` shape,
    // but we widen the attrs to include `kind` (doc/agent) so the
    // popover can branch on the row type. Casting at the boundary is
    // the standing pattern Tiptap docs recommend when extending Mention.
    const suggestion = {
        char: '@',
        pluginKey: WORKBENCH_MENTION_PLUGIN_KEY,
        allowedPrefixes: [' ', '\n'],
        startOfLine: false,
        items: async ({ query }: { query: string }) => {
            const trimmed = query.trim();
            if (trimmed.length === 0) return [];
            const [docs, agents] = await Promise.all([
                fetchDocs(options.workId, trimmed).catch(() => [] as MentionDocItem[]),
                fetchAgents(options.workId, trimmed).catch(() => [] as MentionAgentItem[]),
            ]);
            return [...docs.slice(0, 10), ...agents.slice(0, 10)];
        },
        command: ({
            editor,
            range,
            props,
        }: {
            editor: import('@tiptap/react').Editor;
            range: { from: number; to: number };
            props: MentionSuggestionItem;
        }) => {
            editor
                .chain()
                .focus()
                .insertContentAt(range, [
                    {
                        type: 'kbWorkbenchMention',
                        attrs: { id: props.id, label: props.label, kind: props.kind },
                    },
                    { type: 'text', text: ' ' },
                ])
                .run();
        },
        render: () => {
            const renderer = options.render();
            let lastQuery = '';
            return {
                onStart: (props: {
                    items: MentionSuggestionItem[];
                    command: (item: MentionSuggestionItem) => void;
                    clientRect: (() => DOMRect | null) | null;
                    query: string;
                }) => {
                    lastQuery = props.query;
                    renderer.onStart({
                        items: props.items,
                        command: props.command,
                        clientRect: props.clientRect ?? null,
                        query: props.query,
                        loading: props.query.trim().length > 0 && props.items.length === 0,
                    });
                },
                onUpdate: (props: {
                    items: MentionSuggestionItem[];
                    command: (item: MentionSuggestionItem) => void;
                    clientRect: (() => DOMRect | null) | null;
                    query: string;
                }) => {
                    const queryChanged = props.query !== lastQuery;
                    lastQuery = props.query;
                    renderer.onUpdate({
                        items: props.items,
                        command: props.command,
                        clientRect: props.clientRect ?? null,
                        query: props.query,
                        loading:
                            queryChanged &&
                            props.query.trim().length > 0 &&
                            props.items.length === 0,
                    });
                },
                onKeyDown: (props: { event: KeyboardEvent }) =>
                    renderer.onKeyDown({ event: props.event }),
                onExit: () => renderer.onExit(),
            };
        },
    } as unknown as Parameters<typeof Mention.configure>[0] extends infer T
        ? T extends { suggestion?: infer S }
            ? S
            : never
        : never;

    return Mention.extend({
        name: 'kbWorkbenchMention',
        addAttributes() {
            return {
                id: { default: null },
                label: { default: null },
                kind: { default: 'doc' as MentionSuggestionItem['kind'] },
            };
        },
    }).configure({
        HTMLAttributes: {
            // Coloured pill — the chip styling itself is owned by the
            // editor's prose CSS (data-kb-mention-kind="doc|agent").
            class: 'kb-mention-chip',
        },
        renderText({ node }) {
            const { kind, id } = node.attrs as {
                kind: MentionSuggestionItem['kind'];
                id: string;
            };
            // Wire format for the round-trip via tiptap-markdown — mirrors
            // the slice-A `@kb:path` / `@agent:id` token shapes so a saved
            // Markdown body re-renders the same way on the next mount.
            return kind === 'doc' ? `@kb:${id}` : `@agent:${id}`;
        },
        suggestion,
    });
}
