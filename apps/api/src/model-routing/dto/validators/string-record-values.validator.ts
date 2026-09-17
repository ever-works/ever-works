import {
    registerDecorator,
    type ValidationArguments,
    type ValidationOptions,
} from 'class-validator';

/**
 * True when every value of a plain object is text. `null` stays allowed: the
 * account service reads a null (like an empty string) as "this field is not
 * set" and skips it, so a form that sends an untouched optional field keeps
 * working. The container itself is checked by `@IsObject()`.
 */
export function hasStringRecordValues(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value as Record<string, unknown>).every(
        (entry) => entry === null || typeof entry === 'string',
    );
}

/**
 * Model accounts (AW-16) — a credential object's values are text. A body like
 * `{ "credentials": { "apiKey": 123 } }` is refused with 400 before it
 * reaches the service or a provider.
 */
export function StringRecordValues(options?: ValidationOptions) {
    return (target: object, propertyName: string) => {
        registerDecorator({
            name: 'stringRecordValues',
            target: target.constructor,
            propertyName,
            options: {
                message: `${propertyName} values must be text.`,
                ...options,
            },
            validator: {
                validate: (value: unknown, _args: ValidationArguments) =>
                    hasStringRecordValues(value),
            },
        });
    };
}
