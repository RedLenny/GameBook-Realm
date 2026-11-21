import { AppError, asyncHandler } from './errors.js';

export function readiness(name, dependencies, clients) {
  return asyncHandler(async (req, res) => {
    const checks = await Promise.all(dependencies.map(async (dependency) => {
      try {
        const result = await clients[dependency].request('/internal/health', { requestId: req.requestId });
        if (result?.status !== 'ok' || result.service !== dependency) {
          return [dependency, { status: 'unavailable', code: 'INVALID_SERVICE_RESPONSE' }];
        }
        return [dependency, { status: 'ok' }];
      } catch (error) {
        return [dependency, { status: 'unavailable', code: error.code || 'SERVICE_UNAVAILABLE' }];
      }
    }));
    const services = Object.fromEntries(checks);
    if (checks.some(([, result]) => result.status !== 'ok')) {
      throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', 'Některé služby nejsou dostupné', services);
    }
    res.json({ status: 'ok', service: name, services });
  });
}
