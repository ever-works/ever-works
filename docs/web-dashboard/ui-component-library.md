---
id: ui-component-library
title: UI Component Library
sidebar_label: UI Component Library
sidebar_position: 25
---

# UI Component Library

## Overview

The Ever Works UI component library provides a set of reusable, themed primitives used throughout the web dashboard. All components live in `apps/web/src/components/ui/` and follow consistent patterns: Tailwind CSS 4 with custom design tokens, dark mode support via the `dark:` prefix, and the `cn()` utility (wrapping `clsx` + `tailwind-merge`) for conditional class composition. Components are client components only when interactivity is required.

## Architecture

```
apps/web/src/components/ui/
├── button.tsx           # Button with variants, sizes, link support
├── dialog.tsx           # Dialog system (HeadlessUI)
├── input.tsx            # Text input with label, error, helper
├── tooltip.tsx          # CSS-only tooltip
├── collapsible-card.tsx # Expandable card
├── checkbox.tsx         # Checkbox input
├── select.tsx           # Select dropdown
├── switch.tsx           # Toggle switch
├── textarea.tsx         # Multi-line text input
├── auto-resize-textarea.tsx  # Auto-growing textarea
├── dropdown-menu.tsx    # Dropdown menu
├── show-datetime.tsx    # Date/time display
├── top-loader.tsx       # Page transition loader
└── DotLottiePlayer.tsx  # Lottie animation player
```

All components use `forwardRef` where applicable and spread remaining props onto the underlying HTML element for maximum composability.

## Components

### Button

**File:** `apps/web/src/components/ui/button.tsx`

| Prop        | Type                                                            | Default     | Description                                     |
| ----------- | --------------------------------------------------------------- | ----------- | ----------------------------------------------- |
| `variant`   | `'primary' \| 'secondary' \| 'ghost' \| 'danger' \| 'unstyled'` | `'primary'` | Visual style variant                            |
| `size`      | `'sm' \| 'md' \| 'lg' \| 'icon'`                                | `'md'`      | Button size                                     |
| `href`      | `string` (optional)                                             | -           | Renders as Next.js `Link` instead of `<button>` |
| `loading`   | `boolean` (optional)                                            | `false`     | Shows a spinner and disables the button         |
| `fullWidth` | `boolean` (optional)                                            | `false`     | Stretches to full container width               |
| `className` | `string` (optional)                                             | -           | Additional CSS classes                          |

Plus all standard `ButtonHTMLAttributes`.

**Variants:**

| Variant     | Appearance                                         |
| ----------- | -------------------------------------------------- |
| `primary`   | Solid primary brand color background, white text   |
| `secondary` | Bordered with surface background, muted text       |
| `ghost`     | Transparent background, subtle hover effect        |
| `danger`    | Red background, white text for destructive actions |
| `unstyled`  | No default styles, fully custom                    |

**Sizes:**

| Size   | Padding       | Text                        |
| ------ | ------------- | --------------------------- |
| `sm`   | `px-3 py-1.5` | `text-xs`                   |
| `md`   | `px-4 py-2`   | `text-sm`                   |
| `lg`   | `px-6 py-3`   | `text-base`                 |
| `icon` | `p-2`         | Square button for icon-only |

When `href` is provided, the button renders as a Next.js `Link` component with the same visual styling. When `loading` is true, a spinning SVG replaces the button content and the button is disabled.

```tsx
import { Button } from '@/components/ui/button';

<Button variant="primary" size="md">Save Changes</Button>
<Button variant="danger" loading={isPending}>Delete</Button>
<Button variant="ghost" size="icon"><Trash2 className="w-4 h-4" /></Button>
<Button href="/dashboard" variant="secondary">Go to Dashboard</Button>
```

### Dialog

**File:** `apps/web/src/components/ui/dialog.tsx`

Built on HeadlessUI's `Dialog` component, this module exports several sub-components:

| Export              | Description                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `Dialog`            | Root dialog wrapper (controls open/close state)                           |
| `DialogContent`     | Centered modal panel with backdrop, scale transition, and rounded corners |
| `DialogHeader`      | Flex container for the title area                                         |
| `DialogTitle`       | Re-exported HeadlessUI `DialogTitle`                                      |
| `DialogDescription` | Muted text below the title                                                |
| `DialogFooter`      | Right-aligned flex container for action buttons                           |
| `DialogClose`       | Close button (X icon) in the top-right corner                             |

