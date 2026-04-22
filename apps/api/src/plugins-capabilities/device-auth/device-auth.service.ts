import { Injectable } from '@nestjs/common';
import { PluginOperationsService } from '@ever-works/agent/plugins';
import type { DeviceAuthStatus } from '@ever-works/plugin';

@Injectable()
export class DeviceAuthService {
    constructor(private readonly pluginOperations: PluginOperationsService) {}

    async getStatus(userId: string, pluginId: string): Promise<DeviceAuthStatus> {
        return this.pluginOperations.getPluginDeviceAuthStatus(pluginId, userId);
    }

    async start(userId: string, pluginId: string): Promise<DeviceAuthStatus> {
        return this.pluginOperations.startPluginDeviceAuth(pluginId, userId);
    }
}
