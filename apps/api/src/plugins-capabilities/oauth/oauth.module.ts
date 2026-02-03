import { Module } from '@nestjs/common';
import { FacadesModule } from '@packages/agent/facades';
import { DatabaseModule } from '@packages/agent/database';
import { PluginsModule } from '@packages/agent/plugins';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';

@Module({
    imports: [FacadesModule, DatabaseModule, PluginsModule],
    controllers: [OAuthController],
    providers: [OAuthService],
    exports: [OAuthService],
})
export class OAuthModule {}
