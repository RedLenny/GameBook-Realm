// Limity z Application Modelu (storySchema a sceneSchema – Limit List).
export const storyLimits = Object.freeze({
  maxNameLength: 120,
  maxDescriptionLength: 2000,
  maxGenreLength: 50,
  defaultPageSize: 20,
});

export const sceneLimits = Object.freeze({
  maxNameLength: 120,
  maxContentLength: 10000,
  maxDecisionTextLength: 255,
  maxDecisionsPerScene: 20,
});

export const sceneTypes = Object.freeze(['initial', 'regular', 'final']);
