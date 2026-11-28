import { z } from 'zod';
import { commandInput, objectIdInput } from '../../../shared/commandInput.js';
import { AppError, asyncHandler } from '../../../shared/errors.js';
import { gatewayPlayer } from '../../../shared/internalAuth.js';

const OPERATION = 'scene/delete';
export const sceneDeleteSchema = z.object({ sceneId: objectIdInput });

export function mountSceneDelete(router, { stories, scenes, audit, token, writeStory }) {
  router.post('/scene/delete', gatewayPlayer(token), commandInput(sceneDeleteSchema, 'body'),
    asyncHandler(async (req, res) => {
      const { sceneId } = req.dtoIn;
      const { requestId, playerId } = req;
      const record = {
        actorId: playerId, actorProfiles: ['Users'], operation: OPERATION,
        entityType: 'scene', entityId: sceneId, storyId: null, detail: {},
      };
      const missingScene = () => new AppError(404, 'sceneNotFound', 'Scéna nebyla nalezena.', { sceneId });

      try {
        const scene = await scenes.get(sceneId);
        if (!scene) throw missingScene();
        const { storyId } = scene;
        record.storyId = storyId;
        await writeStory(storyId, async () => {
          const story = await stories.get(storyId);
          if (!story) throw new AppError(404, 'storyNotFound', 'Příběh nebyl nalezen.', { storyId });
          if (story.authorId !== playerId) {
            throw new AppError(403, 'userNotAuthorized', 'Uživatel nemá oprávnění smazat tuto scénu.', { sceneId });
          }
          if (story.state !== 'draft') {
            throw new AppError(409, 'storyNotEditable', 'Scény lze mazat jen v konceptu.', { storyId, state: story.state });
          }
          const current = await scenes.getInStory(storyId, sceneId);
          if (!current) throw missingScene();
          if (current.type === 'initial') {
            throw new AppError(409, 'initialSceneDeleteForbidden', 'Úvodní scénu nelze smazat.', { sceneId });
          }
          const incomingDecisions = await scenes.listIncomingDecisions(storyId, sceneId);
          if (incomingDecisions.length) {
            throw new AppError(409, 'sceneHasIncomingDecisions',
              'Nejdříve odstraňte nebo přesměrujte volby, které vedou do této scény.', { sceneId, incomingDecisions });
          }
          if (!await scenes.delete(sceneId)) throw missingScene();
        });
      } catch (error) {
        let failure = error;
        if (!(error instanceof AppError)) {
          console.error({ requestId, operation: OPERATION, error: error.message });
          failure = new AppError(500, 'sceneDeleteFailed', 'Scénu se nepodařilo smazat.', { sceneId });
        }
        await audit.tryCreate({
          ...record, result: failure.status < 500 ? 'denied' : 'error', errorCode: failure.code,
        }, { requestId });
        throw failure;
      }

      await audit.tryCreate({ ...record, result: 'success' }, { requestId });
      res.json({ sceneId, uuAppErrorMap: req.uuAppErrorMap });
    }));
}
