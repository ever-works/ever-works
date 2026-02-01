import {
    ValidatorConstraint,
    ValidatorConstraintInterface,
    ValidationArguments,
    registerDecorator,
    ValidationOptions,
} from 'class-validator';
import {
    ALL_PLUGIN_CAPABILITIES,
    isValidPluginCapability,
    type PluginCapability,
} from '@ever-works/plugin';

/**
 * Validator constraint to check if a string is a valid capability.
 * Uses the centralized capability list from @ever-works/plugin.
 */
@ValidatorConstraint({ name: 'isValidCapability', async: false })
export class IsValidCapabilityConstraint implements ValidatorConstraintInterface {
    validate(capability: unknown, args: ValidationArguments): boolean {
        return isValidPluginCapability(capability);
    }

    defaultMessage(args: ValidationArguments): string {
        const value = args.value;
        return `'${value}' is not a valid capability. Valid capabilities are: ${ALL_PLUGIN_CAPABILITIES.join(', ')}`;
    }
}

/**
 * Decorator to validate that a property is a valid plugin capability.
 *
 * @example
 * ```typescript
 * class MyDto {
 *     @IsValidCapability()
 *     activeCapability: string;
 * }
 * ```
 */
export function IsValidCapability(validationOptions?: ValidationOptions) {
    return function (object: object, propertyName: string) {
        registerDecorator({
            target: object.constructor,
            propertyName: propertyName,
            options: validationOptions,
            constraints: [],
            validator: IsValidCapabilityConstraint,
        });
    };
}

// Re-export from plugin package for convenience
export { isValidPluginCapability as isValidCapability, type PluginCapability as ValidCapability };

/**
 * Get the list of all valid capabilities.
 */
export function getValidCapabilities(): readonly string[] {
    return ALL_PLUGIN_CAPABILITIES;
}
