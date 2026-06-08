// Single source for the TUI's API base URL.
//
// The TUI historically hardcoded http://localhost:3847 (the Vite dev-proxy port)
// in every view, so it only worked under `npm run dev`. This makes it overridable
// so the TUI can talk to the API server directly (e.g. :3001) or any host:
//   SDLC_API_BASE=http://localhost:3001   (full override)
//   SDLC_API_PORT=3001                     (port only)
// Default stays :3847 for backward compatibility with the dev-stack flow.
export function apiBase(): string {
  if (process.env.SDLC_API_BASE) return process.env.SDLC_API_BASE.replace(/\/$/, '');
  return `http://localhost:${process.env.SDLC_API_PORT || '3847'}`;
}
