import {
    registerDecorator,
    type ValidationArguments,
    type ValidationOptions,
} from 'class-validator';

interface SelectionLike {
    providerPluginId?: unknown;
    modelId?: unknown;
}

/** True when the fallback list does not contain the primary model sent beside it. */
export function excludesPrimary(fallbacks: unknown, primary: unknown): boolean {
    if (!Array.isArray(fallbacks)) return true;
    const selection = primary as SelectionLike | null | undefined;
    if (!selection?.providerPluginId || !selection?.modelId) return true;
    return !(fallbacks as SelectionLike[]).some(
        (entry) =>
            entry?.providerPluginId === selection.providerPluginId &&
            entry?.modelId === selection.modelId,
    );
}

/**
 * Model accounts (AW-16) — the primary model is never offered as its own
 * fallback, so a chain can never loop back onto the model that just failed.
 * Checks the `primaryModel` sent in the same body; the service applies the
 * same rule against a stored primary.
 */
export function NotPrimaryInFallbacks(options?: ValidationOptions) {
    return (target: object, propertyName: string) => {
        registerDecorator({
            name: 'notPrimaryInFallbacks',
            target: target.constructor,
            propertyName,
            options: {
                message: 'Your default model is never offered as its own fallback.',
                ...options,
            },
            validator: {
                validate: (value: unknown, args: ValidationArguments) =>
                    excludesPrimary(
                        value,
                        (args.object as { primaryModel?: unknown }).primaryModel,
                    ),
            },
        });
    };
}
