import type { BrowserSurfaceView } from '../../types';
import { invokeCommand } from './core';

export interface BrowserOwnerRef {
  workspaceId: string;
  paneId: string;
  descriptorId: string;
}

export interface BrowserTargetRef extends BrowserOwnerRef {
  surfaceId: string;
}

export interface BrowserBoundsInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserControlAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop'
  | 'openExternal'
  | 'startDesignMode'
  | 'stopDesignMode';

export async function createBrowserSurface(
  url: string,
  bounds: { x: number; y: number; width: number; height: number },
  visible = true,
  workspaceId: string | null = null,
  surfaceId = 'b0000000-0000-4000-8000-000000000001',
  descriptorId = 'browser-main'
): Promise<BrowserSurfaceView> {
  return invokeCommand<BrowserSurfaceView>('create_browser_surface', {
    supportedSchemaVersion: 1,
    owner: {
      scope: 'workspace',
      workspaceId,
      windowLabel: 'main',
      descriptorId,
      surfaceId,
    },
    target: {
      surfaceId,
      descriptorId,
    },
    surfaceId,
    descriptorId,
    url,
    bounds,
    visible,
    designMode: false,
    confirmedByBuilder: true,
  });
}

export async function navigateBrowserSurface(
  surfaceId: string,
  descriptorId: string,
  url: string
): Promise<BrowserSurfaceView> {
  return invokeCommand<BrowserSurfaceView>('navigate_browser_surface', {
    supportedSchemaVersion: 1,
    target: { surfaceId, descriptorId },
    url,
  });
}

export async function controlBrowserSurface(
  surfaceId: string,
  descriptorId: string,
  action: string
): Promise<BrowserSurfaceView> {
  return invokeCommand<BrowserSurfaceView>('control_browser_surface', {
    supportedSchemaVersion: 1,
    target: { surfaceId, descriptorId },
    action,
  });
}

export async function closeBrowserSurface(
  surfaceId: string,
  descriptorId = 'browser-main'
): Promise<{ closed: true }> {
  return invokeCommand<{ closed: true }>('close_browser_surface', {
    supportedSchemaVersion: 1,
    target: { surfaceId, descriptorId },
  });
}

export async function readBrowserSurface(
  surfaceId: string,
  descriptorId: string
): Promise<BrowserSurfaceView> {
  return invokeCommand<BrowserSurfaceView>('read_browser_surface', {
    supportedSchemaVersion: 1,
    target: { surfaceId, descriptorId },
  });
}

export async function updateBrowserSurfacePresentation(
  surfaceId: string,
  descriptorId: string,
  bounds: BrowserBoundsInput,
  visible: boolean
): Promise<BrowserSurfaceView> {
  return invokeCommand<BrowserSurfaceView>('update_browser_surface_presentation', {
    supportedSchemaVersion: 1,
    target: { surfaceId, descriptorId },
    bounds,
    visible,
  });
}
