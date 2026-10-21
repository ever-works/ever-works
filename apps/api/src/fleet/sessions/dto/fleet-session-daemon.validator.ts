import {
    registerDecorator,
    ValidatorConstraint,
    type ValidationArguments,
    type ValidationOptions,
    type ValidatorConstraintInterface,
} from 'class-validator';

/** Most keys a reported daemon block may carry (five today; room for later fields). */
export const FLEET_SESSION_DAEMON_MAX_KEYS = 16;
const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,47}$/;

/**
 * Sessions on computers (FL-04, CONTRACTS §1.1) — a heartbeat's `daemon`
 * block: a small plain object `{ state, reason?, sessions, storage?, hooks? }`.
 *
 * Shape-checked here, not as a nested whitelisted class, for the reason the
 * consents validator gives: under `whitelist + forbidNonWhitelisted` a nested
 * class would 400 the whole beat the day a newer node reports one more key,
 * and the node would then strip the block for the life of its process.
 * Unknown keys pass; the service keeps only what it knows
 * (`normalizeFleetSessionDaemonReport`). Bounded so a beat can never carry a
 * large blob through it.
 */
@ValidatorConstraint({ name: 'fleetSessionDaemonShape', async: false })
export class FleetSessionDaemonShapeConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
        const record = value as Record<string, unknown>;
        const entries = Object.entries(record);
        if (entries.length > FLEET_SESSION_DAEMON_MAX_KEYS) return false;
        if (!entries.every(([key]) => KEY_PATTERN.test(key))) return false;
        if (typeof record.state !== 'string' || record.state.length > 16) return false;
        if (
            record.reason !== undefined &&
            (typeof record.reason !== 'string' || record.reason.length > 1000)
        )
            return false;
        if (
            record.sessions !== undefined &&
            (typeof record.sessions !== 'number' || !Number.isFinite(record.sessions))
        )
            return false;
        if (
            record.storage !== undefined &&
            (typeof record.storage !== 'string' || record.storage.length > 16)
        )
            return false;
        if (record.hooks !== undefined) {
            if (
                typeof record.hooks !== 'object' ||
                record.hooks === null ||
                Array.isArray(record.hooks)
            )
                return false;
            const hooks = Object.entries(record.hooks as Record<string, unknown>);
            if (hooks.length > FLEET_SESSION_DAEMON_MAX_KEYS) return false;
            if (!hooks.every(([key, count]) => KEY_PATTERN.test(key) && typeof count === 'number'))
                return false;
        }
        // Any other key: a scalar, so nothing large rides through.
        for (const [key, inner] of entries) {
            if (['state', 'reason', 'sessions', 'storage', 'hooks'].includes(key)) continue;
            if (typeof inner === 'object' && inner !== null) return false;
            if (typeof inner === 'string' && inner.length > 200) return false;
        }
        return true;
    }

    defaultMessage(args: ValidationArguments): string {
        return `${args.property} must be a small session daemon report ({ state, reason?, sessions, storage?, hooks? })`;
    }
}

export function IsFleetSessionDaemonShape(validationOptions?: ValidationOptions) {
    return function (object: object, propertyName: string): void {
        registerDecorator({
            target: object.constructor,
            propertyName,
            options: validationOptions,
            constraints: [],
            validator: FleetSessionDaemonShapeConstraint,
        });
    };
}
