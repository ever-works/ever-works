import { initSentry, initPostHog, trackEvent } from '../index';

/**
 * Test script to validate Sentry and PostHog integrations
 */
async function testIntegrations() {
    console.log('🧪 Testing monitoring integrations...\n');

    // Test Sentry initialization
    console.log('📊 Testing Sentry initialization...');
    const sentryInitialized = initSentry({
        dsn: process.env.SENTRY_DSN || 'https://test@sentry.io/123',
        environment: 'test',
    });
    console.log(`Sentry initialized: ${sentryInitialized ? '✅' : '❌'}`);

    // Test PostHog initialization
    console.log('📈 Testing PostHog initialization...');
    const posthogInitialized = initPostHog({
        apiKey: process.env.POSTHOG_API_KEY || 'test-key',
        host: 'https://app.posthog.com',
    });
    console.log(`PostHog initialized: ${posthogInitialized ? '✅' : '❌'}`);

    // Test PostHog event tracking
    if (posthogInitialized) {
        console.log('📊 Testing PostHog event tracking...');
        try {
            trackEvent('test-user', 'integration_test', {
                test: true,
                timestamp: new Date().toISOString(),
            });
            console.log('PostHog event tracking: ✅');
        } catch (error) {
            console.log('PostHog event tracking: ❌', error.message);
        }
    }

    // Test Sentry error capture
    if (sentryInitialized) {
        console.log('🚨 Testing Sentry error capture...');
        try {
            const Sentry = await import('@sentry/nestjs');
            Sentry.captureException(new Error('Test error for integration validation'));
            console.log('Sentry error capture: ✅');
        } catch (error) {
            console.log('Sentry error capture: ❌', error.message);
        }
    }

    console.log('\n🎉 Integration tests completed!');
    console.log('\n📝 Note: Check your Sentry and PostHog dashboards to verify events are being received.');
}

// Run tests if this file is executed directly
if (require.main === module) {
    testIntegrations().catch(console.error);
}

export { testIntegrations };
