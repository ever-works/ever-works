import { describe, expect, it } from 'vitest';
import { getFormFields, getDefaultValues, validateFormInput } from '../form-schema.js';

describe('hermes-agent form schema', () => {
	it('provides stable defaults', () => {
		const fields = getFormFields();
		expect(getDefaultValues(fields)).toEqual({
			target_items: 50,
			capture_screenshots: false
		});
	});

	it('rejects invalid target_items values', () => {
		const result = validateFormInput({ target_items: 0 });
		expect(result.valid).toBe(false);
	});

	it('accepts valid inputs', () => {
		const result = validateFormInput({
			target_items: 25,
			capture_screenshots: true,
			generation_notes: 'Focus on enterprise tooling.'
		});
		expect(result.valid).toBe(true);
	});
});
