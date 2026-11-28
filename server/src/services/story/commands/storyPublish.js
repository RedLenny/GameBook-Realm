import { AppError } from '../../../shared/errors.js';

export function validatePublication(storyId, scenes) {
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
