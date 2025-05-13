import { Category } from './category.dto';
import { Tag } from './tag.dto';

export interface ItemData {
  name: string;
  description: string;
  featured?: boolean;
  source_url: string;
  category: string | string[] | Category | Category[];
  slug?: string;
  tags: string[] | Tag[];
}
