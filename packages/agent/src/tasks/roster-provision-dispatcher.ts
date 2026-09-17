import { RosterProvisionPayload } from './roster-provision.types';

export interface RosterProvisionDispatcher {
    dispatchRosterProvision(payload: RosterProvisionPayload): Promise<string | null>;
}

export const ROSTER_PROVISION_DISPATCHER = Symbol('ROSTER_PROVISION_DISPATCHER');
