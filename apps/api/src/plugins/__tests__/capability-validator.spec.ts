import {
    IsValidCapabilityConstraint,
    isValidCapability,
    getValidCapabilities,
} from '../dto/validators/capability.validator';

describe('Capability Validator', () => {
    describe('IsValidCapabilityConstraint', () => {
        let validator: IsValidCapabilityConstraint;

        beforeEach(() => {
            validator = new IsValidCapabilityConstraint();
        });

        it('should validate known capabilities', () => {
            expect(validator.validate('ai-provider', {} as any)).toBe(true);
            expect(validator.validate('search', {} as any)).toBe(true);
            expect(validator.validate('screenshot', {} as any)).toBe(true);
            expect(validator.validate('content-extractor', {} as any)).toBe(true);
            expect(validator.validate('data-source', {} as any)).toBe(true);
            expect(validator.validate('pipeline-step', {} as any)).toBe(true);
            expect(validator.validate('full-pipeline', {} as any)).toBe(true);
            expect(validator.validate('form-schema-provider', {} as any)).toBe(true);
            expect(validator.validate('deployment', {} as any)).toBe(true);
            expect(validator.validate('git-provider', {} as any)).toBe(true);
        });

        it('should reject unknown capabilities', () => {
            expect(validator.validate('unknown-capability', {} as any)).toBe(false);
            expect(validator.validate('foo', {} as any)).toBe(false);
            expect(validator.validate('bar-baz', {} as any)).toBe(false);
        });

        it('should reject non-string values', () => {
            expect(validator.validate(123, {} as any)).toBe(false);
            expect(validator.validate(null, {} as any)).toBe(false);
            expect(validator.validate(undefined, {} as any)).toBe(false);
            expect(validator.validate({}, {} as any)).toBe(false);
            expect(validator.validate([], {} as any)).toBe(false);
        });

        it('should provide a descriptive error message', () => {
            const message = validator.defaultMessage({ value: 'invalid-cap' } as any);
            expect(message).toContain("'invalid-cap' is not a valid capability");
            expect(message).toContain('Valid capabilities are:');
        });
    });

    describe('isValidCapability', () => {
        it('should return true for valid capabilities', () => {
            expect(isValidCapability('ai-provider')).toBe(true);
            expect(isValidCapability('search')).toBe(true);
            expect(isValidCapability('pipeline-step')).toBe(true);
        });

        it('should return false for invalid capabilities', () => {
            expect(isValidCapability('invalid')).toBe(false);
            expect(isValidCapability('')).toBe(false);
            expect(isValidCapability(123 as any)).toBe(false);
        });
    });

    describe('getValidCapabilities', () => {
        it('should return all valid capabilities', () => {
            const capabilities = getValidCapabilities();
            expect(capabilities).toContain('ai-provider');
            expect(capabilities).toContain('search');
            expect(capabilities).toContain('screenshot');
            expect(capabilities).toContain('content-extractor');
            expect(capabilities).toContain('data-source');
            expect(capabilities).toContain('pipeline-step');
            expect(capabilities).toContain('full-pipeline');
            expect(capabilities).toContain('form-schema-provider');
            expect(capabilities).toContain('deployment');
            expect(capabilities).toContain('git-provider');
            expect(capabilities.length).toBeGreaterThan(0);
        });
    });
});