**DialogContent** applies a scale + fade transition on open/close using HeadlessUI's `Transition`:

- Enter: `opacity-0 scale-95` to `opacity-100 scale-100` over 200ms.
- Leave: reverse over 150ms.

The backdrop is a semi-transparent black overlay (`bg-black/50`).

| Prop (DialogContent) | Type                | Description                      |
| -------------------- | ------------------- | -------------------------------- |
| `children`           | `ReactNode`         | Dialog body content              |
| `className`          | `string` (optional) | Additional classes for the panel |

| Prop (DialogClose) | Type         | Description                           |
| ------------------ | ------------ | ------------------------------------- |
| `onClose`          | `() => void` | Callback when close button is clicked |

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog';

<Dialog open={isOpen} onOpenChange={setIsOpen}>
	<DialogContent>
		<DialogClose onClose={() => setIsOpen(false)} />
		<DialogHeader>
			<DialogTitle>Confirm Action</DialogTitle>
		</DialogHeader>
		<p>Are you sure you want to proceed?</p>
		<DialogFooter>
			<Button variant="secondary" onClick={() => setIsOpen(false)}>
				Cancel
			</Button>
			<Button onClick={handleConfirm}>Confirm</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>;
```

### Input

**File:** `apps/web/src/components/ui/input.tsx`

| Prop         | Type                  | Default     | Description                                |
| ------------ | --------------------- | ----------- | ------------------------------------------ |
| `label`      | `string` (optional)   | -           | Label text above the input                 |
| `error`      | `string` (optional)   | -           | Error message below the input              |
| `helperText` | `string` (optional)   | -           | Helper text (hidden when error is present) |
| `variant`    | `'default' \| 'form'` | `'default'` | Style variant                              |

Plus all standard `InputHTMLAttributes`.

**Variants:**

| Variant   | Characteristics                                                                         |
| --------- | --------------------------------------------------------------------------------------- |
| `default` | Larger padding (`py-3`), focus ring (`ring-2 ring-primary/20`), hover border transition |
| `form`    | Compact padding (`py-2`), no focus ring, minimal styling for dense forms                |

The component auto-generates an `id` via React's `useId` hook if none is provided, ensuring the `<label>` is properly associated with the `<input>`. Error state changes the border to `border-danger/50` and the focus ring to `ring-danger/20`.

```tsx
import { Input } from '@/components/ui/input';

<Input
    label="Username"
    placeholder="Enter username"
    error={errors.username}
    helperText="Must be at least 3 characters"
/>

<Input variant="form" label="API Key Name" maxLength={100} />
```

### Tooltip

**File:** `apps/web/src/components/ui/tooltip.tsx`

| Prop       | Type                                     | Default | Description                          |
| ---------- | ---------------------------------------- | ------- | ------------------------------------ |
| `content`  | `string`                                 | -       | Tooltip text                         |
| `position` | `'top' \| 'bottom' \| 'left' \| 'right'` | `'top'` | Tooltip position relative to trigger |
| `children` | `ReactNode`                              | -       | Trigger element                      |

A pure CSS tooltip that requires no JavaScript for show/hide. It uses Tailwind's `group` and `group-hover` utilities:

- The wrapper is a `relative group` container.
- The tooltip is absolutely positioned and hidden by default (`opacity-0 invisible`).
- On hover, it transitions to `opacity-100 visible`.

Position classes:

| Position | Placement                       |
| -------- | ------------------------------- |
| `top`    | Above, centered horizontally    |
| `bottom` | Below, centered horizontally    |
| `left`   | Left side, centered vertically  |
| `right`  | Right side, centered vertically |

```tsx
import { Tooltip } from '@/components/ui/tooltip';

<Tooltip content="Create new directory" position="bottom">
	<Button variant="icon">
		<Plus className="w-4 h-4" />
	</Button>
</Tooltip>;
```

### CollapsibleCard

**File:** `apps/web/src/components/ui/collapsible-card.tsx`

| Prop            | Type                   | Default | Description                                              |
| --------------- | ---------------------- | ------- | -------------------------------------------------------- |
| `title`         | `string`               | -       | Card header text                                         |
| `defaultOpen`   | `boolean` (optional)   | `false` | Whether the card starts expanded                         |
| `headerContent` | `ReactNode` (optional) | -       | Additional content in the header row                     |
| `actions`       | `ReactNode` (optional) | -       | Action buttons in the header (click propagation stopped) |
| `children`      | `ReactNode`            | -       | Collapsible body content                                 |

A card with a clickable header that toggles the visibility of its body content. The chevron icon rotates 180 degrees when expanded. The `actions` slot uses `stopPropagation` so clicking action buttons does not toggle the card.

```tsx
import { CollapsibleCard } from '@/components/ui/collapsible-card';

