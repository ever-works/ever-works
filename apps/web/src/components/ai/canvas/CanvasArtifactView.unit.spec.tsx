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
});
