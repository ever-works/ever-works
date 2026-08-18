import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LucideIcon } from 'lucide-react';
import { HumanAgentIcon } from './HumanAgentIcon';

/**
 * Type-level guard (checked by `pnpm type-check`, not at runtime): the icon
 * must be assignable to `LucideIcon`, because that is how `PageHeader.icon`
 * and the sidebar navigation array are typed.
 */
const asLucideIcon: LucideIcon = HumanAgentIcon;

describe('HumanAgentIcon', () => {
    it("is assignable to lucide's LucideIcon type", () => {
        expect(asLucideIcon).toBe(HumanAgentIcon);
    });

    it('renders a lucide-compatible svg with the given class and stroke width', () => {
        const { container } = render(<HumanAgentIcon className="w-5 h-5" strokeWidth={1.5} />);
        const svg = container.querySelector('svg');
        expect(svg).not.toBeNull();
        expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
        expect(svg?.getAttribute('class')).toContain('w-5');
        expect(svg?.getAttribute('stroke-width')).toBe('1.5');
        expect(svg?.getAttribute('aria-hidden')).toBe('true');
        // both halves present: a person head (circle) and a bot head (rect)
        expect(container.querySelector('circle')).not.toBeNull();
        expect(container.querySelector('rect')).not.toBeNull();
    });

    it('defaults to lucide stroke width 2 and paints with currentColor', () => {
        const { container } = render(<HumanAgentIcon />);
        const svg = container.querySelector('svg');
        expect(svg?.getAttribute('stroke-width')).toBe('2');
        expect(svg?.getAttribute('stroke')).toBe('currentColor');
        expect(svg?.getAttribute('fill')).toBe('none');
    });

    it('honours absoluteStrokeWidth like lucide (stroke = width * 24 / size) and does not forward it', () => {
        const { container } = render(
            <HumanAgentIcon size={48} strokeWidth={2} absoluteStrokeWidth />,
        );
        const svg = container.querySelector('svg');
        expect(svg?.getAttribute('width')).toBe('48');
        expect(svg?.getAttribute('stroke-width')).toBe('1');
        expect(svg?.hasAttribute('absoluteStrokeWidth')).toBe(false);
        expect(svg?.hasAttribute('absolutestrokewidth')).toBe(false);
    });
});
