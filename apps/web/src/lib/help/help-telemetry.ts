import posthog from 'posthog-js';

/** How the manual was reached (plan §9.1). */
export type HelpOpenSource = 'shortcut' | 'header' | 'sidebar' | 'palette' | 'deep_link' | 'url';

/** Where an article was opened from. */
export type HelpArticleSource =
    | 'browse'
    | 'on_this_screen'
    | 'search'
    | 'related'
    | 'article_link'
    | 'deep_link'
    | 'url';

/** The kind of surface a help link sits on. */
export type HelpLinkSurface = 'empty_state' | 'error_banner' | 'attention_item';

/**
 * The manual's analytics events. Every property is an identifier, an enum or a
 * boolean — never a query, a note, article text or a workspace identifier
 * (spec FR-19, FR-37). The union is closed so a free-text property cannot be
 * added without changing this type.
 */
export type HelpTelemetryEvent =
    | { name: 'help_opened'; properties: { source: HelpOpenSource; route_group: string } }
    | {
          name: 'help_article_opened';
          properties: {
              article_id: string;
              section: string;
              source: HelpArticleSource;
              via_heading: boolean;
          };
      }
    | {
          name: 'help_deep_link_followed';
          properties: { target: string; surface: HelpLinkSurface };
      };

/** First path segment of a dashboard pathname — coarse enough to carry no identifier. */
export function helpRouteGroup(pathname: string | null | undefined): string {
    const first = (pathname ?? '').split(/[?#]/)[0].split('/').filter(Boolean)[0];
    if (!first) return 'home';
    return /^[a-z][a-z-]{0,31}$/.test(first) ? first : 'other';
}

/** Capture one manual event through the already-mounted analytics client. Never throws. */
export function captureHelpEvent(event: HelpTelemetryEvent): void {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
    try {
        posthog.capture(event.name, event.properties);
    } catch {
        // Analytics must never break reading the manual.
    }
}
