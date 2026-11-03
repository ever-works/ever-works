import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { TASK_DELIVERY_FILTER_GROUPS } from '@ever-works/contracts';
import messages from '../../../messages/en.json';
import { TASK_DELIVERY_FILTER_OPTIONS, parseTaskDeliveryFilter } from '@/lib/task-delivery-filter';

/**
 * APW-08 T27 — the **Delivery** select on an App Work's Tasks tab (spec §6.1): `Any` ·
 * `Waiting to merge` · `Building` · `Deploying` · `Live` · `Failed` · `Closed without deploying`,
 * submitted as `?delivery=`. Off by default, so the `/tasks` form is unchanged.
 *
 * The custom dropdown is swapped for a native `<select>` here: what is under test is which
 * options the form offers and what it submits, not the dropdown widget.
 */

vi.mock('@/components/ui/select', () => ({
    Select: ({
        value,
        onValueChange,
        children,
        ...rest
    }: {
        value: string;
        onValueChange: (value: string) => void;
        children: React.ReactNode;
        'data-testid'?: string;
        'aria-label'?: string;
    }) => (
        <select
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            data-testid={rest['data-testid']}
            aria-label={rest['aria-label']}
        >
            {children}
        </select>
    ),
}));

import { TasksFilterSelects } from './TasksFilterSelects';

const copy = messages.dashboard.tasksPage.delivery;

function renderForm(props: React.ComponentProps<typeof TasksFilterSelects>) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <form data-testid="form">
                <TasksFilterSelects {...props} />
            </form>
        </NextIntlClientProvider>,
    );
}

const hidden = (name: string) =>
    screen
        .getByTestId('form')
        .querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);

afterEach(() => cleanup());

describe('TasksFilterSelects — Delivery (APW-08 T27)', () => {
    it('is not offered unless the scope is an App Work', () => {
        renderForm({});
        expect(screen.queryByTestId('task-delivery-filter')).toBeNull();
        expect(hidden('delivery')).toBeNull();
        // The status and priority selects are unchanged.
        expect(hidden('status')).not.toBeNull();
        expect(hidden('priority')).not.toBeNull();
    });

    it('offers Any and the six spec §6.1 options, in order', () => {
        renderForm({ showDelivery: true, deliveryOnly: true });
        const options = Array.from(
            screen.getByTestId('task-delivery-filter-select').querySelectorAll('option'),
        ).map((option) => [option.value, option.textContent]);
        expect(options).toEqual([
            ['', copy.filterAny],
            ['waiting', 'Waiting to merge'],
            ['building', 'Building'],
            ['deploying', 'Deploying'],
            ['live', 'Live'],
            ['failed', 'Failed'],
            ['closed', 'Closed without deploying'],
        ]);
        expect(screen.getByText(copy.filterLabel)).toBeTruthy();
        // Delivery only: the status / priority inputs are not submitted.
        expect(hidden('status')).toBeNull();
        expect(hidden('priority')).toBeNull();
    });

    it('submits the chosen option as ?delivery=, starting from the current one', () => {
        renderForm({ showDelivery: true, deliveryOnly: true, defaultDelivery: 'failed' });
        expect(hidden('delivery')?.value).toBe('failed');

        fireEvent.change(screen.getByTestId('task-delivery-filter-select'), {
            target: { value: 'live' },
        });
        expect(hidden('delivery')?.value).toBe('live');

        fireEvent.change(screen.getByTestId('task-delivery-filter-select'), {
            target: { value: '' },
        });
        expect(hidden('delivery')?.value).toBe('');
    });

    it('an unknown ?delivery= value reads as Any', () => {
        renderForm({ showDelivery: true, deliveryOnly: true, defaultDelivery: 'shipped' });
        expect(hidden('delivery')?.value).toBe('');
        expect(parseTaskDeliveryFilter('shipped')).toBeUndefined();
        expect(parseTaskDeliveryFilter('toString')).toBeUndefined();
        expect(parseTaskDeliveryFilter(null)).toBeUndefined();
        expect(parseTaskDeliveryFilter('waiting')).toBe('waiting');
    });

    it('every option maps to the API tokens of the same name, and has copy', () => {
        expect(TASK_DELIVERY_FILTER_OPTIONS.map((option) => option.value)).toEqual(
            Object.keys(TASK_DELIVERY_FILTER_GROUPS),
        );
        for (const option of TASK_DELIVERY_FILTER_OPTIONS) {
            expect(typeof (copy as Record<string, unknown>)[option.labelKey]).toBe('string');
        }
    });
});
