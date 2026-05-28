import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module';
import { ComposioTriggerSubscription } from '@ever-works/agent/entities';
import { ComposioTriggersController } from './composio-triggers.controller';
import { ComposioTriggersService } from './composio-triggers.service';

@Module({
    imports: [TypeOrmModule.forFeature([ComposioTriggerSubscription]), AuthModule],
    controllers: [ComposioTriggersController],
    providers: [ComposioTriggersService],
    exports: [ComposioTriggersService],
})
export class ComposioTriggersModule {}
