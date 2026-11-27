import { randomUUID } from 'node:crypto';

// In-memory like the other stores. Replace with MongoDB later, the interface stays the same.
export function createUsersStore() {
  const byEmail = new Map();
  return {
    async findOrCreate({ googleSub, email, name }) {
      const key = email.toLowerCase();
      const existing = byEmail.get(key);
      if (existing) return { user: existing, created: false };
      const user = { id: randomUUID(), googleSub, email, name, createdAt: new Date().toISOString() };
      byEmail.set(key, user);
      return { user, created: true };
    },
  };
}
