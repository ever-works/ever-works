import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { FacadesModule } from '@ever-works/agent/facades';
import { AuthModule } from '../../auth/auth.module';

@Module({
    imports: [FacadesModule, AuthModule],
    controllers: [SearchController],
})
export class SearchModule {}
