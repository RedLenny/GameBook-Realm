import { createServiceApp } from '../../shared/serviceApp.js';
import { Router } from 'express';
import { z } from 'zod';
import { serviceToken } from '../../config.js';
import { commandInput, pageInput } from '../../shared/commandInput.js';
import { serviceDatabase } from '../../shared/db.js';
import { AppError, asyncHandler } from '../../shared/errors.js';
import { gatewayPlayer } from '../../shared/internalAuth.js';
import { storySummaries } from '../../shared/publishedStories.js';
import { createServiceClients } from '../../shared/serviceClients.js';
import { createPlaythroughDao } from './dao/playthroughDao.js';
import { mountPlaythroughGetFinished } from './commands/playthroughGetFinished.js';
import { mountPlaythroughStart } from './commands/playthroughStart.js';
import { mountPlaythroughChooseDecision } from './commands/playthroughChooseDecision.js';
import { createAuditClient } from '../../shared/auditClient.js';

const listInput = pageInput.extend({
  pageInfo: pageInput.optional(),
  state: z.enum(['inProgress', 'finished']).default('inProgress'),
});

export function createGameplayApp({ db = serviceDatabase('gameplay'), token = serviceToken, clients = createServiceClients(), ...options } = {}) {
  const router = Router();
  const playthroughs = createPlaythroughDao(db);
  const internal = Router();
  mountPlaythroughGetFinished(internal, { playthroughs, token });
  const audit = createAuditClient(clients.audit, 'gameplay');
  mountPlaythroughStart(router, { playthroughs, storyClient: clients.story, audit, token });
  mountPlaythroughChooseDecision(router, { playthroughs, storyClient: clients.story, audit, token });
  router.get('/list', gatewayPlayer(token), commandInput(listInput, 'query'), asyncHandler(async (req, res) => {
    const { state } = req.dtoIn;
    const { pageIndex, pageSize } = req.dtoIn.pageInfo ?? req.dtoIn;
    try {
      const { items, total } = await playthroughs.listByPlayer(req.playerId, {
        state, skip: pageIndex * pageSize, limit: pageSize,
      });
      const ids = [...new Set(items.map((item) => item.storyId))];
      let summaries = new Map();
      let visited = new Map();
      if (ids.length) {
        const [result, counts] = await Promise.all([
          clients.story.request('/internal/story/summaries', {
            method: 'POST', body: { storyIds: ids }, requestId: req.requestId,
          }),
          playthroughs.visitedCounts(req.playerId, ids),
        ]);
        summaries = new Map(storySummaries.parse(result).itemList.map((story) => [story.id, story]));
        visited = counts;
      }
      const itemList = items.map((item) => {
        const story = summaries.get(item.storyId);
        const count = visited.get(item.storyId) || 0;
        return {
          id: item.id, storyId: item.storyId, storyName: story?.name ?? item.storyName ?? null,
          state: item.state, currentSceneId: item.currentSceneId, updatedAt: item.updatedAt,
          startedAt: item.startedAt, finishedAt: item.finishedAt ?? null,
          progressPercent: story?.sceneCount ? Math.min(100, Math.round(100 * count / story.sceneCount)) : null,
        };
      });
      res.json({ itemList, pageInfo: { pageIndex, pageSize, total }, uuAppErrorMap: req.uuAppErrorMap });
    } catch (error) {
      console.error({ requestId: req.requestId, code: error.code || error.name });
      throw new AppError(503, 'playthroughListFailed', 'Uložená hraní se nepodařilo načíst.');
    }
  }));
  return createServiceApp({
    name: 'gameplay',
    prefix: '/api/playthroughs',
    dependencies: ['story', 'audit'],
    clients, token, router, internalRouter: internal,
    ...options,
  });
}
