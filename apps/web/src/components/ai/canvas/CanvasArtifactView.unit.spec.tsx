import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Avoid pulling ChatMarkdown's markdown stack into the test.
vi.mock('../ChatMarkdown', () => ({
    ChatMarkdown: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

import { CanvasArtifactView } from './CanvasArtifactView';
import type {
    TableArtifact,
    StatArtifact,
    DetailArtifact,
    KanbanArtifact,
    ComponentArtifact,
} from './types';

describe('CanvasArtifactView', () => {
    it('renders a table with headers and cells', () => {
        const artifact: TableArtifact = {
            id: '1',
            kind: 'table',
            title: 'Works',
            columns: [
                { key: 'name', label: 'Name' },
                { key: 'count', label: 'Items' },
            ],
            rows: [{ name: 'Alpha', count: 7 }],
        };
        render(<CanvasArtifactView artifact={artifact} />);
        expect(screen.getByText('Name')).toBeTruthy();
        expect(screen.getByText('Alpha')).toBeTruthy();
        expect(screen.getByText('7')).toBeTruthy();
    });

    it('renders stat tiles', () => {
        const artifact: StatArtifact = {
            id: '1',
            kind: 'stat',
            title: 'Usage',
            stats: [{ label: 'Total spend', value: '$12.34' }],
        };
        render(<CanvasArtifactView artifact={artifact} />);
        expect(screen.getByText('$12.34')).toBeTruthy();
        expect(screen.getByText('Total spend')).toBeTruthy();
    });

    it('renders a detail panel with badges', () => {
        const artifact: DetailArtifact = {
            id: '1',
            kind: 'detail',
            title: 'Agent',
            fields: [{ label: 'Model', value: 'gpt' }],
            badges: [{ label: 'Active', tone: 'success' }],
        };
        render(<CanvasArtifactView artifact={artifact} />);
        expect(screen.getByText('Model')).toBeTruthy();
        expect(screen.getByText('gpt')).toBeTruthy();
        expect(screen.getByText('Active')).toBeTruthy();
    });

    it('renders a kanban board with columns and cards', () => {
        const artifact: KanbanArtifact = {
            id: '1',
            kind: 'kanban',
            title: 'Tasks',
            columns: [{ key: 'draft', label: 'Draft', cards: [{ title: 'Task A' }] }],
        };
        render(<CanvasArtifactView artifact={artifact} />);
        expect(screen.getByText('Draft')).toBeTruthy();
        expect(screen.getByText('Task A')).toBeTruthy();
    });

    it('renders a bespoke progress component', () => {
        const artifact: ComponentArtifact = {
            id: '1',
            kind: 'component',
            title: 'Budget',
            component: 'progress',
            props: { bars: [{ label: 'AI', percent: 42 }] },
        };
        render(<CanvasArtifactView artifact={artifact} />);
        expect(screen.getByText('AI')).toBeTruthy();
        expect(screen.getByText('42%')).toBeTruthy();
    });

    it('renders a bespoke gallery component', () => {
        const artifact: ComponentArtifact = {
            id: '1',
            kind: 'component',
            title: 'Shots',
            component: 'gallery',
            props: { images: ['https://example.com/a.png'] },
        };
        const { container } = render(<CanvasArtifactView artifact={artifact} />);
        expect(container.querySelector('img')?.getAttribute('src')).toBe(
            'https://example.com/a.png',
        );
    });

    // Wave 9/10/18/20 bespoke components — render without crashing + show content.
    const componentCases: Array<{
        component: ComponentArtifact['component'];
        props: Record<string, unknown>;
        expect: string;
    }> = [
        { component: 'gauge', props: { label: 'Cap', percent: 55 }, expect: '55%' },
        {
            component: 'comparison',
            props: {
                left: { title: 'A', fields: [{ label: 'x', value: '1' }] },
                right: { title: 'B', fields: [] },
            },
            expect: 'A',
        },
        {
            component: 'funnel',
            props: { stages: [{ label: 'Visits', value: 100 }] },
            expect: 'Visits',
        },
        {
            component: 'metric_delta',
            props: { metrics: [{ label: 'MRR', value: '$10', delta: 3 }] },
            expect: 'MRR',
        },
        { component: 'donut', props: { segments: [{ label: 'Open', value: 3 }] }, expect: 'Open' },
        { component: 'bars', props: { items: [{ label: 'tasks', value: 5 }] }, expect: 'tasks' },
        { component: 'kpi', props: { label: 'Total', value: 42 }, expect: '42' },
        {
            component: 'steps',
            props: { steps: [{ label: 'Connect git', done: true }] },
            expect: 'Connect git',
        },
        {
            component: 'badges',
            props: { badges: [{ label: 'Active', tone: 'success' }] },
            expect: 'Active',
        },
        {
            component: 'code',
            props: { code: 'const x = 1', language: 'ts' },
            expect: 'const x = 1',
        },
        {
            component: 'heatmap',
            props: { rows: [{ label: 'Mon', values: [1, 2, 3] }] },
            expect: 'Mon',
        },
        { component: 'rating', props: { value: 4, max: 5 }, expect: '4/5' },
    ];
    componentCases.forEach(({ component, props, expect: text }) => {
        it(`renders the "${component}" bespoke component`, () => {
            const artifact: ComponentArtifact = {
                id: '1',
                kind: 'component',
                title: 't',
                component,
                props,
            };
            render(<CanvasArtifactView artifact={artifact} />);
            expect(screen.getByText((c) => c.includes(text))).toBeTruthy();
        });
    });

    // Judgment layer G8s — typed human-in-the-loop payloads rendered by the
    // canvas registry. Props are the contract's `HitlQuestion`/`HitlAnswer`,
    // so these double as a round-trip check through `ComponentArtifact`.
    describe('HITL renderers', () => {
        const hitl = (
            component: 'hitl_question' | 'hitl_answer',
            props: Record<string, unknown>,
        ): ComponentArtifact => ({
            id: '1',
            kind: 'component',
            title: 'Needs you',
            component,
            props,
        });

        it('renders a confirm question with both labels', () => {
            render(
                <CanvasArtifactView
                    artifact={hitl('hitl_question', {
                        id: 'q1',
                        kind: 'confirm',
                        prompt: 'Force-push the branch?',
                        confirmLabel: 'Force-push',
                        cancelLabel: 'Leave it',
                    })}
                />,
            );
            expect(screen.getByText('Force-push the branch?')).toBeTruthy();
            expect(screen.getByText('Force-push')).toBeTruthy();
            expect(screen.getByText('Leave it')).toBeTruthy();
        });

        it('renders every option of a choice question, with descriptions', () => {
            render(
                <CanvasArtifactView
                    artifact={hitl('hitl_question', {
                        id: 'q2',
                        kind: 'choice',
                        prompt: 'Which fix?',
                        context: 'Both are green.',
                        options: [
                            { id: 'revert', label: 'Revert the commit', tone: 'warning' },
                            { id: 'patch', label: 'Patch forward', description: 'Smaller diff' },
                        ],
                    })}
                />,
            );
            expect(screen.getByText('Both are green.')).toBeTruthy();
            expect(screen.getByText('Revert the commit')).toBeTruthy();
            expect(screen.getByText('Patch forward')).toBeTruthy();
            expect(screen.getByText('Smaller diff')).toBeTruthy();
        });

        it('renders an approval question with its action and risks', () => {
            render(
                <CanvasArtifactView
                    artifact={hitl('hitl_question', {
                        id: 'q3',
                        kind: 'approval',
                        prompt: 'May I merge?',
                        action: 'Merge PR #42 into develop',
                        risks: ['Touches billing'],
                    })}
                />,
            );
            expect(screen.getByText('Merge PR #42 into develop')).toBeTruthy();
            expect(screen.getByText('Touches billing')).toBeTruthy();
        });

        it('renders a text question placeholder', () => {
            render(
                <CanvasArtifactView
                    artifact={hitl('hitl_question', {
                        id: 'q4',
                        kind: 'text',
                        prompt: 'Release note?',
                        placeholder: 'One line please',
                    })}
                />,
            );
            expect(screen.getByText('One line please')).toBeTruthy();
        });

        it('degrades visibly on a malformed question payload instead of crashing', () => {
            render(<CanvasArtifactView artifact={hitl('hitl_question', { kind: 'nope' })} />);
            expect(screen.getByText('Unreadable question payload')).toBeTruthy();
        });

        it('renders an approval answer with its note', () => {
            render(
                <CanvasArtifactView
                    artifact={hitl('hitl_answer', {
                        questionId: 'q3',
                        kind: 'approval',
                        decision: 'approved',
                        note: 'Reviewed the diff.',
                    })}
                />,
            );
            expect(screen.getByText('Approved')).toBeTruthy();
            expect(screen.getByText('Reviewed the diff.')).toBeTruthy();
            expect(screen.getByText((c) => c.includes('Answer to q3'))).toBeTruthy();
        });

        it('renders a multi_choice answer as its selected ids', () => {
            render(
                <CanvasArtifactView
                    artifact={hitl('hitl_answer', {
                        questionId: 'q5',
                        kind: 'multi_choice',
                        optionIds: ['unit', 'lint'],
                    })}
                />,
            );
            expect(screen.getByText('unit, lint')).toBeTruthy();
        });

        it('degrades visibly on a malformed answer payload', () => {
            render(<CanvasArtifactView artifact={hitl('hitl_answer', { kind: 'confirm' })} />);
            expect(screen.getByText('Unreadable answer payload')).toBeTruthy();
        });
    });
});
