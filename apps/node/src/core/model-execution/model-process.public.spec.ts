import { describe, expect, it } from 'vitest';

import * as nodeCore from '../index';

describe('model process public API', () => {
	it('exports only the trusted production executor factory, never runtime interception seams', () => {
		expect(nodeCore).toHaveProperty('createModelProcessExecutor');
		expect(nodeCore).not.toHaveProperty('executeModelProcess');
		expect(nodeCore).not.toHaveProperty('executeModelProcessForTest');
	});
});
