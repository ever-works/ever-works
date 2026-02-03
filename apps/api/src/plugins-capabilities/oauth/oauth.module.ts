import { Module } from '@nestjs/common';
import { FacadesModule } from '@packages/agent/facades';
import { DatabaseModule } from '@packages/agent/database';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';

/**
 * OAuth module for plugin OAuth flow handling.
 *
 * Note: This module relies on PluginsModule being registered globally via forRoot()
 * at the application root level. Do not import PluginsModule directly here.
 */
@Module({
    imports: [FacadesModule, DatabaseModule],
    controllers: [OAuthController],
    providers: [OAuthService],
    exports: [OAuthService],
})
export class OAuthModule {}
