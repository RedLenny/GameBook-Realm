import { Router } from 'express';

const MAX_NAME_LENGTH = 200;

export default function createItemsRouter(store) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(store.list());
  });

  router.post('/', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      return res
        .status(400)
        .json({ error: `Pole "name" musí být text o délce 1 až ${MAX_NAME_LENGTH} znaků` });
    }
    res.status(201).json(store.add(name));
  });

  router.delete('/:id', (req, res) => {
    if (!/^\d+$/.test(req.params.id)) {
      return res.status(400).json({ error: 'Neplatné id' });
    }
    if (!store.remove(Number(req.params.id))) {
      return res.status(404).json({ error: 'Položka nenalezena' });
    }
    res.status(204).end();
  });

  return router;
}
