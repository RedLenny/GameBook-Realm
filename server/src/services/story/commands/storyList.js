import { z } from 'zod';
import { commandInput, pagingInput } from '../../../shared/commandInput.js';
import { AppError, asyncHandler } from '../../../shared/errors.js';
import { gatewayPlayer } from '../../../shared/internalAuth.js';
import { storyLimits } from '../limits.js';

const OPERATION = 'story/list';
const paging = pagingInput(storyLimits.defaultPageSize);

export const storyListSchema = paging.extend({
  pageInfo: paging.optional(),
  state: z.enum(['draft', 'published']).optional(),
});

// GET /api/stories/story/list (přes gateway), profily Users a Authorities.
// „Moje příběhy“: příběhy volajícího, nejnověji upravené první.
export function mountStoryList(router, { stories, scenes, token }) {
  router.get('/story/list', gatewayPlayer(token), commandInput(storyListSchema, 'query'),
    asyncHandler(async (req, res) => {
      const { state } = req.dtoIn;
      const { pageIndex, pageSize } = req.dtoIn.pageInfo ?? req.dtoIn;
      try {
        const { items, total } = await stories.listByAuthor(req.playerId, {
          state, limit: pageSize, skip: pageIndex * pageSize,
        });
        const counts = await scenes.countByStories(items.map((story) => story.id));
        res.json({
          itemList: items.map((story) => ({ ...story, sceneCount: counts.get(story.id) })),
          pageInfo: { pageIndex, pageSize, total },
          uuAppErrorMap: req.uuAppErrorMap,
        });
      } catch (error) {
        console.error({ requestId: req.requestId, operation: OPERATION, error: error.message });
        throw new AppError(500, 'storyListFailed', 'Příběhy se nepodařilo načíst.');
      }
    }));
}
