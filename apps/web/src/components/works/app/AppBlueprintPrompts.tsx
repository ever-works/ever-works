'use client';

import { useTranslations } from 'next-intl';
import type { AppBlueprintPrompt } from '@ever-works/contracts';
import { Input } from '@/components/ui/input';

export interface AppBlueprintPromptsProps {
    /** The Blueprint's display name (falls back to its id). */
    blueprintName: string;
    prompts: readonly AppBlueprintPrompt[];
    values: Readonly<Record<string, string>>;
    onChange: (name: string, value: string) => void;
    disabled?: boolean;
}

/** True while a `Required` prompt has no value — the form disables submit then (FR-55). */
export function hasMissingRequiredPrompt(
    prompts: readonly AppBlueprintPrompt[],
    values: Readonly<Record<string, string>>,
): boolean {
    return prompts.some((prompt) => prompt.required && !(values[prompt.name] ?? '').trim());
}

/**
 * APW-01 T22 — "Values this app needs" (spec §6.2, FR-55).
 *
 * One input per prompt descriptor, never pre-filled from a stored value: the
 * answers travel write-only as `appEnv` on the create request and are never
 * echoed back by any read.
 */
export function AppBlueprintPrompts({
    blueprintName,
    prompts,
    values,
    onChange,
    disabled,
}: AppBlueprintPromptsProps) {
    const t = useTranslations('dashboard.workCreation.app');
    if (prompts.length === 0) return null;

    return (
        <section className="space-y-3" data-testid="app-work-prompts">
            <div>
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('promptsTitle')}
                </h3>
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t('promptHint', { name: blueprintName })}
                </p>
            </div>
            {prompts.map((prompt) => (
                <Input
                    key={prompt.name}
                    label={
                        prompt.required ? `${prompt.name} · ${t('promptRequired')}` : prompt.name
                    }
                    name={`app-env-${prompt.name}`}
                    value={values[prompt.name] ?? ''}
                    onChange={(event) => onChange(prompt.name, event.target.value)}
                    helperText={prompt.description}
                    required={prompt.required}
                    aria-required={prompt.required}
                    autoComplete="off"
                    disabled={disabled}
                    variant="form"
                    data-testid={`app-work-prompt-${prompt.name}`}
                />
            ))}
        </section>
    );
}
