import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../shared/errors.js';
import { validateDtoIn } from '../shared/validation.js';

const MAX_NAME_LENGTH = 200;
const createSchema = z.object({
  body: z.object({ name: z.string().trim().min(1).max(MAX_NAME_LENGTH) }),
});
const deleteSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger),
  }),
});

export default function createItemsRouter(store) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(store.list());
  });

  router.post('/', validateDtoIn(createSchema, {
    message: `Pole "name" musí být text o délce 1 až ${MAX_NAME_LENGTH} znaků`,
  }), (req, res) => {
    res.status(201).json(store.add(req.dtoIn.body.name));
  });

  router.delete('/:id', validateDtoIn(deleteSchema, { message: 'Neplatné id' }), (req, res) => {
    if (!store.remove(req.dtoIn.params.id)) {
      throw new AppError(404, 'ITEM_NOT_FOUND', 'Položka nenalezena');
    }
    res.status(204).end();
  });

  return router;
}
