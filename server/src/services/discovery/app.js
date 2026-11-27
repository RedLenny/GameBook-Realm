import { createServiceApp } from '../../shared/serviceApp.js';
import { Router } from 'express';
import { z } from 'zod';
import { serviceToken } from '../../config.js';
import { commandInput, objectIdInput, pageInput } from '../../shared/commandInput.js';
import { serviceDatabase } from '../../shared/db.js';
import { AppError, asyncHandler } from '../../shared/errors.js';
import { gatewayPlayer, internalAuth } from '../../shared/internalAuth.js';
import { storySummaries } from '../../shared/publishedStories.js';
import { createServiceClients } from '../../shared/serviceClients.js';
import { createStoryIndexDao } from './dao/storyIndexDao.js';

export function createDiscoveryApp({ db = serviceDatabase('discovery'), token = serviceToken, clients = createServiceClients(), ...options } = {}) {
  const index = createStoryIndexDao(db);
  const internal = Router();
  const router = Router();
  const guard = internalAuth(token, { required: true });
  const byStory = z.object({ storyId: objectIdInput });
  async function lookup(storyId, requestId) {
    const result = await clients.story.request('/internal/story/summaries', {
      method: 'POST', body: { storyIds: [storyId] }, requestId,
    });
    return storySummaries.parse(result);
  }
  internal.post('/storyIndex/create', guard, commandInput(byStory, 'body'), asyncHandler(async (req, res) => {
    const { storyId } = req.dtoIn;
    const { itemList } = await lookup(storyId, req.requestId);
    const story = itemList.find((item) => item.id === storyId);
    if (!story) throw new AppError(404, 'storyNotPublished', 'Publikovaný příběh nenalezen.');
    await index.put(story);
    res.json({ storyId, uuAppErrorMap: req.uuAppErrorMap });
  }));
  internal.post('/storyIndex/delete', guard, commandInput(byStory, 'body'), asyncHandler(async (req, res) => {
    const { storyId } = req.dtoIn;
    const { missingIds } = await lookup(storyId, req.requestId);
    if (!missingIds.includes(storyId)) throw new AppError(409, 'storyStillExists', 'Příběh dosud existuje.');
    await index.remove(storyId);
    res.status(204).end();
  }));
  internal.get('/storyIndex/list', guard, commandInput(pageInput.extend({
    name: z.string().max(200).optional(), genre: z.string().max(100).optional(),
  }), 'query'), asyncHandler(async (req, res) => {
    const { pageIndex, pageSize, name, genre } = req.dtoIn;
    const { items, total } = await index.listPublished({ name, genre, limit: pageSize, skip: pageIndex * pageSize });
    res.json({ itemList: items, pageInfo: { pageIndex, pageSize, total }, uuAppErrorMap: req.uuAppErrorMap });
  }));

  const stats = asyncHandler(async (req, res) => {
    const { storyId } = req.dtoIn;
    const result = await index.getRatingStats(storyId);
    if (!result) throw new AppError(404, 'storyNotFound', 'Příběh nenalezen.');
    res.json({ storyId, ...result, uuAppErrorMap: req.uuAppErrorMap });
  });
  router.get('/rating/getStats', gatewayPlayer(token), commandInput(byStory, 'query'), stats);
  internal.get('/rating/getStats', guard, commandInput(byStory, 'query'), stats);
  // Refresh notifications can arrive out of order. Catalogue reads and this
  // reply both calculate the current totals from the saved votes.
  internal.post('/storyIndex/updateRating', guard, commandInput(byStory.extend({
    averageRating: z.number().min(1).max(5).nullable().optional(),
    ratingCount: z.number().int().nonnegative().optional(),
  }), 'body'), stats);
  return createServiceApp({
    name: 'discovery',
    prefix: '/api/discovery',
    dependencies: ['story'],
    clients, token, router, internalRouter: internal,
    ...options,
  });
}
