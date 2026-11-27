import { z } from 'zod';
import { commandInput } from '../../../shared/commandInput.js';
import { AppError, asyncHandler } from '../../../shared/errors.js';
import { gatewayPlayer } from '../../../shared/internalAuth.js';
import { storyLimits } from '../limits.js';

const OPERATION = 'story/create';

// dtoIn podle Application Modelu (Command createStory).
// Název se ořízne, takže řetězec jen z mezer neprojde (min. 1 znak).
// Prázdný žánr se ukládá jako null, stejně jako vynechaný.
export const storyCreateSchema = z.object({
  name: z.string().trim().min(1).max(storyLimits.maxNameLength),
  description: z.string().trim().max(storyLimits.maxDescriptionLength).optional(),
  genre: z.string().trim().max(storyLimits.maxGenreLength).nullable().optional(),
});

// POST /api/stories/story/create (přes gateway), profily Users a Authorities.
// Nový příběh je vždy koncept bez scén a jeho autorem je volající (authorId ze session).
export function mountStoryCreate(router, { stories, audit, token }) {
  router.post('/story/create', gatewayPlayer(token), commandInput(storyCreateSchema, 'body'),
    asyncHandler(async (req, res) => {
      const { name, description = '', genre } = req.dtoIn;
      const record = {
        actorId: req.playerId,
        // Každý přihlášený uživatel má profil Users. Authorities gateway zatím neurčuje.
        actorProfiles: ['Users'],
        operation: OPERATION,
        entityType: 'story',
        detail: { name, genre: genre || null },
      };

      let story;
      try {
        story = await stories.create({ name, description, genre: genre || null, authorId: req.playerId });
      } catch (error) {
        console.error({ requestId: req.requestId, operation: OPERATION, error: error.message });
        await audit.tryCreate({ ...record, result: 'error', errorCode: 'storyCreateFailed' }, { requestId: req.requestId });
        throw new AppError(500, 'storyCreateFailed', 'Příběh se nepodařilo vytvořit.');
      }

      await audit.tryCreate(
        { ...record, entityId: story.id, storyId: story.id, result: 'success' },
        { requestId: req.requestId },
      );
      res.status(201).json({ story, uuAppErrorMap: req.uuAppErrorMap });
    }));
}
