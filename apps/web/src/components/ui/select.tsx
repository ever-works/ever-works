import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon, CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/* ------------------------------------------------------------------ */
/*  Custom dropdown — parses <option>/<optgroup> children, renders a  */
/*  fully styled floating list.  Supports onValueChange (Radix API)   */
/*  and standard onChange for backward compatibility.                 */
/* ------------------------------------------------------------------ */

// ---- internal data types ----------------------------------------- //

interface OptionData {
    type: 'option';
    value: string;
    label: string;
    disabled?: boolean;
}

interface GroupData {
    type: 'group';
    label: string;
    options: OptionData[];
}

type FlatItem = OptionData | GroupData;

// ---- public props ------------------------------------------------- //

export interface SelectProps {
    value?: string;
    onValueChange?: (value: string) => void;
    onChange?: React.ChangeEventHandler<HTMLSelectElement>;
    disabled?: boolean;
    /** 'sm' = h-8 text-xs  |  'default' = h-9 text-sm */
    size?: 'sm' | 'default';
    className?: string;
    children?: React.ReactNode;
    placeholder?: string;
    id?: string;
    name?: string;
}

// ---- helpers ------------------------------------------------------ //

function parseItems(children: React.ReactNode): FlatItem[] {
    const items: FlatItem[] = [];
    React.Children.forEach(children, (child) => {
        if (!React.isValidElement(child)) return;

        if (child.type === 'option') {
            const p = child.props as React.OptionHTMLAttributes<HTMLOptionElement>;
            items.push({
                type: 'option',
                value: String(p.value ?? ''),
                label: nodeText(p.children),
                disabled: !!p.disabled,
            });
        } else if (child.type === 'optgroup') {
            const p = child.props as React.OptgroupHTMLAttributes<HTMLOptGroupElement>;
            const opts: OptionData[] = [];
            React.Children.forEach(p.children as React.ReactNode, (opt) => {
                if (!React.isValidElement(opt) || opt.type !== 'option') return;
                const op = opt.props as React.OptionHTMLAttributes<HTMLOptionElement>;
                opts.push({
                    type: 'option',
                    value: String(op.value ?? ''),
                    label: nodeText(op.children),
                    disabled: !!op.disabled,
                });
            });
            items.push({ type: 'group', label: String(p.label ?? ''), options: opts });
        }
    });
    return items;
}

function nodeText(node: React.ReactNode): string {
    if (node == null) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(nodeText).join('');
    if (React.isValidElement(node))
        return nodeText((node.props as { children?: React.ReactNode }).children);
    return '';
}

function flatOptions(items: FlatItem[]): OptionData[] {
    return items.flatMap((item) => (item.type === 'option' ? [item] : item.options));
}

// ---- component ---------------------------------------------------- //

