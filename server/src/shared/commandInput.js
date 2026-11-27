import { z } from 'zod';
import { AppError } from './errors.js';

export const objectIdInput = z.string().regex(/^[\da-f]{24}$/i).toLowerCase();

const queryInteger = (min, max) => z.string().regex(/^\d+$/)
  .transform(Number).pipe(z.number().int().min(min).max(max));

export const pageInput = z.object({
  pageIndex: queryInteger(0, Math.floor(Number.MAX_SAFE_INTEGER / 100)).default(0),
  pageSize: queryInteger(1, 100).default(50),
});

// The command contract distinguishes a bad field from an extra field.
// Zod strips the latter; return its path as a warning to the caller.
export function commandInput(schema, source) {
  return (req, _res, next) => {
    const input = req[source] ?? {};
    const result = schema.safeParse(input);
    if (!result.success) {
      const details = { invalidTypeKeyMap: {}, invalidValueKeyMap: {}, missingKeyMap: {} };
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || source;
        const value = issue.path.reduce((obj, key) => obj?.[key], input);
        const map = value === undefined ? details.missingKeyMap
          : issue.code === 'invalid_type' ? details.invalidTypeKeyMap : details.invalidValueKeyMap;
        map[path] = issue.message;
      }
      return next(new AppError(400, 'invalidDtoIn', 'DtoIn není platný.', details));
    }
    const extra = Object.keys(input).filter((key) => !Object.hasOwn(result.data, key));
    if (input.pageInfo && result.data.pageInfo) {
      for (const key of Object.keys(input.pageInfo)) {
        if (!Object.hasOwn(result.data.pageInfo, key)) extra.push('pageInfo.' + key);
      }
    }
    req.dtoIn = result.data;
    req.uuAppErrorMap = extra.length ? { unsupportedKeys: { unsupportedKeyList: extra } } : {};
    next();
  };
}
