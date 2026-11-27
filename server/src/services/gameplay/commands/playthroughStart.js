import { z } from 'zod';
import { commandInput, objectIdInput } from '../../../shared/commandInput.js';
import { DuplicateKeyError } from '../../../shared/db.js';
import { AppError, asyncHandler } from '../../../shared/errors.js';
import { gatewayPlayer } from '../../../shared/internalAuth.js';

const OPERATION = 'playthrough/start';

// dtoIn podle Application Modelu (Command startPlaythrough).
export const playthroughStartSchema = z.object({
  storyId: objectIdInput,
  restart: z.boolean().default(false),
});

// Odpověď interního story/getPlayable.
const playableStory = z.object({
  story: z.object({ id: objectIdInput, name: z.string(), state: z.string() }),
  sceneCount: z.number().int().positive().optional(),
  initialScene: z.object({
    id: objectIdInput,
    name: z.string(),
    content: z.string(),
    type: z.string(),
    decisions: z.array(z.object({ id: objectIdInput, text: z.string() })),
  }).nullable().optional(),
});

// POST /api/playthroughs/start (přes gateway), profily Users a Authorities.
// Hráč má nejvýše jedno rozehrané hraní příběhu; s restart se staré hraní ukončí (abandoned).
export function mountPlaythroughStart(router, { playthroughs, storyClient, audit, token }) {
  router.post('/start', gatewayPlayer(token), commandInput(playthroughStartSchema, 'body'),
    asyncHandler(async (req, res) => {
      const { storyId, restart } = req.dtoIn;
      const { requestId, playerId } = req;
      const record = {
        actorId: playerId,
        actorProfiles: ['Users'],
        operation: OPERATION,
        entityType: 'playthrough',
        storyId,
        detail: { restart },
      };
      const fail = async (result, status, code, message, details) => {
        await audit.tryCreate({ ...record, result, errorCode: code }, { requestId });
        return new AppError(status, code, message, details);
      };
      const logError = (error) => console.error({ requestId, operation: OPERATION, code: error.code, error: error.message });
      const inProgress = (playthroughId) => fail('denied', 409, 'playthroughInProgress',
        'Hráč už má tento příběh rozehraný.', { playthroughId });

      // 2. Příběh existuje, je publikovaný a má úvodní scénu.
      let playable;
      try {
        playable = playableStory.parse(await storyClient.request(`/internal/story/getPlayable?id=${storyId}`, { requestId }));
      } catch (error) {
        if (error instanceof AppError && error.code === 'storyNotFound') {
          throw await fail('denied', 404, 'storyNotFound', 'Příběh neexistuje.', { storyId });
        }
        logError(error);
        throw await fail('error', 503, 'sceneLoadFailed', 'Scénu se nepodařilo načíst.', { storyId });
      }
      const { story, sceneCount, initialScene } = playable;
      if (story.state !== 'published') {
        throw await fail('denied', 409, 'storyNotPublished', 'Příběh není dostupný pro hraní.', { storyId, state: story.state });
      }
      if (!initialScene) {
        throw await fail('denied', 409, 'initialSceneNotFound', 'Příběh nelze spustit, protože nemá úvodní scénu.', { storyId });
      }

      // 3.–4. Rozehrané hraní a vytvoření nového.
      let playthrough;
      try {
        const existing = await playthroughs.findInProgress(storyId, playerId);
        if (existing) {
          if (!restart) throw await inProgress(existing.id);
          if (await playthroughs.abandon(existing.id)) record.detail.abandonedPlaythroughId = existing.id;
        }
        playthrough = await playthroughs.create({
          storyId, playerId, initialSceneId: initialScene.id, storyName: story.name,
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        // Souběžné zahájení zastaví unikátní index.
        if (error instanceof DuplicateKeyError) {
          const current = await playthroughs.findInProgress(storyId, playerId).catch(() => null);
          throw await inProgress(current?.id ?? null);
        }
        logError(error);
        throw await fail('error', 500, 'playthroughCreateFailed', 'Hraní se nepodařilo vytvořit.', {});
      }
      await audit.tryCreate({ ...record, entityId: playthrough.id, result: 'success' }, { requestId });

      // Postup: různé scény navštívené ve všech hraních hráče v příběhu / počet scén příběhu.
      const visitedSceneCount = (await playthroughs.visitedCounts(playerId, [storyId])).get(storyId);
      res.status(201).json({
        playthrough: {
          id: playthrough.id,
          storyId: playthrough.storyId,
          storyName: playthrough.storyName,
          state: playthrough.state,
          currentSceneId: playthrough.currentSceneId,
          startedAt: playthrough.startedAt,
        },
        currentScene: {
          id: initialScene.id,
          name: initialScene.name,
          content: initialScene.content,
          type: initialScene.type,
          decisionList: initialScene.decisions,
        },
        progress: {
          visitedSceneCount,
          totalSceneCount: sceneCount,
          percent: Math.round((100 * visitedSceneCount) / sceneCount),
        },
        uuAppErrorMap: req.uuAppErrorMap,
      });
    }));
}
