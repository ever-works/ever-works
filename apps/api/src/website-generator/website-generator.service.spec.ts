import { Test, TestingModule } from '@nestjs/testing';
import { WebsiteGeneratorService } from './website-generator.service';

describe('WebsiteGeneratorService', () => {
  let service: WebsiteGeneratorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WebsiteGeneratorService],
    }).compile();

    service = module.get<WebsiteGeneratorService>(WebsiteGeneratorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
