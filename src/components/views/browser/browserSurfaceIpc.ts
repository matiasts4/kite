/*
 * Adapter over the positional ipc wrappers. The session state machine speaks in
 * owner/target references and bounds objects for native browser surfaces.
 */
import {
  closeBrowserSurface,
  controlBrowserSurface,
  createBrowserSurface,
  navigateBrowserSurface,
  readBrowserSurface,
  updateBrowserSurfacePresentation,
} from '../../../lib/ipc';
import type { BrowserSurfaceApi } from './browserSurfaceSession';

export const browserSurfaceApi: BrowserSurfaceApi = {
  create: ({ owner, url, bounds, visible }) =>
    createBrowserSurface(url, bounds, visible, owner.workspaceId, owner.paneId, owner.descriptorId),
  navigate: ({ target, url }) => navigateBrowserSurface(target.surfaceId, target.descriptorId, url),
  control: ({ target, action }) => controlBrowserSurface(target.surfaceId, target.descriptorId, action),
  read: ({ target }) => readBrowserSurface(target.surfaceId, target.descriptorId),
  present: ({ target, bounds, visible }) =>
    updateBrowserSurfacePresentation(target.surfaceId, target.descriptorId, bounds, visible),
  close: async ({ target }) => closeBrowserSurface(target.surfaceId, target.descriptorId),
};
