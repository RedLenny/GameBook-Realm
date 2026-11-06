import { mockItems } from '../mocks/data.js';

const MAX_NAME_LENGTH = 200;

let items = mockItems.map((i) => ({ ...i }));
let nextId = Math.max(0, ...items.map((i) => i.id)) + 1;

const delay = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

export async function listItems() {
  await delay();
  return items.map((i) => ({ ...i }));
}

export async function createItem(name) {
  await delay();
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`Pole "name" musí být text o délce 1 až ${MAX_NAME_LENGTH} znaků`);
  }
  const item = { id: nextId++, name: trimmed, done: false };
  items.push(item);
  return { ...item };
}

export async function deleteItem(id) {
  await delay();
  if (!/^\d+$/.test(String(id))) {
    throw new Error('Neplatné id');
  }
  const before = items.length;
  items = items.filter((i) => i.id !== id);
  if (items.length === before) {
    throw new Error('Položka nenalezena');
  }
  return null;
}
