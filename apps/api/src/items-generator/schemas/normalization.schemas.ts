import { z } from 'zod';

export const normalizedNameSchema = z.object({
  original_name: z.string(),
  normalized_name: z
    .string()
    .describe('The canonical, standardized form of the original name.'),
});

export const normalizedNamesListSchema = z.object({
  normalized_names: z
    .array(normalizedNameSchema)
    .describe('A list of original names and their normalized counterparts.'),
});

export const categoryDescriptionSchema = z.object({
  category_name: z.string(),
  description: z
    .string()
    .describe(
      'A brief, informative description of the category, suitable for an Awesome List.',
    ),
});