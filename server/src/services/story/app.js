import { createServiceApp } from '../../shared/serviceApp.js';
import { Router } from 'express';
import { z } from 'zod';
import { serviceToken } from '../../config.js';
import { fromDoc, serviceDatabase, toObjectId } from '../../shared/db.js';
import { AppError, asyncHandler } from '../../shared/errors.js';
import { commandInput, objectIdInput } from '../../shared/commandInput.js';
import { internalAuth } from '../../shared/internalAuth.js';
import { publicationPageSize } from '../../shared/publishedStories.js';
import { createAuditClient } from '../../shared/auditClient.js';
import { createServiceClients } from '../../shared/serviceClients.js';
import { createStoryDao } from './dao/storyDao.js';
import { createSceneDao } from './dao/sceneDao.js';
import { mountStoryCreate } from './commands/storyCreate.js';
import { mountSceneCreate } from './commands/sceneCreate.js';
import { mountDecisionCreate } from './commands/decisionCreate.js';
import { mountStoryGet } from './commands/storyGet.js';
import { mountStoryList } from './commands/storyList.js';

const choiceInput = z.object({ storyId: objectIdInput, sceneId: objectIdInput, decisionId: objectIdInput });

function playableScene({ id, name, content, type, decisions }) {
  return { id, name, content, type, decisions: decisions.map(({ id: decisionId, text }) => ({ id: decisionId, text })) };
}

export function createStoryApp({
  db = serviceDatabase('story'), token = serviceToken, clients = createServiceClients(), router = Router(), ...options
} = {}) {
  // Veřejné příkazy (přes gateway pod /api/stories).
  const audit = createAuditClient(clients.audit, 'story');
  const storyDao = createStoryDao(db);
  const sceneDao = createSceneDao(db);
  mountStoryCreate(router, { stories: storyDao, audit, token });
  mountSceneCreate(router, { stories: storyDao, scenes: sceneDao, audit, token });
  mountDecisionCreate(router, { stories: storyDao, scenes: sceneDao, audit, token });
  mountStoryGet(router, { stories: storyDao, scenes: sceneDao, token });
  mountStoryList(router, { stories: storyDao, scenes: sceneDao, token });

  const internal = Router();
  const guard = internalAuth(token, { required: true });
  const stories = db.collection('stories');
  const fields = { name: 1, state: 1, description: 1, genre: 1, authorId: 1, publishedAt: 1 };

  // story/getPlayable (interní, pro playthrough/start): stav příběhu, počet scén a úvodní scéna.
  // Obsah konceptu nevrací a rozhodnutí jsou bez targetSceneId.
  internal.get('/story/getPlayable', guard, commandInput(z.object({ id: objectIdInput }), 'query'),
    asyncHandler(async (req, res) => {
      const { id } = req.dtoIn;
      const story = await storyDao.get(id);
      if (!story) throw new AppError(404, 'storyNotFound', 'Příběh nebyl nalezen.', { storyId: id });
      const meta = { id: story.id, name: story.name, state: story.state };
      if (story.state !== 'published') return res.json({ story: meta });
      const [counts, initial] = await Promise.all([sceneDao.countByStories([id]), sceneDao.getInitial(id)]);
      res.json({
        story: meta,
        sceneCount: counts.get(id),
        initialScene: initial && playableScene(initial),
      });
    }));
  internal.get('/playthrough/resolveDecision', guard, commandInput(choiceInput, 'query'), asyncHandler(async (req, res) => {
    const { storyId, sceneId, decisionId } = req.dtoIn;
    const story = await storyDao.get(storyId);
    if (!story) throw new AppError(404, 'storyNotFound', 'Příběh nebyl nalezen.', { storyId });
    if (story.state !== 'published') {
      throw new AppError(409, 'storyNotPublished', 'Příběh není dostupný pro hraní.', { storyId });
    }
    const source = await sceneDao.getInStory(storyId, sceneId);
    if (!source) throw new AppError(404, 'sceneNotFound', 'Aktuální scéna nebyla nalezena.', { sceneId });
    const decision = source.decisions.find((item) => item.id === decisionId);
    if (!decision || source.type === 'final') {
      throw new AppError(404, 'decisionNotFound', 'Tato volba v aktuální scéně není dostupná.', { decisionId });
    }
    const [target, counts] = await Promise.all([
      sceneDao.getInStory(storyId, decision.targetSceneId),
      sceneDao.countByStories([storyId]),
    ]);
    if (!target) throw new AppError(409, 'targetSceneNotFound', 'Cílová scéna nebyla nalezena.');
    res.json({ scene: playableScene(target), sceneCount: counts.get(storyId) });
  }));
  internal.get('/story/publishedPage', guard, commandInput(z.object({ after: objectIdInput.optional() }), 'query'),
    asyncHandler(async (req, res) => {
      const filter = { state: 'published' };
      if (req.dtoIn.after) filter._id = { $gt: toObjectId(req.dtoIn.after) };
      const rows = await stories.find(filter).project(fields).sort({ _id: 1 }).limit(publicationPageSize).toArray();
      res.json({ itemList: rows.map(fromDoc) });
    }));
  internal.post('/story/summaries', guard, commandInput(z.object({ storyIds: z.array(objectIdInput).min(1).max(100) }), 'body'),
    asyncHandler(async (req, res) => {
      const rows = await stories.aggregate([
        { $match: { _id: { $in: req.dtoIn.storyIds.map(toObjectId) } } },
        { $lookup: { from: 'scenes', localField: '_id', foreignField: 'storyId', pipeline: [{ $count: 'n' }], as: 'counts' } },
        { $project: { ...fields, sceneCount: { $ifNull: [{ $first: '$counts.n' }, 0] } } },
      ]).toArray();
      // Distinguish a deleted ID from a draft without returning draft content.
      const existing = new Set(rows.map((row) => row._id.toHexString()));
      res.json({
        itemList: rows.filter((row) => row.state === 'published').map(fromDoc),
        missingIds: req.dtoIn.storyIds.filter((id) => !existing.has(id)),
      });
    }));
  return createServiceApp({
    name: 'story',
    prefix: '/api/stories',
    dependencies: ['audit'],
    clients, token, router, internalRouter: internal,
    ...options,
  });
}
