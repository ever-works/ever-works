import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchableSelect, type SearchableSelectOption } from './searchable-select';

const OPTIONS: SearchableSelectOption[] = [
    { value: 'openai', label: 'OpenAI', description: 'openai' },
    { value: 'anthropic', label: 'Anthropic', description: 'anthropic' },
    { value: 'openrouter', label: 'OpenRouter', description: 'openrouter' },
];

function setup(props: Partial<React.ComponentProps<typeof SearchableSelect>> = {}) {
    const onChange = vi.fn();
    render(
        <SearchableSelect
            label="AI provider"
            value=""
            onChange={onChange}
            options={OPTIONS}
            placeholder="Account default"
            testId="picker"
            {...props}
        />,
    );
    return { onChange };
}

describe('SearchableSelect', () => {
    it('shows the placeholder when nothing is selected', () => {
        setup();
        expect(screen.getByTestId('picker-trigger')).toHaveTextContent('Account default');
    });

    it('shows the selected option label, not its raw value', () => {
        setup({ value: 'anthropic' });
        expect(screen.getByTestId('picker-trigger')).toHaveTextContent('Anthropic');
    });

    /**
     * A value with no matching option must still render verbatim. The
     * options list is a convenience, not the authority — the server may
     * know provider ids this build does not, and blanking the trigger
     * would misrepresent what is actually saved.
     */
    it('renders an unknown value verbatim rather than blanking it', () => {
        setup({ value: 'some-future-provider' });
        expect(screen.getByTestId('picker-trigger')).toHaveTextContent('some-future-provider');
    });

    it('opens on click and lists every option', () => {
        setup();
        fireEvent.click(screen.getByTestId('picker-trigger'));
        expect(screen.getByTestId('picker-panel')).toBeInTheDocument();
        expect(screen.getByRole('option', { name: /OpenAI/ })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: /Anthropic/ })).toBeInTheDocument();
    });

    it('reports the picked value and closes', () => {
        const { onChange } = setup();
        fireEvent.click(screen.getByTestId('picker-trigger'));
        fireEvent.click(screen.getByRole('option', { name: /OpenRouter/ }));
        expect(onChange).toHaveBeenCalledWith('openrouter');
        expect(screen.queryByTestId('picker-panel')).not.toBeInTheDocument();
    });

    it('clears the value through the empty option', () => {
        const { onChange } = setup({ value: 'openai', emptyOptionLabel: 'Account default' });
        fireEvent.click(screen.getByTestId('picker-trigger'));
        fireEvent.click(screen.getByRole('button', { name: 'Account default' }));
        expect(onChange).toHaveBeenCalledWith('');
    });

    it('accepts a custom value so an unlisted id stays reachable', () => {
        const { onChange } = setup({
            allowCustom: true,
            customLabel: 'Enter a provider id…',
            customPlaceholder: 'e.g. openrouter',
        });
        fireEvent.click(screen.getByTestId('picker-trigger'));
        fireEvent.click(screen.getByRole('button', { name: 'Enter a provider id…' }));
        const input = screen.getByPlaceholderText('e.g. openrouter');
        fireEvent.change(input, { target: { value: '  my-gateway  ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Set' }));
        expect(onChange).toHaveBeenCalledWith('my-gateway');
    });

    it('ignores a blank custom value', () => {
        const { onChange } = setup({ allowCustom: true, customLabel: 'Custom' });
        fireEvent.click(screen.getByTestId('picker-trigger'));
        fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
        fireEvent.click(screen.getByRole('button', { name: 'Set' }));
        expect(onChange).not.toHaveBeenCalled();
    });

    it('closes on Escape without selecting anything', () => {
        const { onChange } = setup();
        fireEvent.click(screen.getByTestId('picker-trigger'));
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('picker-panel')).not.toBeInTheDocument();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('does not render a search box for a short list', () => {
        setup();
        fireEvent.click(screen.getByTestId('picker-trigger'));
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('filters a long list by label, value or description', () => {
        const many: SearchableSelectOption[] = Array.from({ length: 10 }, (_, i) => ({
            value: `p-${i}`,
            label: `Provider ${i}`,
            description: i === 7 ? 'needle-here' : `desc-${i}`,
        }));
        setup({ options: many });
        fireEvent.click(screen.getByTestId('picker-trigger'));

        const search = screen.getByRole('textbox');
        fireEvent.change(search, { target: { value: 'needle' } });

        expect(screen.getAllByRole('option')).toHaveLength(1);
        expect(screen.getByRole('option', { name: /Provider 7/ })).toBeInTheDocument();
    });

    it('is inert when disabled', () => {
        setup({ disabled: true });
        const trigger = screen.getByTestId('picker-trigger');
        expect(trigger).toBeDisabled();
        fireEvent.click(trigger);
        expect(screen.queryByTestId('picker-panel')).not.toBeInTheDocument();
    });
});
