import type { ReactElement } from 'react';
import { render } from '@react-email/render';
import { AgentSummaryEmail, type AgentSummaryTemplateProps } from './components/agent-summary.js';
import { AgentMessageEmail, type AgentMessageTemplateProps } from './components/agent-message.js';

export interface RenderedEmail {
	readonly html: string;
	readonly text: string;
}

/**
 * Slug → React-Email element factory. Adding a template is two lines:
 * import the component + add an entry here.
 */
const REGISTRY: Record<string, (props: never) => ReactElement> = {
	'agent-summary': (props: AgentSummaryTemplateProps) => AgentSummaryEmail(props),
	'agent-message': (props: AgentMessageTemplateProps) => AgentMessageEmail(props)
} as Record<string, (props: never) => ReactElement>;

/**
 * Render a registered React-Email template to its canonical
 * `{ html, text }` pair. The HTML is the cross-client email body; the
 * text is the plain-text fallback (`render(..., { plainText: true })`).
 *
 * Rendering is server-side and ahead-of-send: email clients display a
 * finished HTML string, so the body MUST be fully rendered before the
 * provider plugin ships it.
 */
export async function renderTemplate<TProps>(slug: string, props: TProps): Promise<RenderedEmail> {
	const factory = REGISTRY[slug];
	if (!factory) {
		throw new Error(`Unknown email template: ${slug}`);
	}
	const element = factory(props as never);
	const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
	return { html, text };
}

export function listTemplates(): string[] {
	return Object.keys(REGISTRY);
}

export type { AgentSummaryTemplateProps, AgentMessageTemplateProps };
