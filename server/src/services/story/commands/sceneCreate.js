import { z } from 'zod';
import { commandInput, objectIdInput } from '../../../shared/commandInput.js';
import { DuplicateKeyError } from '../../../shared/db.js';
import { AppError, asyncHandler } from '../../../shared/errors.js';
import { gatewayPlayer } from '../../../shared/internalAuth.js';
import { sceneLimits, sceneTypes } from '../limits.js';

const OPERATION = 'scene/create';
const notBlank = (value) => value.trim().length > 0;

// dtoIn podle Application Modelu (Command addScene).
// Název se ořízne. Text scény se ukládá tak, jak ho autor napsal, jen nesmí být prázdný.
export const sceneCreateSchema = z.object({
  storyId: objectIdInput,
  name: z.string().trim().min(1).max(sceneLimits.maxNameLength),
  content: z.string().max(sceneLimits.maxContentLength).refine(notBlank, 'Nesmí obsahovat pouze mezery'),
  type: z.enum(sceneTypes),
});

// POST /api/stories/scene/create (přes gateway), profily Users a Authorities.
// Scénu smí přidat jen autor příběhu (i Authorities cizí obsah neupravují) a jen do konceptu.
export function mountSceneCreate(router, { stories, scenes, audit, token, writeStory }) {
  router.post('/scene/create', gatewayPlayer(token), commandInput(sceneCreateSchema, 'body'),
    asyncHandler((req, res) => writeStory(req.dtoIn.storyId, async () => {
      const { storyId, name, content, type } = req.dtoIn;
      const { requestId } = req;
      const record = {
        actorId: req.playerId,
        actorProfiles: ['Users'],
        operation: OPERATION,
        entityType: 'scene',
        storyId,
        detail: { name, type },
      };
      // Zamítnutý (denied) i neúspěšný (error) pokus se zapíše do audit logu a vrátí chybu.
      const fail = async (result, status, code, message, details) => {
        await audit.tryCreate({ ...record, result, errorCode: code }, { requestId });
        return new AppError(status, code, message, details);
      };
      const logError = (error) => console.error({ requestId, operation: OPERATION, error: error.message });

      let story;
      try {
        story = await stories.get(storyId);
      } catch (error) {
        logError(error);
        throw await fail('error', 500, 'storyLoadFailed', 'Příběh se nepodařilo načíst.', { storyId });
      }
      if (!story) {
        throw await fail('denied', 404, 'storyNotFound', 'Příběh nebyl nalezen.', { storyId });
      }
      if (story.authorId !== req.playerId) {
        throw await fail('denied', 403, 'userNotAuthorized',
          'Uživatel nemá oprávnění přidávat scény k tomuto příběhu.', { storyId });
      }
      if (story.state !== 'draft') {
        throw await fail('denied', 409, 'storyNotEditable',
          'Do publikovaného příběhu nelze přidávat nové scény.', { storyId, state: story.state });
      }

      const initialExists = async (existing) => fail('denied', 409, 'initialSceneAlreadyExists',
        'Příběh již obsahuje úvodní scénu. Vyberte jiný typ scény.', { storyId, existingSceneId: existing?.id ?? null });

      let scene;
      try {
        if (type === 'initial') {
          const existing = await scenes.getInitial(storyId);
          if (existing) throw await initialExists(existing);
        }
        scene = await scenes.create({ storyId, name, content, type });
      } catch (error) {
        if (error instanceof AppError) throw error;
        // Souběžné přidání dvou úvodních scén zastaví unikátní index (DuplicateKeyError).
        if (error instanceof DuplicateKeyError) {
          throw await initialExists(await scenes.getInitial(storyId).catch(() => null));
        }
        logError(error);
        throw await fail('error', 500, 'sceneCreateFailed', 'Scénu se nepodařilo přidat. Zkuste to prosím znovu.', { storyId });
      }

      await audit.tryCreate({ ...record, entityId: scene.id, result: 'success' }, { requestId });
      res.status(201).json({ scene, uuAppErrorMap: req.uuAppErrorMap });
    })));
}
