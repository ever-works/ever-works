import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
    },
}));

const push = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push, refresh: vi.fn() }),
    Link: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
        <a href={href}>{children}</a>
    ),
}));

const createGoalAction = vi.fn();
vi.mock('./actions', () => ({
    createGoalAction: (...args: unknown[]) => createGoalAction(...args),
}));

// Stub the `Select` primitive with a native <select> — the real one is a
// portal-rendered custom listbox, and this spec is about the form's kind
// switch and payload, not the picker's internals (same convention as
// MissionGoalsPanel.unit.spec.tsx).
vi.mock('@/components/ui/select', () => ({
    Select: ({
        value,
        children,
        onValueChange,
        ...rest
    }: {
        value: string;
        children: React.ReactNode;
        onValueChange: (v: string) => void;
    } & Record<string, unknown>) => (
        <select
            data-testid={rest['data-testid'] as string | undefined}
            id={rest.id as string | undefined}
            value={value}
            onChange={(e) => onValueChange(e.currentTarget.value)}
        >
            {children}
        </select>
    ),
}));

import { GoalForm } from './GoalForm';
import {
    buildCreateGoalPayload,
    parseDodLines,
    targetValueIsAcceptable,
    validateGoalFormFields,
    type GoalFormFields,
} from './goal-form-payload';

const METRIC_KEYS = ['metricSource', 'comparator', 'targetValue', 'unit', 'window'] as const;

