import { Module, Global } from '@nestjs/common';
import { ApiClientService } from './api-client.service.js';

@Global()
@Module({
	providers: [ApiClientService],
	exports: [ApiClientService]
})
export class ApiClientModule {}
