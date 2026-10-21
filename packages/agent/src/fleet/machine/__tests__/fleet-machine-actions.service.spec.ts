import { makeFleetLinkError } from '@ever-works/contracts';
import { FleetMachineActionsService } from '../fleet-machine-actions.service';
import { FleetMachineException, readFleetMachineError } from '../fleet-machine.errors';
import type { FleetMachineNodePort, FleetMachineNodeRequest } from '../fleet-machine-node.port';

/**
 * FL-09 P1 — the machine-actions service: the gate before the confirmation,
 * the confirmation before the machine, and exactly one audit row per act
 * (none for a prompt, none for a caller who may not see the machine).
 */

const FACTS = { id: 'node-1', userId: 'owner-1', name: 'build-01' };
const OWNER = { kind: 'user' as const, userId: 'owner-1' };

function setup(
    reply: (input: FleetMachineNodeRequest) => unknown,
    options: { authorize?: () => Promise<typeof FACTS> } = {},
) {
    const requests: FleetMachineNodeRequest[] = [];
    const port: FleetMachineNodePort = {
        authorize: jest.fn(options.authorize ?? (async () => FACTS)),
        request: jest.fn(async (input: FleetMachineNodeRequest) => {
            requests.push(input);
            const answer = reply(input);
            if (answer instanceof Error) throw answer;
            return answer as never;
        }),
        describe: jest.fn(async () => FACTS),
    };
    const audit = { tryRecord: jest.fn(async () => true) };
    const service = new FleetMachineActionsService(port, audit as never);
    return { service, port, audit, requests };
}

async function caught(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        return readFleetMachineError(error);
    }
    throw new Error('expected a refusal');
}

