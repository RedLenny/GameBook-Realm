import { AppError } from './errors.js';

// Schemas describe body, params and query together; handlers consume the parsed dtoIn.
export function validateDtoIn(schema, { message = 'Neplatný vstup' } = {}) {
  return (req, _res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) {
      return next(new AppError(400, 'VALIDATION_ERROR', message,
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }))));
    }
    req.dtoIn = result.data;
    next();
  };
}
