// Story Service běží jako jeden proces. Změny stejného příběhu se provedou
// postupně, aby mezi kontrolou grafu a zápisem nemohla proběhnout jiná změna.
export function createStoryWriteQueue() {
  const pending = new Map();
  return async (storyId, write) => {
    const previous = pending.get(storyId);
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    pending.set(storyId, current);
    try {
      await previous;
      return await write();
    } finally {
      release();
      if (pending.get(storyId) === current) pending.delete(storyId);
    }
  };
}
