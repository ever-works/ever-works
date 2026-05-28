import { describe, it, expect } from 'vitest';
import { renderTemplate, listTemplates } from './render.js';

describe('email-templates renderTemplate', () => {
	it('lists the registered templates', () => {
		expect(listTemplates().sort()).toEqual(['agent-message', 'agent-summary']);
	});

	it('renders agent-summary to HTML + a plain-text fallback', async () => {
		const { html, text } = await renderTemplate('agent-summary', {
			agentName: 'Atlas',
			summary: 'Closed 3 tasks.',
			taskCount: 3,
			dashboardUrl: 'https://app.ever.works/agents/atlas'
		});
		expect(html).toContain('<!DOCTYPE html');
		expect(html).toContain('Atlas');
		expect(html).toContain('3 tasks processed');
		expect(html).toContain('https://app.ever.works/agents/atlas');
		// Plain-text fallback is not HTML.
		expect(text).toContain('Atlas');
		expect(text).not.toContain('<body');
	});

	it('renders agent-message and includes the CTA only when contextUrl is set', async () => {
		const withCta = await renderTemplate('agent-message', {
			fromAgent: 'Atlas',
			toAgent: 'Nova',
			subject: 'Handoff',
			body: 'Please continue.',
			contextUrl: 'https://app.ever.works/tasks/1'
		});
		expect(withCta.html).toContain('Handoff');
		expect(withCta.html).toContain('https://app.ever.works/tasks/1');

		const withoutCta = await renderTemplate('agent-message', {
			fromAgent: 'Atlas',
			toAgent: 'Nova',
			subject: 'FYI',
			body: 'No action needed.'
		});
		expect(withoutCta.html).not.toContain('Open in dashboard');
	});

	it('throws on an unknown template slug', async () => {
		await expect(renderTemplate('nope', {})).rejects.toThrow(/Unknown email template: nope/);
	});
});