describe('FleetMachineActionsService', () => {
    it('asks for confirmation before contacting the machine, and audits nothing', async () => {
        const { service, requests, audit } = setup(() => ({ result: {} }));
        const refusal = await caught(service.serviceAction('node-1', OWNER, { name: 'nginx', action: 'restart' }));
        expect(refusal).toMatchObject({
            code: 'confirmation_required',
            details: { class: 'confirm', summary: 'Restart nginx on build-01?' },
        });
        expect(requests).toHaveLength(0);
        expect(audit.tryRecord).not.toHaveBeenCalled();
    });

    it('runs a confirmed act and writes one ok row with the requester', async () => {
        const { service, requests, audit } = setup(() => ({
            result: { name: 'postgresql', scope: 'system', action: 'start', state: 'running', viaRoot: true },
        }));
        const result = await service.serviceAction('node-1', OWNER, {
            name: 'postgresql',
            action: 'start',
            fields: { confirm: true },
        });
        expect(result).toMatchObject({ state: 'running' });
        expect(requests[0]).toMatchObject({
            verb: 'services.action',
            actionFamily: 'services',
            stateChanging: true,
            params: { name: 'postgresql', action: 'start', scope: 'system', acknowledgeBlastRadius: false },
        });
        expect(audit.tryRecord).toHaveBeenCalledTimes(1);
        expect(audit.tryRecord).toHaveBeenCalledWith({
            action: 'node.service.start',
            actorUserId: 'owner-1',
            ownerUserId: 'owner-1',
            nodeId: 'node-1',
            details: expect.objectContaining({
                family: 'services',
                target: 'postgresql',
                requestedBy: 'user:owner-1',
                confirmationClass: 'confirm',
                outcome: 'ok',
                rootRequired: true,
            }),
        });
    });

    it('passes the node blast-radius prompt through with the title, unaudited', async () => {
        const { service, audit } = setup(
            () =>
                new FleetMachineException(
                    makeFleetLinkError('confirmation_required', 'This stops the network service…', {
                        class: 'blast-radius',
                        sentence: 'This stops the network service…',
                        blastRadiusKind: 'network',
                    }),
                ),
        );
        const refusal = await caught(
            service.serviceAction('node-1', OWNER, { name: 'NetworkManager', action: 'stop', fields: { confirm: true } }),
        );
        expect(refusal).toMatchObject({
            code: 'confirmation_required',
            details: { class: 'blast-radius', blastRadiusKind: 'network', summary: 'Stop NetworkManager on build-01?' },
        });
        expect(audit.tryRecord).not.toHaveBeenCalled();
    });

    it('audits an acknowledged blast-radius act under the blast-radius class', async () => {
        const { service, requests, audit } = setup(() => ({
            result: {
                name: 'NetworkManager',
                action: 'stop',
                state: 'inactive',
                blastRadius: { kind: 'network', sentence: 'x' },
            },
        }));
        await service.serviceAction('node-1', OWNER, {
            name: 'NetworkManager',
            action: 'stop',
            fields: { confirm: true, acknowledgeBlastRadius: true },
        });
        expect(requests[0].params.acknowledgeBlastRadius).toBe(true);
        expect(audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                details: expect.objectContaining({ confirmationClass: 'blast-radius', blastRadiusKind: 'network' }),
            }),
        );
    });

    it('surfaces root_required with the command as the hint and audits it refused', async () => {
        const { service, audit } = setup(
            () =>
                new FleetMachineException(
                    makeFleetLinkError('root_required', 'sudo systemctl restart nginx', {
                        command: 'sudo systemctl restart nginx',
                        shell: 'sh',
                    }),
                ),
        );
        const refusal = await caught(
            service.serviceAction('node-1', OWNER, { name: 'nginx', action: 'restart', fields: { confirm: true } }),
        );
        expect(refusal).toMatchObject({ code: 'root_required', hint: 'sudo systemctl restart nginx' });
        expect(audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'node.service.restart',
                details: expect.objectContaining({ outcome: 'refused', code: 'root_required', rootRequired: true }),
            }),
        );
    });

    it('audits a gate refusal for the owner to see, but never a not_found', async () => {
        const denied = setup(() => ({ result: {} }), {
            authorize: async () => {
                throw new FleetMachineException(makeFleetLinkError('permission_denied', 'ask the owner'));
            },
        });
        await caught(denied.service.signalProcess('node-1', OWNER, { pid: 4812, signal: 'TERM', fields: { confirm: true } }));
        expect(denied.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'node.process.signal',
                ownerUserId: 'owner-1',
                details: expect.objectContaining({ outcome: 'refused', code: 'permission_denied', signal: 'SIGTERM' }),
            }),
        );

        const hidden = setup(() => ({ result: {} }), {
            authorize: async () => {
                throw new FleetMachineException(makeFleetLinkError('not_found', 'no such computer'));
            },
        });
        await caught(hidden.service.signalProcess('node-1', OWNER, { pid: 4812, signal: 'TERM', fields: { confirm: true } }));
        expect(hidden.audit.tryRecord).not.toHaveBeenCalled();
    });

    it('names an Agent as the requester and its owner as the actor', async () => {
        const { service, audit } = setup(() => ({ result: { pid: 4812, signal: 'TERM', sent: true, stillRunningAfterMs: null } }));
        await service.signalProcess(
            'node-1',
            { kind: 'agent', agentId: 'ops-agent', ownerUserId: 'owner-1' },
            { pid: 4812, signal: 'TERM', fields: { confirm: true } },
        );
        expect(audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                actorUserId: 'owner-1',
                details: expect.objectContaining({ requestedBy: 'agent:ops-agent' }),
            }),
        );
    });

    it('hands back the operation of an act that ran over the inline window', async () => {
        const { service, audit } = setup(() => ({ operationId: 'op-1', operation: { id: 'op-1' } }));
        const result = await service.serviceAction('node-1', OWNER, {
            name: 'nginx',
            action: 'restart',
            fields: { confirm: true },
        });
        expect(result).toEqual({ operationId: 'op-1' });
        expect(audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({ details: expect.objectContaining({ outcome: 'ok', operationId: 'op-1' }) }),
        );
    });

    it('reads lists under the view family, unaudited', async () => {
        const { service, requests, audit } = setup(() => ({ result: { services: [], managers: ['systemd'] } }));
        await service.listServices('node-1', OWNER, { find: 'nginx' });
        expect(requests[0]).toMatchObject({
            verb: 'services.list',
            actionFamily: 'view',
            stateChanging: false,
            params: { scope: 'all', find: 'nginx' },
        });
        expect(audit.tryRecord).not.toHaveBeenCalled();
    });

    it('answers unreachable without a node port', async () => {
        const service = new FleetMachineActionsService();
        const refusal = await caught(service.listProcesses('node-1', OWNER));
        expect(refusal?.code).toBe('unreachable');
    });
});