function setField(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function switchKind(kind: 'metric' | 'delivery') {
    fireEvent.change(screen.getByTestId('goal-kind-select'), { target: { value: kind } });
}

function clickCreate() {
    fireEvent.click(screen.getByRole('button', { name: 'actions.create' }));
}

/**
 * Self-build slice AG (EW-795) — the create form's kind switch.
 *
 * What is pinned: the form defaults to a METRIC Goal (so the pinned e2e
 * journey that looks for the "Target value" field on `/goals/new` keeps
 * finding it), switching to DELIVERY hides every metric field and shows the
 * Definition of Done, and — the part a rendered form is the only honest
 * witness for — the payload handed to the server action for a delivery
 * Goal carries NO metric key, while the metric payload is unchanged.
 */
describe('GoalForm — kind switch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createGoalAction.mockResolvedValue({ id: 'g-new' });
    });

    it('defaults to a metric Goal: metric source + target visible, no Definition of Done', () => {
        render(<GoalForm />);
        expect(screen.getByTestId('goal-kind-select')).toHaveValue('metric');
        expect(screen.getByLabelText('fields.pluginId')).toBeInTheDocument();
        expect(screen.getByLabelText('fields.metricId')).toBeInTheDocument();
        expect(screen.getByLabelText('fields.targetValue')).toBeInTheDocument();
        expect(screen.getByLabelText('fields.unit')).toBeInTheDocument();
        expect(screen.getByText('sections.target')).toBeInTheDocument();
        expect(screen.getByText('kindHints.metric')).toBeInTheDocument();
        expect(screen.queryByLabelText('fields.dodCriteria')).toBeNull();
        expect(screen.queryByText('sections.definitionOfDone')).toBeNull();
    });

    it('switching to delivery hides every metric field and shows the Definition of Done', () => {
        render(<GoalForm />);
        switchKind('delivery');

        expect(screen.getByTestId('goal-kind-select')).toHaveValue('delivery');
        expect(screen.queryByLabelText('fields.pluginId')).toBeNull();
        expect(screen.queryByLabelText('fields.metricId')).toBeNull();
        expect(screen.queryByLabelText('fields.targetValue')).toBeNull();
        expect(screen.queryByLabelText('fields.unit')).toBeNull();
        expect(screen.queryByText('sections.metricSource')).toBeNull();
        expect(screen.queryByText('sections.target')).toBeNull();
        expect(screen.getByLabelText('fields.dodCriteria')).toBeInTheDocument();
        expect(screen.getByText('kindHints.delivery')).toBeInTheDocument();
        // Deadline + cadence apply to both kinds and stay.
        expect(screen.getByLabelText('fields.checkFrequency')).toBeInTheDocument();
        expect(screen.getByText('fields.deadline')).toBeInTheDocument();
    });

    it('switching back to metric restores the metric fields', () => {
        render(<GoalForm />);
        switchKind('delivery');
        switchKind('metric');
        expect(screen.getByLabelText('fields.targetValue')).toBeInTheDocument();
        expect(screen.queryByLabelText('fields.dodCriteria')).toBeNull();
    });

    it('a delivery submit sends goalKind + dodCriteria and NO metric key at all', async () => {
        render(<GoalForm />);
        switchKind('delivery');
        setField('fields.title', 'Ship feature X across three repos');
        setField('fields.dodCriteria', 'API endpoint merged\n\n  Web form merged  \nDocs updated');

        clickCreate();

        await waitFor(() => expect(createGoalAction).toHaveBeenCalledTimes(1));
        const payload = createGoalAction.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).toEqual({
            title: 'Ship feature X across three repos',
            description: null,
            goalKind: 'delivery',
            dodCriteria: [
                { id: 'dod-1', text: 'API endpoint merged', status: 'open', source: 'operator' },
                { id: 'dod-2', text: 'Web form merged', status: 'open', source: 'operator' },
                { id: 'dod-3', text: 'Docs updated', status: 'open', source: 'operator' },
            ],
            deadline: null,
            checkFrequencyMinutes: 60,
        });
        // Absent, not undefined: the object must not pretend to have a target.
        for (const key of METRIC_KEYS) {
            expect(key in payload).toBe(false);
        }
        expect(toastError).not.toHaveBeenCalled();
        await waitFor(() => expect(push).toHaveBeenCalledWith('/goals/g-new'));
    });

    it('a delivery submit with an empty checklist is refused before any request', () => {
        render(<GoalForm />);
        switchKind('delivery');
        setField('fields.title', 'Ship it');
        setField('fields.dodCriteria', '  \n\n   ');

        clickCreate();

        expect(toastError).toHaveBeenCalledWith('errors.dodRequired');
        expect(createGoalAction).not.toHaveBeenCalled();
    });

    it('a delivery submit never trips the metric validators for fields it does not show', async () => {
        render(<GoalForm />);
        switchKind('delivery');
        setField('fields.title', 'Ship it');
        setField('fields.dodCriteria', 'One criterion');

        clickCreate();

        await waitFor(() => expect(createGoalAction).toHaveBeenCalledTimes(1));
        expect(toastError).not.toHaveBeenCalledWith('errors.metricSourceRequired');
        expect(toastError).not.toHaveBeenCalledWith('errors.targetInvalid');
    });

    it('a metric submit payload is unchanged: no goalKind, no dodCriteria', async () => {
        render(<GoalForm />);
        setField('fields.title', 'Income >= $1000/month');
        setField('fields.pluginId', 'stripe');
        setField('fields.metricId', 'income');
        setField('fields.targetValue', '1000');
        setField('fields.unit', 'usd');

        clickCreate();

        await waitFor(() => expect(createGoalAction).toHaveBeenCalledTimes(1));
        const payload = createGoalAction.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).toEqual({
            title: 'Income >= $1000/month',
            description: null,
            metricSource: { pluginId: 'stripe', metricId: 'income' },
            comparator: 'gte',
            targetValue: 1000,
            unit: 'usd',
            window: 'month',
            deadline: null,
            checkFrequencyMinutes: 60,
        });
        expect('goalKind' in payload).toBe(false);
        expect('dodCriteria' in payload).toBe(false);
    });

    it('a metric submit still refuses a blank target (EW-044) and sends nothing', () => {
        render(<GoalForm />);
        setField('fields.title', 'Income');
        setField('fields.pluginId', 'stripe');
        setField('fields.metricId', 'income');
        setField('fields.unit', 'usd');

        clickCreate();

        expect(toastError).toHaveBeenCalledWith('errors.targetInvalid');
        expect(createGoalAction).not.toHaveBeenCalled();
    });

    it('a delivery Goal with text typed into the (hidden) metric fields earlier still sends none of them', async () => {
        render(<GoalForm />);
        // Fill the metric fields first, THEN switch kinds — the stale values
        // must not leak into the delivery payload.
        setField('fields.title', 'Ship it');
        setField('fields.pluginId', 'stripe');
        setField('fields.metricId', 'income');
        setField('fields.targetValue', '1000');
        setField('fields.unit', 'usd');
        switchKind('delivery');
        setField('fields.dodCriteria', 'Done when merged');

        clickCreate();

        await waitFor(() => expect(createGoalAction).toHaveBeenCalledTimes(1));
        const payload = createGoalAction.mock.calls[0][0] as Record<string, unknown>;
        for (const key of METRIC_KEYS) {
            expect(key in payload).toBe(false);
        }
        expect(payload.goalKind).toBe('delivery');
    });
});

