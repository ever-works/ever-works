// EW-742 — unit spec for the Select `iconMap` / `data-icon` feature.
// Uses vitest + jsdom + @testing-library/react. Confirms a leading icon
// renders in the trigger (selected) and in each open row, that it is
// backward-compatible (no icon without data-icon/iconMap), and that labels
// still render.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Select } from './select';

afterEach(cleanup);

const iconMap = {
    alpha: <svg data-testid="ic-alpha" />,
    beta: <svg data-testid="ic-beta" />,
};

function renderSelect(value: string) {
    return render(
        <Select value={value} iconMap={iconMap}>
            <option value="alpha" data-icon="alpha">
                Alpha
            </option>
            <option value="beta" data-icon="beta">
                Beta
            </option>
        </Select>,
    );
}

describe('Select iconMap / data-icon', () => {
    it('renders the selected option icon in the (closed) trigger', () => {
        renderSelect('alpha');
        expect(screen.getAllByTestId('ic-alpha').length).toBeGreaterThan(0);
        // Beta is not selected and the list is closed → its icon is absent.
        expect(screen.queryByTestId('ic-beta')).toBeNull();
    });

    it('renders each option icon once the dropdown is open', () => {
        renderSelect('alpha');
        fireEvent.click(screen.getByRole('button'));
        expect(screen.getAllByTestId('ic-alpha').length).toBeGreaterThan(0);
        expect(screen.getAllByTestId('ic-beta').length).toBeGreaterThan(0);
        // Labels still render alongside the icons (in the trigger AND the open
        // row for the selected value, so there can be more than one match).
        expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Beta').length).toBeGreaterThan(0);
    });

    it('is backward-compatible: no icon markup when data-icon / iconMap are absent', () => {
        render(
            <Select value="x">
                <option value="x">Xray</option>
                <option value="y">Yankee</option>
            </Select>,
        );
        expect(screen.queryByTestId('ic-alpha')).toBeNull();
        expect(screen.getByText('Xray')).toBeTruthy();
    });

    it('renders no leading icon when an option omits data-icon even if iconMap is set', () => {
        render(
            <Select value="a" iconMap={iconMap}>
                <option value="a">Plain</option>
            </Select>,
        );
        // "a" is not a key with a matching data-icon, so neither test icon shows.
        expect(screen.queryByTestId('ic-alpha')).toBeNull();
        expect(screen.queryByTestId('ic-beta')).toBeNull();
        expect(screen.getByText('Plain')).toBeTruthy();
    });
});
