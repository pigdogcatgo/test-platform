const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();

// Empty means same-origin. Vite proxies API and upload requests to the local API
// server during development, while production can route them through its proxy.
export const API_URL = configuredApiUrl ? configuredApiUrl.replace(/\/+$/, '') : '';
