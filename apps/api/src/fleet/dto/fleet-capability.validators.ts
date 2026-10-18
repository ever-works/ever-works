import {
    registerDecorator,
    ValidationArguments,
    ValidationOptions,
    ValidatorConstraint,
    ValidatorConstraintInterface,
} from 'class-validator';
import { config } from '@ever-works/agent/config';

/**
 * Capability-tag bounds for the Fleet DTOs, read from `config.fleet.*`
 * AT VALIDATION TIME.
 *
 * Why not plain `@ArrayMaxSize(config.fleet.getMaxCapabilityTags())`?
 * Decorator arguments are evaluated when the module is imported, and
 * `apps/api` imports `ApiModule` (and therefore every DTO) BEFORE
 * `bootstrap()` calls `configDotenv()`. A decorator-time read would
 * silently ignore anything set in a `.env`, so the knob would appear to
 * work in production and appear broken in local dev — the worst of both.
 * A constraint class reads the value on each `validate()` call instead,
 * which is also what makes the override testable.
 *
 * These bound the EDGE. `FleetService.sanitizeCapabilities` re-applies
 * the same configured caps as the single source of truth, so a request
 * that slips past (internal callers, a future transport) is still
 * truncated rather than stored oversized.
 */

@ValidatorConstraint({ name: 'fleetMaxCapabilityTags', async: false })
export class FleetMaxCapabilityTagsConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        // Non-arrays are `@IsArray`'s problem, not ours — reporting the
        // same value twice just produces two confusing messages.
        if (!Array.isArray(value)) return true;
        return value.length <= config.fleet.getMaxCapabilityTags();
    }

    defaultMessage(args: ValidationArguments): string {
        return `${args.property} must contain no more than ${config.fleet.getMaxCapabilityTags()} tags`;
    }
}

@ValidatorConstraint({ name: 'fleetMaxCapabilityTagLength', async: false })
export class FleetMaxCapabilityTagLengthConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        if (typeof value !== 'string') return true;
        return value.length <= config.fleet.getMaxCapabilityTagLength();
    }

    defaultMessage(args: ValidationArguments): string {
        return `each value in ${args.property} must be shorter than or equal to ${config.fleet.getMaxCapabilityTagLength()} characters`;
    }
}

/** Array length <= the configured capability-tag cap (default 16). */
export function MaxConfiguredCapabilityTags(validationOptions?: ValidationOptions) {
    return function (object: object, propertyName: string): void {
        registerDecorator({
            target: object.constructor,
            propertyName,
            options: validationOptions,
            constraints: [],
            validator: FleetMaxCapabilityTagsConstraint,
        });
    };
}

/** Each tag <= the configured tag-length cap (default 32). Use with `{ each: true }`. */
export function MaxConfiguredCapabilityTagLength(validationOptions?: ValidationOptions) {
    return function (object: object, propertyName: string): void {
        registerDecorator({
            target: object.constructor,
            propertyName,
            options: validationOptions,
            constraints: [],
            validator: FleetMaxCapabilityTagLengthConstraint,
        });
    };
}

/** Most keys a reported consents object may carry (four today; room for later consents). */
export const FLEET_CONSENTS_MAX_KEYS = 16;
const CONSENT_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;

/**
 * Fleet node link (FL-02) — a heartbeat's `consents`: a plain object of at
 * most {@link FLEET_CONSENTS_MAX_KEYS} camel-case keys, every value a boolean.
 * Unknown keys pass (a newer node's fifth consent must not fail its beat);
 * the service keeps only the four it knows.
 */
@ValidatorConstraint({ name: 'fleetConsentsShape', async: false })
export class FleetConsentsShapeConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length > FLEET_CONSENTS_MAX_KEYS) return false;
        return entries.every(
            ([key, flag]) => CONSENT_KEY_PATTERN.test(key) && typeof flag === 'boolean',
        );
    }

    defaultMessage(args: ValidationArguments): string {
        return `${args.property} must be an object of at most ${FLEET_CONSENTS_MAX_KEYS} boolean consents`;
    }
}

export function IsFleetConsentsShape(validationOptions?: ValidationOptions) {
    return function (object: object, propertyName: string): void {
        registerDecorator({
            target: object.constructor,
            propertyName,
            options: validationOptions,
            constraints: [],
            validator: FleetConsentsShapeConstraint,
        });
    };
}
