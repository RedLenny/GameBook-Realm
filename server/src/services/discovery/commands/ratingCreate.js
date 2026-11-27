import { z } from 'zod';
import { commandInput, objectIdInput } from '../../../shared/commandInput.js';
import { DuplicateKeyError } from '../../../shared/db.js';
import { AppError, asyncHandler } from '../../../shared/errors.js';
import { gatewayPlayer } from '../../../shared/internalAuth.js';

const OPERATION = 'rating/create';

// dtoIn podle Application Modelu (Command createRating).
export const ratingCreateSchema = z.object({
  playthroughId: objectIdInput,
  stars: z.number().int().min(1).max(5),
});

const finishedPlaythrough = z.object({
  playthrough: z.object({ id: objectIdInput, storyId: objectIdInput, playerId: z.string(), state: z.literal('finished') }),
});

// Zamítnutí, která vrací Gameplay (playthrough/getFinished), se zprávami z rating/create.
const playthroughErrors = {
  playthroughNotFound: [404, 'Hraní neexistuje.'],
  userNotAuthorized: [403, 'Uživatel nemá oprávnění hodnotit tento příběh.'],
  playthroughNotFinished: [409, 'Příběh lze hodnotit až po jeho dokončení.'],
};

// POST /api/discovery/rating/create (přes gateway), profily Users a Authorities.
// Hodnotit smí hráč s vlastním dokončeným hraním publikovaného cizího příběhu, jednou za příběh.
// Průměr a počet hodnocení Discovery počítá z uložených hodnocení (ratingDao.getStats).
export function mountRatingCreate(router, { ratings, gameplay, findPublishedStory, audit, token }) {
  router.post('/rating/create', gatewayPlayer(token), commandInput(ratingCreateSchema, 'body'),
    asyncHandler(async (req, res) => {
      const { playthroughId, stars } = req.dtoIn;
      const { requestId, playerId } = req;
      const record = {
        actorId: playerId,
        actorProfiles: ['Users'],
        operation: OPERATION,
        entityType: 'rating',
        storyId: null,
        detail: { stars },
      };
      const fail = async (result, status, code, message, details) => {
        await audit.tryCreate({ ...record, result, errorCode: code }, { requestId });
        return new AppError(status, code, message, details);
      };
      const saveFailed = (error, status = 500) => {
        console.error({ requestId, operation: OPERATION, code: error.code, error: error.message });
        return fail('error', status, 'ratingSaveFailed', 'Hodnocení se nepodařilo uložit.', { playthroughId });
      };

      // 1. Hraní patří volajícímu a je dokončené (Gameplay Service).
      let playthrough;
      try {
        const path = `/internal/playthrough/getFinished?id=${playthroughId}&playerId=${encodeURIComponent(playerId)}`;
        ({ playthrough } = finishedPlaythrough.parse(await gameplay.request(path, { requestId })));
      } catch (error) {
        const known = error instanceof AppError && playthroughErrors[error.code];
        if (known) throw await fail('denied', known[0], error.code, known[1], error.details ?? { playthroughId });
        throw await saveFailed(error, 503);
      }
      const { storyId } = playthrough;
      record.storyId = storyId;

      // 2. Příběh je stále publikovaný a volající není jeho autor (Story Service).
      let story;
      try {
        story = await findPublishedStory(storyId, requestId);
      } catch (error) {
        throw await saveFailed(error, 503);
      }
      if (!story) {
        throw await fail('denied', 409, 'storyNotPublished', 'Příběh už není dostupný.', { storyId });
      }
      if (story.authorId === playerId) {
        throw await fail('denied', 403, 'ownStoryRatingForbidden', 'Autor nemůže hodnotit vlastní příběh.', { storyId });
      }

      // 3. Jedno hodnocení na hráče a příběh. Souběžný pokus zastaví unikátní index.
      const alreadyRated = () => fail('denied', 409, 'ratingAlreadyExists', 'Hráč už tento příběh hodnotil.', { storyId });
      let rating;
      try {
        if (await ratings.getByStoryAndPlayer(storyId, playerId)) throw await alreadyRated();
        rating = await ratings.create({ storyId, playerId, playthroughId, value: stars });
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error instanceof DuplicateKeyError) throw await alreadyRated();
        throw await saveFailed(error);
      }

      // 4. Přepočet průměru. Hodnocení už je uložené, takže chyba je jen varování.
      const uuAppErrorMap = { ...req.uuAppErrorMap };
      let stats = { averageRating: null, ratingCount: null };
      try {
        stats = await ratings.getStats(storyId);
      } catch (error) {
        console.error({ requestId, operation: OPERATION, error: error.message });
        // Hodnocení bylo uloženo, ale průměrné hodnocení v katalogu se aktualizuje později.
        uuAppErrorMap.storyIndexUpdateFailed = { storyId };
      }

      await audit.tryCreate({ ...record, entityId: rating.id, result: 'success' }, { requestId });
      res.status(201).json({
        rating: { id: rating.id, storyId: rating.storyId, stars: rating.value, createdAt: rating.createdAt },
        averageRating: stats.averageRating,
        ratingCount: stats.ratingCount,
        uuAppErrorMap,
      });
    }));
}
