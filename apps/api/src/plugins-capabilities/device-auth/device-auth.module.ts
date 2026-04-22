import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { DeviceAuthController } from './device-auth.controller';
import { DeviceAuthService } from './device-auth.service';

@Module({
    imports: [AuthModule],
    controllers: [DeviceAuthController],
    providers: [DeviceAuthService],
})
export class DeviceAuthModule {}
