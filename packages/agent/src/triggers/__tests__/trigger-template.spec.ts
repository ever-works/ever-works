import {
    findInvalidTemplatePlaceholders,
    renderTriggerTemplate,
    type TriggerTemplateContext,
} from '../trigger-template';

const CONTEXT: TriggerTemplateContext = {
    trigger: { name: 'Deploy watcher' },
    event: {
        id: 'evt-1',
        source: 'github',
        kind: 'github.push',
        title: 'Pushed 3 commits',
        actorName: 'ada',
        sourceUrl: 'https://github.com/acme/widgets/commit/abc',
        occurredAt: new Date('2026-08-14T12:00:00.000Z'),
        workId: 'work-1',
        payload: {
            repoFullName: 'acme/widgets',
            commitCount: 3,
            merged: false,
            routing: { branch: 'main' },
        },
    },
};

describe('renderTriggerTemplate', () => {
    it('substitutes trigger.name, event fields and top-level payload keys', () => {
        const out = renderTriggerTemplate(
            '{{trigger.name}}: {{event.kind}} on {{event.payload.repoFullName}} ({{event.payload.commitCount}})',
            CONTEXT,
        );
        expect(out).toBe('Deploy watcher: github.push on acme/widgets (3)');
    });

    it('renders dates as ISO strings, booleans/numbers via String, objects via JSON', () => {
        expect(renderTriggerTemplate('{{event.occurredAt}}', CONTEXT)).toBe(
            '2026-08-14T12:00:00.000Z',
        );
        expect(renderTriggerTemplate('{{event.payload.merged}}', CONTEXT)).toBe('false');
        expect(renderTriggerTemplate('{{event.payload.routing}}', CONTEXT)).toBe(
            '{"branch":"main"}',
        );
    });

    it('well-formed but ABSENT values render as empty string', () => {
        expect(renderTriggerTemplate('[{{event.payload.nope}}]', CONTEXT)).toBe('[]');
        expect(
            renderTriggerTemplate('[{{event.title}}]', {
                trigger: { name: 'X' },
                event: { source: 'github', kind: 'github.push' },
            }),
        ).toBe('[]');
        // No event at all (webhook context without payload) — same rule.
        expect(renderTriggerTemplate('[{{event.kind}}]', { trigger: { name: 'X' } })).toBe('[]');
    });

    it('leaves MALFORMED placeholders verbatim (rejected at save time, visible at fire time)', () => {
        expect(renderTriggerTemplate('{{event.__proto__}} {{bogus.path}}', CONTEXT)).toBe(
            '{{event.__proto__}} {{bogus.path}}',
        );
    });

    it('is single-pass: substituted values are never re-expanded (no injection)', () => {
        const context: TriggerTemplateContext = {
            trigger: { name: 'X' },
            event: {
                source: 'github',
                kind: 'github.push',
                title: '{{event.payload.secret}}',
                payload: { secret: 'MUST-NOT-APPEAR' },
            },
        };
        expect(renderTriggerTemplate('{{event.title}}', context)).toBe('{{event.payload.secret}}');
    });

    it('never reaches into nested payload objects or prototype chains', () => {
        expect(findInvalidTemplatePlaceholders('{{event.payload.routing.branch}}')).toEqual([
            '{{event.payload.routing.branch}}',
        ]);
        expect(renderTriggerTemplate('[{{event.payload.constructor}}]', CONTEXT)).toBe('[]');
    });

    it('caps a single substituted value at 500 chars', () => {
        const context: TriggerTemplateContext = {
            trigger: { name: 'X' },
            event: { source: 's', kind: 'k', payload: { big: 'x'.repeat(2000) } },
        };
        expect(renderTriggerTemplate('{{event.payload.big}}', context)).toHaveLength(500);
    });
});

describe('findInvalidTemplatePlaceholders', () => {
    it('accepts the whole allowed grammar', () => {
        expect(
            findInvalidTemplatePlaceholders(
                '{{trigger.name}} {{event.kind}} {{ event.title }} {{event.payload.repo_full-name}}',
            ),
        ).toEqual([]);
    });

    it('flags unknown roots, unknown event fields, and nested payload paths', () => {
        expect(
            findInvalidTemplatePlaceholders(
                '{{user.email}} {{event.secretEncrypted}} {{event.payload.a.b}} {{event.kind}}',
            ),
        ).toEqual(['{{user.email}}', '{{event.secretEncrypted}}', '{{event.payload.a.b}}']);
    });

    it('flags empty placeholders and deduplicates repeats', () => {
        expect(findInvalidTemplatePlaceholders('{{}} {{}} {{ }}')).toEqual(['{{}}', '{{ }}']);
    });

    it('ignores single-brace legacy {name} and plain text', () => {
        expect(findInvalidTemplatePlaceholders('Trigger: {name} fired!')).toEqual([]);
    });
});
