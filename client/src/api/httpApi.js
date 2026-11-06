import { API_URL } from '../config.js';

async function request(path, { body, ...options } = {}) {
  let res;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      ...options,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
    });
  } catch {
    throw new Error('Backend není dostupný');
  }

  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    if (data?.error) throw new Error(data.error);
    throw new Error(res.status >= 500 ? 'Backend není dostupný' : `Chyba ${res.status}`);
  }
  if (data === null) throw new Error('Neplatná odpověď serveru');

  return data;
}

export const listItems = () => request('/items');

export const createItem = (name) =>
  request('/items', { method: 'POST', body: JSON.stringify({ name }) });

export const deleteItem = (id) => request(`/items/${id}`, { method: 'DELETE' });
