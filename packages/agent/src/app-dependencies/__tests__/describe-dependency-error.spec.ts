import {
    MAX_CAUSE_DEPTH,
    MAX_PART_CHARS,
    describeDependencyError,
} from '../describe-dependency-error';

/**
 * `describeDependencyError` — the one log line the App dependency path prints for a failure.
 *
 * It exists because the provision runner logged `error.name` alone, so a prod run read
 * `failed / clusterUnreachable` and said nothing about what failed. These cases pin the two
 * halves of its job: say what failed (name, code, message, cause chain), and never print the
 * credential the call was made with (a kubeconfig: a ServiceAccount JWT, PEM / base64 key data).
 */
describe('describeDependencyError', () => {
    it("prints the error's name, code and message", () => {
        const error = Object.assign(new Error('Managed App namespaces must start with ewapp-'), {
            name: 'K8sPluginError',
            code: 'NOT_CONFIGURED',
        });

        expect(describeDependencyError(error)).toBe(
            'K8sPluginError [NOT_CONFIGURED]: Managed App namespaces must start with ewapp-',
        );
    });

    it('follows the cause chain, numeric codes included', () => {
        const socket = Object.assign(new Error('connect ECONNREFUSED 192.168.1.210:6443'), {
            code: 'ECONNREFUSED',
        });
        const fetchFailed = new TypeError('fetch failed', { cause: socket });
        const api = Object.assign(new Error('HTTP request failed', { cause: fetchFailed }), {
            code: 503,
        });

        expect(describeDependencyError(api)).toBe(
            'Error [503]: HTTP request failed <- caused by TypeError: fetch failed' +
                ' <- caused by Error [ECONNREFUSED]: connect ECONNREFUSED 192.168.1.210:6443',
        );
    });

    it("reads an AggregateError's first error as its cause", () => {
        const aggregate = new AggregateError(
            [new Error('getaddrinfo ENOTFOUND k8s.example')],
            'All attempts failed',
        );

        expect(describeDependencyError(aggregate)).toBe(
            'AggregateError: All attempts failed <- caused by Error: getaddrinfo ENOTFOUND k8s.example',
        );
    });

    it('stops at the depth bound and on a cycle', () => {
        let chain: Error = new Error('root');
        for (let i = 0; i < 10; i++) chain = new Error(`level ${i}`, { cause: chain });
        expect(describeDependencyError(chain).split(' <- caused by ')).toHaveLength(
            MAX_CAUSE_DEPTH + 1,
        );

        const a = new Error('a');
        const b = new Error('b', { cause: a });
        (a as { cause?: unknown }).cause = b;
        expect(describeDependencyError(a)).toBe('Error: a <- caused by Error: b');
    });

    it('never prints kubeconfig credential material', () => {
        const jwt =
            'eyJhbGciOiJSUzI1NiIsImtpZCI6IngifQ.eyJpc3MiOiJrdWJlcm5ldGVzL3NlcnZpY2VhY2NvdW50In0.' +
            'c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';
        const keyData = 'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t'.repeat(6);
        const pem =
            '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
        const error = new Error(
            `could not load kubeconfig: users:\n- name: x\n  user:\n    token: ${jwt}\n` +
                `    client-key-data: ${keyData}\n${pem}\nAuthorization: Bearer ${jwt}`,
        );

        const line = describeDependencyError(error);

        expect(line).not.toContain(jwt);
        expect(line).not.toContain(keyData.slice(0, 40));
        expect(line).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
        expect(line).toContain('could not load kubeconfig');
    });

    it('keeps resource names and API groups readable', () => {
        const error = new Error(
            'pods "helper-pod-create-pvc-cb06a44f-5107-4bd2-8f1a-2b7477599819" is forbidden: ' +
                'violates PodSecurity "baseline:latest"; rolebindings.rbac.authorization.k8s.io',
        );

        expect(describeDependencyError(error)).toBe(`Error: ${error.message}`);
    });

    it('collapses whitespace and bounds each part', () => {
        const error = new Error(`line one\n\n   line two ${'x'.repeat(2 * MAX_PART_CHARS)}`);
        const line = describeDependencyError(error);

        expect(line.startsWith('Error: line one line two ')).toBe(true);
        expect(line.length).toBeLessThanOrEqual('Error: '.length + MAX_PART_CHARS + 1);
    });

    it('describes a thrown non-Error without stringifying it', () => {
        expect(describeDependencyError({ toString: () => 'token: secret' })).toBe(
            'a non-Error value (object)',
        );
        expect(describeDependencyError(null)).toBe('a non-Error value (null)');
        expect(describeDependencyError('plain failure')).toBe('plain failure');
    });
});
