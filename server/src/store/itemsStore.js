export function createItemsStore() {
  let items = [
    { id: 1, name: 'První položka', done: false },
    { id: 2, name: 'Druhá položka', done: true },
  ];
  let nextId = 3;

  return {
    list: () => items,
    add(name) {
      const item = { id: nextId++, name, done: false };
      items.push(item);
      return item;
    },
    remove(id) {
      const before = items.length;
      items = items.filter((i) => i.id !== id);
      return items.length < before;
    },
  };
}
