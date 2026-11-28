import { z } from 'zod';
import { commandInput, objectIdInput } from '../../../shared/commandInput.js';
import { AppError, asyncHandler } from '../../../shared/errors.js';
import { gatewayPlayer } from '../../../shared/internalAuth.js';
import { sceneLimits } from '../limits.js';

const OPERATION = 'decision/create';

// dtoIn podle Application Modelu (Command addDecision). Text se ořízne, takže text jen z mezer neprojde.
export const decisionCreateSchema = z.object({
  sceneId: objectIdInput,
  text: z.string().trim().min(1).max(sceneLimits.maxDecisionTextLength),
  targetSceneId: objectIdInput,
});

// POST /api/stories/decision/create (přes gateway), profily Users a Authorities.
// Rozhodnutí přidává jen autor do konceptu. Limit rozhodnutí na scénu hlídá DAO atomicky.
export function mountDecisionCreate(router, { stories, scenes, audit, token, writeStory }) {
  router.post('/decision/create', gatewayPlayer(token), commandInput(decisionCreateSchema, 'body'),
    asyncHandler(async (req, res) => {
      const { sceneId, text, targetSceneId } = req.dtoIn;
      const { requestId } = req;
      const record = {
        actorId: req.playerId,
        actorProfiles: ['Users'],
        operation: OPERATION,
        entityType: 'decision',
        storyId: null,
        detail: { sceneId, targetSceneId },
      };
      // Zamítnutý (denied) i neúspěšný (error) pokus se zapíše do audit logu a vrátí chybu.
      const fail = async (result, status, code, message, details) => {
        await audit.tryCreate({ ...record, result, errorCode: code }, { requestId });
        return new AppError(status, code, message, details);
      };
      const createFailed = (error) => {
        console.error({ requestId, operation: OPERATION, error: error.message });
        return fail('error', 500, 'decisionCreateFailed', 'Rozhodnutí se nepodařilo uložit. Zkuste to prosím znovu.', { sceneId });
      };
      const sceneNotFound = () => fail('denied', 404, 'sceneNotFound', 'Výchozí scéna nebyla nalezena.', { sceneId });
      const finalForbidden = () => fail('denied', 409, 'finalSceneDecisionForbidden',
        'Z koncové scény nelze přidat rozhodnutí. Změňte typ scény na běžnou.', { sceneId, type: 'final' });

      // 2. Výchozí scéna a příběh.
      let scene;
      try {
        scene = await scenes.get(sceneId);
      } catch (error) {
        throw await createFailed(error);
      }
      if (!scene) throw await sceneNotFound();
      record.storyId = scene.storyId;
      await writeStory(scene.storyId, async () => {
        let story;
        try {
          scene = await scenes.getInStory(record.storyId, sceneId);
          if (scene) story = await stories.get(scene.storyId);
        } catch (error) {
          throw await createFailed(error);
        }
        if (!scene) throw await sceneNotFound();
        if (!story) throw await fail('denied', 404, 'storyNotFound', 'Příběh nebyl nalezen.', { storyId: scene.storyId });

        // 3. Oprávnění autora a stav příběhu.
        if (story.authorId !== req.playerId) {
          throw await fail('denied', 403, 'userNotAuthorized',
            'Uživatel nemá oprávnění přidávat rozhodnutí k této scéně.', { sceneId });
        }
        if (story.state !== 'draft') {
          throw await fail('denied', 409, 'storyNotEditable',
            'K publikovanému příběhu nelze přidávat nová rozhodnutí.', { storyId: story.id, state: story.state });
        }

        // 4. Výchozí a cílová scéna.
        if (scene.type === 'final') throw await finalForbidden();
        let target;
        try {
          target = await scenes.get(targetSceneId);
        } catch (error) {
          throw await createFailed(error);
        }
        if (!target) throw await fail('denied', 404, 'targetSceneNotFound', 'Cílová scéna nebyla nalezena.', { targetSceneId });
        if (target.storyId !== scene.storyId) {
          throw await fail('denied', 400, 'targetSceneDifferentStory',
            'Cílová scéna musí patřit do stejného příběhu.', { sceneId, targetSceneId });
        }
        if (targetSceneId === sceneId) {
          throw await fail('denied', 400, 'targetSceneSameAsSource',
            'Rozhodnutí musí vést do jiné scény příběhu.', { sceneId, targetSceneId });
        }

        // 5. Uložení. DAO vrátí null, když je scéna smazaná, koncová nebo už má maximum rozhodnutí.
        let result, current;
        try {
          result = await scenes.addDecision(sceneId, { text, targetSceneId });
          if (!result) current = await scenes.get(sceneId);
        } catch (error) {
          throw await createFailed(error);
        }
        if (!result) {
          if (!current) throw await sceneNotFound();
          if (current.type === 'final') throw await finalForbidden();
          throw await fail('denied', 409, 'decisionLimitExceeded', 'Scéna již obsahuje maximální počet rozhodnutí.',
            { sceneId, maxDecisionsPerScene: sceneLimits.maxDecisionsPerScene });
        }

        await audit.tryCreate({ ...record, entityId: result.decision.id, result: 'success' }, { requestId });
        res.status(201).json({ scene: result.scene, uuAppErrorMap: req.uuAppErrorMap });
      });
    }));
}
