import { publicationPage, publicationPageSize } from '../../shared/publishedStories.js';

// Reconcile existing data and recover missed notifications. Walk both sorted
// ID sets in bounded pages. A failed or malformed Story response never counts
// as evidence that a published story was deleted.
export async function syncPublishedIndex(index, storyClient) {
  let after = '';
  while (true) {
    const local = await index.activeIdsAfter(after, publicationPageSize);
    const path = '/internal/story/publishedPage' + (after ? '?after=' + after : '');
    const { itemList } = publicationPage.parse(await storyClient.request(path));
    const remote = new Map();
    let previous = after;
    for (const story of itemList) {
      if (story.id <= previous) throw new Error('Unordered Story catalogue page');
      remote.set(story.id, story);
      previous = story.id;
    }
    const ids = [...new Set([...local, ...remote.keys()])].sort().slice(0, publicationPageSize);
    if (!ids.length) return;
    await Promise.all(ids.map((id) => remote.has(id) ? index.put(remote.get(id)) : index.remove(id)));
    after = ids.at(-1);
  }
}

export function startIndexSync(index, storyClient) {
  let stopped = false;
  let timer;
  async function run() {
    let delay = 60000;
    try {
      await syncPublishedIndex(index, storyClient);
    } catch (error) {
      delay = 5000;
      console.warn('[discovery] Catalogue sync will retry:', error.code || error.name);
    } finally {
      if (!stopped) timer = setTimeout(run, delay).unref();
    }
  }
  void run();
  return () => { stopped = true; clearTimeout(timer); };
}
