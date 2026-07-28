import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import type {
    BrowserAutomationFacadeService,
    BrowserReadResult,
} from './browser-automation.facade';

/**
 * Browser-automation chat tool (audit item G22) — the reachable end of the
 * `browser-automation` capability.
 *
 * Keyword slots: "open this page", "read that URL", "what does <site> say",
 * "grab the text/links from …" route here.
 *
 * Deliberately ONE tool, and a read-only one. `act` (click/fill/press)
 * exists on the capability but is not offered to the model: driving a page
 * on the user's behalf can submit forms and trip irreversible actions, and
 * that needs its own confirmation design rather than arriving as a side
 * effect of exposing browsing. Screenshot capture is likewise left to the
 * existing `screenshot` capability, which already has a facade, budget
 * accounting and a UI.
 *
 * Mirrors `fleet/agent-fleet-tools.ts`: a descriptor factory over a
 * type-only import, concatenated by `resolveAllowedTools`.
 */

export interface BrowseUrlArgs {
    /** Absolute http(s) URL. Refused unless the operator allowlisted its host. */
    url?: string;
    /** Optional CSS selector; omitted reads the whole document. */
    selector?: string;
    /** `text` (default), `html`, or `attribute`. */
    format?: string;
    /** Attribute name — required when `format` is `attribute`. */
    attribute?: string;
    /** Max matched nodes to return (default 20, capped at 100). */
    limit?: number;
}

const VALID_FORMATS = ['text', 'html', 'attribute'] as const;
type BrowseFormat = (typeof VALID_FORMATS)[number];

export interface BrowseUrlResult {
    page?: BrowserReadResult;
    error?: string;
}

export function buildBrowserTools(args: {
    /** Owner scope — settings and provider resolution run as this user. */
    userId: string;
    facade: Pick<BrowserAutomationFacadeService, 'read'>;
}): TaskToolDescriptor[] {
    return [
        {
            name: 'browse_url',
            description:
                'Open a web page in a headless browser and read it — the final URL after redirects, the page title, and the text/HTML/attributes matched by an optional CSS selector. Use for pages that need JavaScript to render, where a plain fetch returns an empty shell. Navigation is restricted to an operator-configured host allowlist, so a refusal means the host is not allowed, not that the page is down. Read-only: this cannot click, type or submit anything.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'Absolute http(s) URL to open.',
                    },
                    selector: {
                        type: 'string',
                        description: 'Optional CSS selector. Omit to read the whole document.',
                    },
                    format: {
                        type: 'string',
                        description:
                            'What to read from each match: text (default), html, or attribute.',
                    },
                    attribute: {
                        type: 'string',
                        description:
                            'Attribute name to read. Required when format is "attribute" (e.g. "href").',
                    },
                    limit: {
                        type: 'integer',
                        description: 'Max matched nodes to return (default 20, capped at 100).',
                    },
                },
                required: ['url'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as BrowseUrlArgs;
                const url = typeof a.url === 'string' ? a.url.trim() : '';
                if (!url) {
                    return { error: 'url is required' };
                }
                // Scheme check here is a usability guard, not the security
                // boundary — the provider's allowlist and SSRF guard are.
                // It exists so `file:///etc/passwd` comes back as a clear
                // refusal instead of a provider stack trace.
                if (!/^https?:\/\//i.test(url)) {
                    return { error: 'url must be an absolute http(s) URL' };
                }

                const format: BrowseFormat = (VALID_FORMATS as readonly string[]).includes(
                    a.format ?? '',
                )
                    ? (a.format as BrowseFormat)
                    : 'text';
                if (format === 'attribute' && !a.attribute) {
                    return { error: 'attribute is required when format is "attribute"' };
                }

                const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);

                try {
                    const page = await args.facade.read(
                        {
                            url,
                            query: {
                                selector: a.selector,
                                format,
                                attribute: a.attribute,
                                limit,
                            },
                        },
                        { userId: args.userId },
                    );
                    return { page };
                } catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        } satisfies TaskToolDescriptor<BrowseUrlArgs, BrowseUrlResult>,
    ];
}