describe('goal-form-payload helpers', () => {
    const fields = (overrides: Partial<GoalFormFields> = {}): GoalFormFields => ({
        title: 'x',
        description: '',
        pluginId: 'stripe',
        metricId: 'income',
        comparator: 'gte',
        targetValue: '1000',
        unit: 'usd',
        window: 'month',
        dodText: 'Ship it',
        deadline: null,
        checkFrequencyMinutes: 60,
        ...overrides,
    });

    it('parseDodLines: trims, drops blank lines, numbers ids, caps at the server bound', () => {
        expect(parseDodLines('\n a \r\n\n b \n')).toEqual([
            { id: 'dod-1', text: 'a', status: 'open', source: 'operator' },
            { id: 'dod-2', text: 'b', status: 'open', source: 'operator' },
        ]);
        expect(parseDodLines('')).toEqual([]);
        expect(parseDodLines('   \n  ')).toEqual([]);
        const many = Array.from({ length: 60 }, (_, i) => `criterion ${i}`).join('\n');
        expect(parseDodLines(many)).toHaveLength(50);
        expect(parseDodLines('x'.repeat(600))[0].text).toHaveLength(500);
    });

    it('targetValueIsAcceptable: the EW-044 guard is unchanged', () => {
        expect(targetValueIsAcceptable('')).toBe(false);
        expect(targetValueIsAcceptable('   ')).toBe(false);
        expect(targetValueIsAcceptable('abc')).toBe(false);
        expect(targetValueIsAcceptable('Infinity')).toBe(false);
        expect(targetValueIsAcceptable('0')).toBe(true);
        expect(targetValueIsAcceptable(' 12.5 ')).toBe(true);
        expect(targetValueIsAcceptable('-3')).toBe(true);
    });

    it('validateGoalFormFields: metric keeps the legacy order, delivery needs a title and a checklist', () => {
        expect(validateGoalFormFields('metric', fields())).toBeNull();
        expect(validateGoalFormFields('metric', fields({ title: ' ' }))).toBe(
            'errors.titleRequired',
        );
        expect(validateGoalFormFields('metric', fields({ pluginId: '' }))).toBe(
            'errors.metricSourceRequired',
        );
        expect(validateGoalFormFields('metric', fields({ metricId: ' ' }))).toBe(
            'errors.metricSourceRequired',
        );
        expect(validateGoalFormFields('metric', fields({ targetValue: '' }))).toBe(
            'errors.targetInvalid',
        );
        expect(validateGoalFormFields('metric', fields({ unit: '' }))).toBe('errors.unitRequired');

        expect(validateGoalFormFields('delivery', fields())).toBeNull();
        expect(validateGoalFormFields('delivery', fields({ title: '' }))).toBe(
            'errors.titleRequired',
        );
        expect(validateGoalFormFields('delivery', fields({ dodText: '\n \n' }))).toBe(
            'errors.dodRequired',
        );
        // A delivery Goal ignores the metric fields entirely.
        expect(
            validateGoalFormFields('delivery', fields({ pluginId: '', targetValue: '', unit: '' })),
        ).toBeNull();
    });

    it('buildCreateGoalPayload: delivery carries no metric key; metric carries no kind', () => {
        const delivery = buildCreateGoalPayload('delivery', fields({ dodText: 'a\nb' }));
        expect(delivery).toEqual({
            title: 'x',
            description: null,
            deadline: null,
            checkFrequencyMinutes: 60,
            goalKind: 'delivery',
            dodCriteria: [
                { id: 'dod-1', text: 'a', status: 'open', source: 'operator' },
                { id: 'dod-2', text: 'b', status: 'open', source: 'operator' },
            ],
        });
        for (const key of METRIC_KEYS) {
            expect(key in delivery).toBe(false);
        }

        const metric = buildCreateGoalPayload(
            'metric',
            fields({ params: { currency: 'usd' }, description: '  ctx  ' }),
        );
        expect(metric).toEqual({
            title: 'x',
            description: 'ctx',
            deadline: null,
            checkFrequencyMinutes: 60,
            metricSource: { pluginId: 'stripe', metricId: 'income', params: { currency: 'usd' } },
            comparator: 'gte',
            targetValue: 1000,
            unit: 'usd',
            window: 'month',
        });
        expect('goalKind' in metric).toBe(false);
        expect('dodCriteria' in metric).toBe(false);
        // No params → no params key (not `params: undefined`).
        expect('params' in (buildCreateGoalPayload('metric', fields()).metricSource ?? {})).toBe(
            false,
        );
    });
});