<CollapsibleCard
	title="OpenAI Settings"
	headerContent={<span className="text-xs text-text-muted">v1.2.0</span>}
	actions={<Switch checked={enabled} onChange={toggle} />}
	defaultOpen
>
	<div className="space-y-4">
		<Input label="API Key" type="password" />
		<Input label="Model" value="gpt-4o" />
	</div>
</CollapsibleCard>;
```

## Implementation Details

### The `cn()` Utility

All UI components use `cn()` from `@/lib/utils` for class composition:

```typescript
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
```

This combines `clsx` (for conditional classes) with `tailwind-merge` (for deduplicating and resolving Tailwind class conflicts). For example, if a parent passes `className="py-4"` but the component has `py-3`, `twMerge` ensures only the override applies.

### ForwardRef Pattern

`Button` and `Input` use `React.forwardRef` so parent components can attach refs for focus management or form libraries:

```tsx
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ variant, size, ...props }, ref) => {
	return <button ref={ref} {...props} />;
});
```

### HeadlessUI Integration

The Dialog system uses HeadlessUI v2 for accessible modal behavior:

- Focus trapping within the dialog.
- Escape key to close.
- Click-outside-to-close via the backdrop.
- Proper `aria-*` attributes on all dialog parts.

The `Transition` component handles enter/leave animations with configurable duration and easing.

## Styling & Theming

### Design Token Reference

| Token               | Light         | Dark                   | Usage                          |
| ------------------- | ------------- | ---------------------- | ------------------------------ |
| `surface`           | White         | Dark gray              | Primary backgrounds            |
| `surface-secondary` | Light gray    | Darker gray            | Card/section backgrounds       |
| `surface-tertiary`  | Lightest gray | Darkest gray           | Disabled backgrounds           |
| `text`              | Near black    | Near white             | Primary text                   |
| `text-muted`        | Medium gray   | Light gray             | Secondary text                 |
| `border`            | Light gray    | Dark gray              | Borders and dividers           |
| `primary`           | Brand blue    | Brand blue             | Accent/action color            |
| `danger`            | Red           | Red                    | Destructive actions            |
| `warning`           | Amber         | Amber                  | Warning states                 |
| `success`           | Green         | Green                  | Success states                 |
| `input-bg-dark`     | -             | Specific dark input bg | Input backgrounds in dark mode |

### Consistent Patterns

All form inputs follow this border pattern:

- Default: `border-primary/30 dark:border-primary/10`
- Focus: `focus:border-primary`
- Error: `border-danger/50 focus:border-danger`
- Disabled: `disabled:bg-surface-tertiary disabled:cursor-not-allowed`

All transitions use `transition-colors` or `transition-all` with `duration-200` for smooth interactions.

## Usage Examples

### Form with Validation

```tsx
'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function SettingsForm() {
	const [errors, setErrors] = useState<Record<string, string>>({});

	return (
		<form className="space-y-4">
			<Input label="Display Name" error={errors.name} helperText="This will be shown publicly" />
			<Input variant="form" label="Website URL" type="url" error={errors.url} />
			<Button type="submit" fullWidth>
				Save Settings
			</Button>
		</form>
	);
}
```

### Confirmation Dialog

```tsx
'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function DeleteConfirmation({ onConfirm }) {
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button variant="danger" onClick={() => setOpen(true)}>
				Delete
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogClose onClose={() => setOpen(false)} />
					<DialogHeader>
						<DialogTitle>Delete Item</DialogTitle>
					</DialogHeader>
					<p className="text-sm text-text-muted">This action cannot be undone.</p>
					<DialogFooter>
						<Button variant="secondary" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button variant="danger" onClick={onConfirm}>
							Delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
```

## Related Components

- [Dashboard Layout](./dashboard-layout.md) - Uses Button, Tooltip throughout the layout shell
- [Settings Components](./settings-components.md) - Heavy consumer of Input, Dialog, CollapsibleCard, Button
- [Auth Components](./auth-components.md) - Uses Button and Input for login/register forms
- [Import Flow Components](./import-flow-components.md) - Uses Dialog, Input, Button in import wizards
