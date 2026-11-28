import { z } from 'zod';
import { commandInput, objectIdInput } from '../../../shared/commandInput.js';
import { AppError, asyncHandler } from '../../../shared/errors.js';
import { gatewayPlayer } from '../../../shared/internalAuth.js';

const OPERATION = 'story/publish';
export const storyPublishSchema = z.object({ storyId: objectIdInput });

function validatePublication(storyId, scenes) {
  const initial = scenes.filter((scene) => scene.type === 'initial');
  if (initial.length !== 1) {
    throw new AppError(409, 'invalidInitialSceneCount', 'Příběh musí mít právě jednu úvodní scénu.', { storyId });
  }
  const endings = scenes.filter((scene) => scene.type === 'final');
  if (!endings.length) {
    throw new AppError(409, 'finalSceneNotFound', 'Příběh musí mít alespoň jednu koncovou scénu.', { storyId });
  }

  const predecessors = new Map(scenes.map(({ id }) => [id, []]));
  for (const scene of scenes) {
    for (const decision of scene.decisions) {
      const incoming = predecessors.get(decision.targetSceneId);
      if (!incoming || scene.type === 'final') {
        throw new AppError(409, 'invalidStoryDecision', 'Příběh obsahuje neplatné rozhodnutí.',
          { storyId, sceneId: scene.id, decisionId: decision.id });
      }
      incoming.push(scene.id);
    }
  }

  // Procházíme od konců proti směru rozhodnutí, takže cykly s cestou ke konci zůstávají povolené.
  const queue = endings.map(({ id }) => id);
  const canFinish = new Set(queue);
  for (let index = 0; index < queue.length; index++) {
    for (const source of predecessors.get(queue[index])) {
      if (!canFinish.has(source)) {
        canFinish.add(source);
        queue.push(source);
      }
    }
  }
  const sceneIds = scenes.filter(({ id }) => !canFinish.has(id)).map(({ id }) => id);
  if (sceneIds.length) {
    throw new AppError(409, 'storyHasDeadEnds', 'Z každé scény musí vést cesta k některé koncové scéně.',
      { storyId, sceneIds });
  }
}

export function mountStoryPublish(router, { stories, scenes, audit, indexStory, token, writeStory }) {
  router.post('/story/publish', gatewayPlayer(token), commandInput(storyPublishSchema, 'body'),
    asyncHandler(async (req, res) => {
      const { storyId } = req.dtoIn;
      const { requestId, playerId } = req;
      const record = {
        actorId: playerId, actorProfiles: ['Users'], operation: OPERATION,
        entityType: 'story', entityId: storyId, storyId, detail: {},
      };
      const notEditable = () => new AppError(409, 'storyNotEditable', 'Publikovat lze jen koncept příběhu.', { storyId });
      let published;
      try {
        published = await writeStory(storyId, async () => {
          const story = await stories.get(storyId);
          if (!story) throw new AppError(404, 'storyNotFound', 'Příběh nebyl nalezen.', { storyId });
          if (story.authorId !== playerId) {
            throw new AppError(403, 'userNotAuthorized', 'Uživatel nemá oprávnění publikovat tento příběh.', { storyId });
          }
          if (story.state !== 'draft') throw notEditable();
          const sceneList = await scenes.listByStory(storyId);
          validatePublication(storyId, sceneList);
          const updated = await stories.publish(storyId);
          if (!updated) throw notEditable();
          return { ...updated, sceneCount: sceneList.length };
        });
      } catch (error) {
        let failure = error;
        if (!(error instanceof AppError)) {
          console.error({ requestId, operation: OPERATION, error: error.message });
          failure = new AppError(500, 'storyPublishFailed', 'Příběh se nepodařilo publikovat.', { storyId });
        }
        await audit.tryCreate({
          ...record, result: failure.status < 500 ? 'denied' : 'error', errorCode: failure.code,
        }, { requestId });
        throw failure;
      }

      const uuAppErrorMap = { ...req.uuAppErrorMap };
      await Promise.all([
        audit.tryCreate({ ...record, result: 'success' }, { requestId }),
        (async () => {
          try {
            await indexStory(storyId, requestId);
          } catch (error) {
            console.error({ requestId, operation: OPERATION, error: error.message });
            uuAppErrorMap.storyIndexUpdateFailed = { storyId };
          }
        })(),
      ]);
      res.json({ story: published, uuAppErrorMap });
    }));
}
