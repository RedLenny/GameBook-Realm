const STORAGE_KEY = 'gamebook-realm:dataSource';

const envDefault = ['true', '1'].includes(String(import.meta.env.VITE_USE_MOCK).toLowerCase());

export const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

export const canSwitchSource = import.meta.env.DEV;

export function initialMock() {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (canSwitchSource && stored === 'mock') return true;
    if (canSwitchSource && stored === 'backend') return false;
  } catch {}
  return envDefault;
}

export function storeMock(value) {
  try {
    sessionStorage.setItem(STORAGE_KEY, value ? 'mock' : 'backend');
  } catch {}
}
