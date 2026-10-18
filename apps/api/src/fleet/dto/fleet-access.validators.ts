import {
    registerDecorator,
    ValidationArguments,
    ValidationOptions,
    ValidatorConstraint,
    ValidatorConstraintInterface,
} from 'class-validator';
import { FLEET_ACTION_FAMILIES, isFleetActionFamily, isFleetAudience } from '@ever-works/contracts';

/**
 * Fleet hub (FL-01) — edge validation of a control-policy family map
 * (`PATCH /api/fleet/nodes/:id { controlPolicyFamilies }`): a non-empty
 * object whose every key is an action family and every value an audience
 * (CONTRACTS §2.1). Anything else is a 400 here, before the service — which
 * re-validates as the source of truth — is reached. Unknown keys are a
 * refusal, not something to drop: the owner asked for a change and must be
 * told it was not made.
 */
@ValidatorConstraint({ name: 'fleetControlPolicyFamilies', async: false })
export class FleetControlPolicyFamiliesConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        // Non-objects are `@IsObject`'s problem, not ours.
        if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return false;
        return entries.every(
            ([family, audience]) => isFleetActionFamily(family) && isFleetAudience(audience),
        );
    }

    defaultMessage(args: ValidationArguments): string {
        return `${args.property} must map one or more of ${FLEET_ACTION_FAMILIES.join(', ')} to owner, org-admins or org-members`;
    }
}

/** A non-empty family → audience map. */
export function IsFleetControlPolicyFamilies(validationOptions?: ValidationOptions) {
    return function (object: object, propertyName: string): void {
        registerDecorator({
            target: object.constructor,
            propertyName,
            options: validationOptions,
            constraints: [],
            validator: FleetControlPolicyFamiliesConstraint,
        });
    };
}
