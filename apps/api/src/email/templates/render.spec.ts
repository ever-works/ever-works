import { renderTemplate, listTemplates } from './render';

describe('email template registry', () => {
    it('lists the two registered templates', () => {
        expect(listTemplates().sort()).toEqual(['agent-message', 'agent-summary']);
    });

    it('renders agent-summary with props interpolated + escapes HTML in user-supplied fields', () => {
        const rendered = renderTemplate('agent-summary', {
            agentName: 'PM <Bot>',
            summary: 'Closed 3 tasks; opened 1 follow-up.',
            taskCount: 4,
            dashboardUrl: 'https://app.ever.works/agents/pm',
        });
        expect(rendered.html).toContain('PM &lt;Bot&gt;');
        expect(rendered.html).toContain('4 tasks processed');
        expect(rendered.text).toContain('Open dashboard: https://app.ever.works/agents/pm');
    });

    it('renders agent-message with optional contextUrl CTA when present', () => {
        const withUrl = renderTemplate('agent-message', {
            fromAgent: 'OrchestratorBot',
            toAgent: 'WriterBot',
            subject: 'Please draft a follow-up',
            body: 'Need a 1-pager on the migration risks.',
            contextUrl: 'https://app.ever.works/tasks/123',
        });
        expect(withUrl.html).toContain('Open in dashboard');
        expect(withUrl.text).toContain('Open in dashboard: https://app.ever.works/tasks/123');

        const noUrl = renderTemplate('agent-message', {
            fromAgent: 'A',
            toAgent: 'B',
            subject: 'fyi',
            body: 'done',
        });
        expect(noUrl.html).not.toContain('Open in dashboard');
        expect(noUrl.text).not.toContain('Open in dashboard');
    });

    it('throws on unknown template slug', () => {
        expect(() => renderTemplate('does-not-exist', {})).toThrow(/Unknown email template/);
    });
});
