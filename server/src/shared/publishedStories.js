import { z } from 'zod';
import { objectIdInput } from './commandInput.js';

// Only catalogue fields may leave Story through these endpoints.
export const publishedStory = z.object({
  id: objectIdInput,
  state: z.literal('published'),
  name: z.string(),
  description: z.string().nullish(),
  genre: z.string().nullish(),
  authorId: z.string(),
  publishedAt: z.string().datetime().nullable().default(null),
});
export const publicationPageSize = 100;
export const publicationPage = z.object({ itemList: z.array(publishedStory).max(publicationPageSize) });
export const storySummaries = z.object({
  itemList: z.array(publishedStory.extend({ sceneCount: z.number().int().nonnegative() })).max(100),
  missingIds: z.array(objectIdInput).max(100),
});
