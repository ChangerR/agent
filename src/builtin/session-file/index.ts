import { definePlugin } from '../../sdk/index.js';
import type { SessionStore } from '../../sdk/runtime-capabilities.js';
import { sessionPath, loadSession, saveSessionVersioned, listSessions, deleteSessionVersioned, latestSessionId } from './implementation.js';
export const fileSessionStore: SessionStore = {
  path: sessionPath,
  load: loadSession,
  save: saveSessionVersioned,
  list: listSessions,
  delete: deleteSessionVersioned,
  latest: latestSessionId,
};
export function createSessionFilePlugin() {
  return definePlugin({
    manifest: { id: 'agentlab.session-file', version: '1.0.0', apiVersion: 1 },
    setup(ctx) { ctx.provide.sessionStore('file', fileSessionStore); },
  });
}
