import { describe, expect, it } from 'vitest';
import { selectActiveToolNames } from './tool-selection';

// These names exist in the real registries / hand-tool map, so the domain
// lookup resolves them correctly.
const NAMES = [
    'navigate',
    'renderChart',
    'runReport',
    'listWorks',
    'list_agents',
    'pause_agent',
    'list_tasks',
    'create_task',
    'list_notifications',
    'list_webhooks',
];

describe('selectActiveToolNames', () => {
    it('always includes core + works tools', () => {
        const selected = selectActiveToolNames(NAMES, { text: 'hello' });
        expect(selected).toContain('navigate'); // core
        expect(selected).toContain('renderChart'); // core
        expect(selected).toContain('runReport'); // core
        expect(selected).toContain('listWorks'); // works (always-on domain)
    });

    it('pulls in a domain mentioned in the message', () => {
        const selected = selectActiveToolNames(NAMES, { text: 'pause my agent please' });
        expect(selected).toContain('list_agents');
        expect(selected).toContain('pause_agent');
    });

    it('excludes domains not referenced by message or page', () => {
        const selected = selectActiveToolNames(NAMES, { text: 'show my works' });
        expect(selected).not.toContain('list_notifications');
        expect(selected).not.toContain('list_webhooks');
    });

    it('matches a domain from the current page url', () => {
        const selected = selectActiveToolNames(NAMES, {
            text: 'open it',
            pageUrl: '/dashboard/agents/abc-123',
        });
        expect(selected).toContain('pause_agent');
    });

    it('never exceeds the cap', () => {
        const many = Array.from({ length: 300 }, (_, i) => `unknown_tool_${i}`);
        const selected = selectActiveToolNames(many, {
            text: 'agent task plugin webhook',
            cap: 12,
        });
        expect(selected.length).toBeLessThanOrEqual(12);
    });
});
