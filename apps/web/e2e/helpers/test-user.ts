/**
 * Test user credentials used across e2e tests.
 *
 * These are generated with a unique suffix so parallel runs don't collide.
 * For CI, you may want a seeded database or a cleanup step.
 */
const suffix = Date.now().toString(36);

export const TEST_USER = {
    name: `E2E Tester ${suffix}`,
    email: `e2e-${suffix}@test.local`,
    password: 'Test1234!secure',
};

/** A second user for multi-user scenarios */
export const TEST_USER_2 = {
    name: `E2E Tester2 ${suffix}`,
    email: `e2e2-${suffix}@test.local`,
    password: 'Test5678!secure',
};
