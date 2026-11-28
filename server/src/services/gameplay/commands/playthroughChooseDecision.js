import { z } from 'zod';
import { commandInput, objectIdInput } from '../../../shared/commandInput.js';
import { AppError, asyncHandler } from '../../../shared/errors.js';
import { gatewayPlayer } from '../../../shared/internalAuth.js';
import { currentSceneDto, playableScene } from './playthroughStart.js';

const OPERATION = 'playthrough/chooseDecision';
export const playthroughChooseDecisionSchema = z.object({ playthroughId: objectIdInput, decisionId: objectIdInput });
const transition = z.object({ scene: playableScene, sceneCount: z.number().int().positive() });
const rejectedTransitionCodes = new Set(['storyNotFound', 'storyNotPublished', 'sceneNotFound', 'decisionNotFound']);

export function mountPlaythroughChooseDecision(router, { playthroughs, storyClient, audit, token }) {
  router.post('/chooseDecision', gatewayPlayer(token), commandInput(playthroughChooseDecisionSchema, 'body'),
    asyncHandler(async (req, res) => {
      const { playthroughId, decisionId } = req.dtoIn;
      const { requestId, playerId } = req;
      const record = {
        actorId: playerId, actorProfiles: ['Users'], operation: OPERATION,
        entityType: 'playthrough', entityId: playthroughId, storyId: null, detail: { decisionId },
      };

      let updated, next;
      try {
        const run = await playthroughs.get(playthroughId);
        if (!run) throw new AppError(404, 'playthroughNotFound', 'Hraní nebylo nalezeno.');
        if (run.playerId !== playerId) {
          throw new AppError(403, 'userNotAuthorized', 'Toto hraní patří jinému hráči.');
        }
        record.storyId = run.storyId;
        if (run.state !== 'inProgress') {
          throw new AppError(409, 'playthroughNotInProgress', 'V tomto hraní už nelze pokračovat.');
        }

        const query = new URLSearchParams({ storyId: run.storyId, sceneId: run.currentSceneId, decisionId });
        try {
          next = transition.parse(await storyClient.request('/internal/playthrough/resolveDecision?' + query, { requestId }));
        } catch (error) {
          if (error instanceof AppError && rejectedTransitionCodes.has(error.code)) throw error;
          console.error({ requestId, operation: OPERATION, error: error.message });
          throw new AppError(503, 'sceneLoadFailed', 'Následující scénu se nepodařilo načíst.');
        }
        updated = await playthroughs.recordDecision(run.id, {
          sceneId: run.currentSceneId, decisionId, targetSceneId: next.scene.id,
          finished: next.scene.type === 'final', historyLength: run.decisionHistory?.length ?? 0,
        });
        if (!updated) {
          throw new AppError(409, 'playthroughChanged', 'Hraní se mezitím změnilo. Načtěte jeho aktuální stav.');
        }
      } catch (error) {
        let failure = error;
        if (!(error instanceof AppError)) {
          console.error({ requestId, operation: OPERATION, error: error.message });
          failure = new AppError(500, 'decisionSaveFailed', 'Volbu se nepodařilo uložit.');
        }
        await audit.tryCreate({
          ...record, result: failure.status < 500 ? 'denied' : 'error', errorCode: failure.code,
        }, { requestId });
        throw failure;
      }

      const { id, storyId, storyName, state, currentSceneId, startedAt, updatedAt, finishedAt } = updated;
      await audit.tryCreate({ ...record, detail: { decisionId, targetSceneId: currentSceneId }, result: 'success' }, { requestId });
      const uuAppErrorMap = { ...req.uuAppErrorMap };
      let progress = null;
      try {
        const counts = await playthroughs.visitedCounts(playerId, [storyId]);
        const visitedSceneCount = counts.get(storyId) ?? 0;
        progress = {
          visitedSceneCount, totalSceneCount: next.sceneCount,
          percent: Math.min(100, Math.round(100 * visitedSceneCount / next.sceneCount)),
        };
      } catch (error) {
        console.error({ requestId, operation: OPERATION, error: error.message });
        uuAppErrorMap.progressLoadFailed = { playthroughId };
      }
      res.json({
        playthrough: { id, storyId, storyName, state, currentSceneId, startedAt, updatedAt, finishedAt },
        currentScene: currentSceneDto(next.scene), progress, uuAppErrorMap,
      });
    }));
}
