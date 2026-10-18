import { isTauriEnvironment, randomUuid } from '../../../lib/ipc';
import { browserSurfaceApi } from './browserSurfaceIpc';
import { measureBrowserAnchor } from './browserGeometry';
import { BrowserSurfaceSession } from './browserSurfaceSession';

const NO_WORKSPACE_KEY = '__no-workspace__';
/** Owner placeholder used only without a selected workspace; the native side does not read it. */
const NO_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

/*
 * One session per workspace survives remounts (switching dock tabs), so the
 * page is kept until the browser tab itself is closed.
 */
const sessions = new Map<string, BrowserSurfaceSession>();

export function getBrowserSurfaceSession(workspaceId: string | null): BrowserSurfaceSession {
  const key = workspaceId ?? NO_WORKSPACE_KEY;
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const session = new BrowserSurfaceSession(
    {
      workspaceId: workspaceId ?? NO_WORKSPACE_ID,
      paneId: randomUuid(),
      descriptorId: randomUuid(),
    },
    browserSurfaceApi,
    measureBrowserAnchor,
    isTauriEnvironment
  );
  sessions.set(key, session);
  return session;
}

export async function closeBrowserSurfaceSession(workspaceId: string | null): Promise<void> {
  const key = workspaceId ?? NO_WORKSPACE_KEY;
  const session = sessions.get(key);
  if (session === undefined) return;
  await session.close();
  if (sessions.get(key) === session) sessions.delete(key);
}
