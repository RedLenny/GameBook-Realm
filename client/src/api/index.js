import * as httpApi from './httpApi.js';

export async function loadApi(mock) {
  return mock ? import('./mockApi.js') : httpApi;
}
