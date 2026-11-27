import { z } from 'zod';
import { commandInput, objectIdInput } from '../../../shared/commandInput.js';
import { AppError, asyncHandler } from '../../../shared/errors.js';
import { internalAuth } from '../../../shared/internalAuth.js';

const schema = z.object({
  id: objectIdInput,
  playerId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
});

// Interní příkaz playthrough/getFinished (Application Model, návrh): ověří, že hraní
// patří danému hráči a je dokončené. Volá ho Discovery Service před rating/create.
// Kódy chyb jsou stejné jako v rating/create, Discovery je převezme.
export function mountPlaythroughGetFinished(router, { playthroughs, token }) {
  router.get('/playthrough/getFinished', internalAuth(token, { required: true }), commandInput(schema, 'query'),
    asyncHandler(async (req, res) => {
      const { id, playerId } = req.dtoIn;
      const playthrough = await playthroughs.get(id);
      if (!playthrough) {
        throw new AppError(404, 'playthroughNotFound', 'Hraní neexistuje.', { playthroughId: id });
      }
      if (playthrough.playerId !== playerId) {
        throw new AppError(403, 'userNotAuthorized', 'Hraní patří jinému hráči.', { playthroughId: id });
      }
      if (playthrough.state !== 'finished') {
        throw new AppError(409, 'playthroughNotFinished', 'Hraní není dokončené.',
          { playthroughId: id, state: playthrough.state });
      }
      res.json({
        playthrough: {
          id: playthrough.id,
          storyId: playthrough.storyId,
          playerId: playthrough.playerId,
          state: playthrough.state,
          finishedAt: playthrough.finishedAt ?? null,
        },
        uuAppErrorMap: req.uuAppErrorMap,
      });
    }));
}
