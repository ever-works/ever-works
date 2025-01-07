import { Test, TestingModule } from '@nestjs/testing';
import { MarkdownGeneratorService } from './markdown-generator.service';

describe('MarkdownGeneratorService', () => {
  let service: MarkdownGeneratorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MarkdownGeneratorService],
    }).compile();

    service = module.get<MarkdownGeneratorService>(MarkdownGeneratorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
