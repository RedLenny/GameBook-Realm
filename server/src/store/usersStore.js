// Profiles are cached locally. The verified Google subject is stable across
// gateway restarts and is also the player/author ID used in the domain data.
export function createUsersStore() {
  const bySubject = new Map();
  return {
    async findOrCreate({ googleSub, email, name }) {
      const existing = bySubject.get(googleSub);
      const user = {
        id: googleSub, googleSub, email, name,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      bySubject.set(googleSub, user);
      return { user, created: !existing };
    },
  };
}
