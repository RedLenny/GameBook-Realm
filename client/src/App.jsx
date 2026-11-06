import { useCallback, useEffect, useRef, useState } from 'react';
import { loadApi } from './api/index.js';
import { canSwitchSource, initialMock, storeMock } from './config.js';

export default function App() {
  const [mockEnabled, setMockEnabled] = useState(initialMock);
  const [items, setItems] = useState([]);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const lastRequest = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++lastRequest.current;
    const isCurrent = () => requestId === lastRequest.current;

    setLoading(true);
    setError(null);
    try {
      const api = await loadApi(mockEnabled);
      const data = await api.listItems();
      if (isCurrent()) setItems(data);
    } catch (err) {
      if (isCurrent()) {
        setItems([]);
        setError(err.message);
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [mockEnabled]);

  useEffect(() => {
    setItems([]);
    load();
  }, [load]);

  function handleToggle(e) {
    storeMock(e.target.checked);
    setMockEnabled(e.target.checked);
  }

  async function run(action) {
    setSaving(true);
    setError(null);
    try {
      const api = await loadApi(mockEnabled);
      await action(api);
      await load();
    } catch (err) {
      await load();
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function handleAdd(e) {
    e.preventDefault();
    if (!name.trim() || saving) return;
    run(async (api) => {
      await api.createItem(name.trim());
      setName('');
    });
  }

  return (
    <main>
      <header>
        <h1>Gamebook Realm</h1>
        {canSwitchSource && (
          <label>
            <input type="checkbox" checked={mockEnabled} disabled={saving} onChange={handleToggle} /> Použít mock data
          </label>
        )}
      </header>

      {canSwitchSource && (
        <p>
          Zdroj dat: <strong>{mockEnabled ? 'mock' : 'backend'}</strong>
        </p>
      )}

      <form onSubmit={handleAdd}>
        <input
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nová položka"
        />
        <button type="submit" disabled={saving}>
          Přidat
        </button>
      </form>

      {error && <p className="error">{error}</p>}
      {loading && <p>Načítám...</p>}

      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.name}{' '}
            <button disabled={saving || loading} onClick={() => run((api) => api.deleteItem(item.id))}>
              Smazat
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