const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
    (
        {
            className,
            size = 'default',
            children,
            value,
            onValueChange,
            onChange,
            disabled,
            placeholder,
            id,
            name,
        },
        ref,
    ) => {
        const [open, setOpen] = React.useState(false);
        const containerRef = React.useRef<HTMLDivElement>(null);
        const dropdownRef = React.useRef<HTMLDivElement>(null);
        const [dropdownPos, setDropdownPos] = React.useState<{
            top?: number;
            bottom?: number;
            left: number;
            width: number;
        }>({ left: 0, width: 0 });

        const DROPDOWN_MAX_H = 240; // matches max-h-60

        const updatePos = React.useCallback(() => {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            const spaceAbove = rect.top;
            if (spaceBelow < DROPDOWN_MAX_H && spaceAbove > spaceBelow) {
                setDropdownPos({
                    bottom: window.innerHeight - rect.top + 4,
                    left: rect.left,
                    width: rect.width,
                });
            } else {
                setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
            }
        }, []);

        const items = React.useMemo(() => parseItems(children), [children]);
        const opts = React.useMemo(() => flatOptions(items), [items]);
        const selected = opts.find((o) => o.value === value && !o.disabled);

        /* close on outside click */
        React.useEffect(() => {
            if (!open) return;
            const handler = (e: MouseEvent) => {
                if (
                    !containerRef.current?.contains(e.target as Node) &&
                    !dropdownRef.current?.contains(e.target as Node)
                )
                    setOpen(false);
            };
            document.addEventListener('mousedown', handler, true);
            return () => document.removeEventListener('mousedown', handler, true);
        }, [open]);

        /* close on Escape */
        React.useEffect(() => {
            if (!open) return;
            const handler = (e: KeyboardEvent) => {
                if (e.key === 'Escape') setOpen(false);
            };
            document.addEventListener('keydown', handler);
            return () => document.removeEventListener('keydown', handler);
        }, [open]);

        /* reposition on scroll / resize while open */
        React.useEffect(() => {
            if (!open) return;
            window.addEventListener('scroll', updatePos, true);
            window.addEventListener('resize', updatePos);
            return () => {
                window.removeEventListener('scroll', updatePos, true);
                window.removeEventListener('resize', updatePos);
            };
        }, [open, updatePos]);

        const pick = (opt: OptionData) => {
            if (opt.disabled) return;
            onValueChange?.(opt.value);
            setOpen(false);
        };

        const displayLabel = selected?.label ?? placeholder ?? '';

        return (
            <div
                ref={containerRef}
                className={cn(
                    'relative',
                    /* only default to w-full when no w-* / min-w-* class is provided */
                    !className?.match(/\b(?:w-|min-w-)/) && 'w-full',
                    className,
                )}
            >
                {/* ---- trigger ---- */}
                <button
                    ref={ref}
                    id={id}
                    name={name}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                        if (!open) updatePos();
                        setOpen((v) => !v);
                    }}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    className={cn(
                        'w-full flex items-center justify-between rounded-lg border text-sm',
                        'transition-colors outline-none text-left cursor-pointer',
                        'bg-surface dark:bg-surface-secondary-dark/20',
                        'border-card-border dark:border-border-secondary-dark',
                        'hover:border-white/40 focus-visible:border-white focus-visible:ring-2 focus-visible:ring-white/20',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                        open && 'border-white/9 ring-1 ring-white/20',
                        size === 'default' ? 'h-9 px-3 py-2' : 'h-8 px-2 text-sm',
                    )}
                >
                    <span
                        className={cn(
                            'truncate leading-none',
                            selected
                                ? 'text-text dark:text-text-dark'
                                : 'text-text-muted dark:text-text-muted-dark',
                        )}
                    >
                        {displayLabel}
                    </span>
                    <ChevronDownIcon
                        className={cn(
                            'ml-2 size-4 shrink-0 opacity-50',
                            'text-text-muted dark:text-text-muted-dark',
                            'transition-transform duration-200',
                            open && 'rotate-180',
                        )}
                    />
                </button>

                {/* ---- dropdown panel (portalled to body — escapes overflow:hidden parents) ---- */}
                {open &&
                    createPortal(
                        <div
                            ref={dropdownRef}
                            role="listbox"
                            style={{
                                top: dropdownPos.top,
                                bottom: dropdownPos.bottom,
                                left: dropdownPos.left,
                                width: dropdownPos.width,
                            }}
                            className={cn(
                                'fixed z-[9999] min-w-[8rem]',
                                'rounded-lg border shadow-sm overflow-hidden',
                                'bg-white dark:bg-surface-dark',
                                'border-card-border dark:border-border-secondary-dark',
                                'max-h-60 overflow-y-auto py-1',
                                'sel-dropdown',
                            )}
                        >
                            {items.map((item, idx) =>
                                item.type === 'option' ? (
                                    <OptionRow
                                        key={item.value}
                                        opt={item}
                                        selected={item.value === value}
                                        size={size}
                                        onPick={pick}
                                    />
                                ) : (
                                    <div key={`group-${item.label}-${idx}`}>
                                        {/* group label — mirrors shadcn SelectLabel */}
                                        <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide select-none text-text-muted dark:text-text-muted-dark">
                                            {item.label}
                                        </p>
                                        {item.options.map((opt, j) => (
                                            <OptionRow
                                                key={opt.value}
                                                opt={opt}
                                                selected={opt.value === value}
                                                size={size}
                                                onPick={pick}
                                                indent
                                            />
                                        ))}
                                    </div>
                                ),
                            )}
                        </div>,
                        document.body,
                    )}
            </div>
        );
    },
);
Select.displayName = 'Select';

// ---- option row --------------------------------------------------- //

function OptionRow({
    opt,
    selected,
    size,
    onPick,
    indent,
}: {
    opt: OptionData;
    selected: boolean;
    size: 'sm' | 'default';
    onPick: (opt: OptionData) => void;
    indent?: boolean;
}) {
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (opt.disabled) {
            return;
        }
        switch (event.key) {
            case 'Enter':
            case ' ':
                event.preventDefault();
                onPick(opt);
                break;
            case 'ArrowDown': {
                event.preventDefault();
                const current = event.currentTarget as HTMLElement;
                let next = current.nextElementSibling as HTMLElement | null;
                while (next && next.getAttribute('aria-disabled') === 'true') {
                    next = next.nextElementSibling as HTMLElement | null;
                }
                if (next) {
                    next.focus();
                }
                break;
            }
            case 'ArrowUp': {
                event.preventDefault();
                const current = event.currentTarget as HTMLElement;
                let prev = current.previousElementSibling as HTMLElement | null;
                while (prev && prev.getAttribute('aria-disabled') === 'true') {
                    prev = prev.previousElementSibling as HTMLElement | null;
                }
                if (prev) {
                    prev.focus();
                }
                break;
            }
            default:
                break;
        }
    };
    return (
        <div
            role="option"
            aria-selected={selected}
            aria-disabled={opt.disabled}
            onClick={() => onPick(opt)}
            onKeyDown={handleKeyDown}
            tabIndex={opt.disabled ? -1 : 0}
            className={cn(
                'flex items-center gap-2 cursor-pointer select-none transition-colors',
                size === 'default'
                    ? 'px-3 py-2 text-sm mx-1 rounded-sm my-px'
                    : 'px-2 py-1.5 mx-1 rounded-sm my-px text-sm',
                indent && 'pl-6',
                selected
                    ? 'bg-surface-secondary dark:bg-white/6 font-medium text-text dark:text-text-dark'
                    : 'text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-white/4',
                opt.disabled &&
                    'opacity-50 cursor-not-allowed pointer-events-none text-text-muted dark:text-text-muted-dark',
            )}
        >
            <span className="flex-1 truncate">{opt.label}</span>
            {selected && <CheckIcon className="size-4 shrink-0 text-gray-800 dark:text-gray-100" />}
        </div>
    );
}

export { Select };
