import {
    renderAgentSummary,
    type AgentSummaryTemplateProps,
    type RenderedEmail,
} from './react/agent-summary.template.js';
import {
    renderAgentMessage,
    type AgentMessageTemplateProps,
} from './react/agent-message.template.js';

/**
 * EW-650 / EW-668 / T16 — Template registry.
 *
 * Keyed lookup so the EmailFacadeService (and the future composer UI)
 * can render any registered template by slug + props. The current
 * implementation uses pure TypeScript template functions; a follow-up
 * will swap the function bodies to React-Email TSX rendered via
 * `@react-email/render` once the deps install lands. The slug-based
 * registry shape stays the same — callers won't change.
 *
 * See spec §11.1.
 */

export type EmailTemplateRenderer<TProps = unknown> = (props: TProps) => RenderedEmail;

const REGISTRY: Record<string, EmailTemplateRenderer<any>> = {
    'agent-summary': renderAgentSummary as EmailTemplateRenderer,
    'agent-message': renderAgentMessage as EmailTemplateRenderer,
};

export function renderTemplate<TProps>(slug: string, props: TProps): RenderedEmail {
    const renderer = REGISTRY[slug];
    if (!renderer) {
        throw new Error(`Unknown email template: ${slug}`);
    }
    return renderer(props);
}

export function listTemplates(): string[] {
    return Object.keys(REGISTRY);
}

export type { RenderedEmail, AgentSummaryTemplateProps, AgentMessageTemplateProps };
