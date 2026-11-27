import { z } from 'zod';
import { commandInput, objectIdInput } from '../../../shared/commandInput.js';
import { AppError, asyncHandler } from '../../../shared/errors.js';
import { gatewayPlayer } from '../../../shared/internalAuth.js';

const OPERATION = 'story/get';

export const storyGetSchema = z.object({ id: objectIdInput });

// GET /api/stories/story/get?id= (přes gateway), profily Users a Authorities.
// Cizí koncept vrací storyNotFound. Scény dostane jen autor, ostatní jen jejich počet.
export function mountStoryGet(router, { stories, scenes, token }) {
  router.get('/story/get', gatewayPlayer(token), commandInput(storyGetSchema, 'query'),
    asyncHandler(async (req, res) => {
      const { id } = req.dtoIn;
      const loadFailed = (error) => {
        console.error({ requestId: req.requestId, operation: OPERATION, error: error.message });
        return new AppError(500, 'storyLoadFailed', 'Příběh se nepodařilo načíst.', { storyId: id });
      };

      let story;
      try {
        story = await stories.get(id);
      } catch (error) {
        throw loadFailed(error);
      }
      const isAuthor = story?.authorId === req.playerId;
      if (!story || (story.state !== 'published' && !isAuthor)) {
        throw new AppError(404, 'storyNotFound', 'Příběh nebyl nalezen.', { storyId: id });
      }

      try {
        if (isAuthor) {
          const sceneList = await scenes.listByStory(id);
          return res.json({ story: { ...story, sceneCount: sceneList.length }, sceneList, uuAppErrorMap: req.uuAppErrorMap });
        }
        const counts = await scenes.countByStories([id]);
        res.json({ story: { ...story, sceneCount: counts.get(id) }, uuAppErrorMap: req.uuAppErrorMap });
      } catch (error) {
        throw loadFailed(error);
      }
    }));
}
