import { Test, TestingModule } from '@nestjs/testing';
import { AiEngineService } from './ai-engine.service';

describe('AiEngineService', () => {
  let service: AiEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AiEngineService],
    }).compile();

    service = module.get<AiEngineService>(AiEngineService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
