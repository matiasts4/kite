import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import {
  McpAppFrame,
  buildMcpAppCspPolicy,
  clampInlineAppHeight,
  injectCspMetaIntoHtml,
} from './McpAppFrame';
import { ChatItemRow } from '../chat/ChatItemRow';
import type { ChatItem } from '../../../types';
import * as pluginRuntime from '../../../lib/ipc/pluginRuntime';
import * as ipcCore from '../../../lib/ipc/core';

vi.mock('../../../lib/ipc/pluginRuntime', () => ({
  pluginMcpAppReadResource: vi.fn(),
  pluginMcpAppCallTool: vi.fn(),
}));

vi.mock('../../../lib/ipc/core', () => ({
  invokeCommand: vi.fn(),
  isTauriEnvironment: vi.fn(() => false),
}));

function makeResourcePayload(
  overrides: Partial<pluginRuntime.McpAppResourcePayload> = {},
): pluginRuntime.McpAppResourcePayload {
  return {
    uri: 'ui://widgets/chart.html',
    mimeType: 'text/html;profile=mcp-app',
    html: '<!doctype html><html><head><title>Chart</title></head><body><main>Ready</main></body></html>',
    csp: {
      connectDomains: ['https://api.example.com', 'wss://stream.example.com:8443'],
      resourceDomains: ['https://cdn.example.com'],
      frameDomains: ['http://127.0.0.1:4173'],
      baseUriDomains: ['https://base.example.com'],
    },
    prefersBorder: true,
    serverName: 'alpha_widgets',
    ...overrides,
  };
}

function dispatchFromFrame(iframe: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin: 'null',
      source: iframe.contentWindow,
    }),
  );
}

describe('McpAppFrame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.setAttribute('data-theme', 'dark');
    vi.mocked(ipcCore.isTauriEnvironment).mockReturnValue(false);
    vi.mocked(ipcCore.invokeCommand).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds strict CSP directives and strips unsafe origins before injecting srcDoc', () => {
    const policy = buildMcpAppCspPolicy({
      connectDomains: [
        'https://api.example.com',
        'https://*.wildcard.com',
        'https://api.example.com/path',
        'javascript:alert(1)',
      ],
      resourceDomains: ['https://cdn.example.com', 'data:text/javascript,evil'],
      frameDomains: [],
      baseUriDomains: ['*'],
    });

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain('connect-src https://api.example.com');
    expect(policy).toContain("script-src 'unsafe-inline' https://cdn.example.com");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).not.toContain('wildcard');
    expect(policy).not.toContain('javascript:');
    expect(policy).not.toContain('/path');

    const injected = injectCspMetaIntoHtml('<html><head><title>X</title></head><body>Hi</body></html>', {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(injected).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(injected).toContain("connect-src 'none'");

    expect(clampInlineAppHeight(80)).toBe(150);
    expect(clampInlineAppHeight(420)).toBe(420);
    expect(clampInlineAppHeight(1400)).toBe(800);
    expect(clampInlineAppHeight(Number.NaN)).toBeNull();
  });

  it('renders sandboxed iframe without allow-same-origin and injects CSP meta into srcDoc', async () => {
    vi.mocked(pluginRuntime.pluginMcpAppReadResource).mockResolvedValue(
      makeResourcePayload({ prefersBorder: false }),
    );

    render(
      <McpAppFrame
        serverName="alpha_widgets"
        resourceUri="ui://widgets/chart.html"
        toolName="render_chart"
        title="Sales Chart"
        mode="inline"
      />,
    );

    const iframe = (await screen.findByTestId('mcp-app-iframe')) as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');

    const srcDoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcDoc).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(srcDoc).toContain('https://api.example.com');
    expect(srcDoc).toContain('wss://stream.example.com:8443');
    expect(screen.getByTestId('mcp-app-frame')).toHaveClass('mcp-app-frame--borderless');
  });

  it('completes SEP-1865 handshake, flushes tool-input/tool-result, and pushes theme changes', async () => {
    vi.mocked(pluginRuntime.pluginMcpAppReadResource).mockResolvedValue(makeResourcePayload());

    const initialInput = { query: 'latency' };
    const initialResult = { structuredContent: { p95: 42 } };

    const { rerender } = render(
      <McpAppFrame
        serverName="alpha_widgets"
        resourceUri="ui://widgets/chart.html"
        toolName="render_chart"
        title="Metrics"
        mode="inline"
        toolInput={initialInput}
        toolResult={initialResult}
      />,
    );

    const iframe = (await screen.findByTestId('mcp-app-iframe')) as HTMLIFrameElement;
    const postSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    // Spoofed message from non-iframe source must be ignored
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { jsonrpc: '2.0', id: 99, method: 'ui/initialize', params: {} },
          origin: 'https://evil.example.com',
          source: window,
        }),
      );
    });
    expect(postSpy).not.toHaveBeenCalled();

    // Real ui/initialize from iframe
    act(() => {
      dispatchFromFrame(iframe, {
        jsonrpc: '2.0',
        id: 1,
        method: 'ui/initialize',
        params: { appInfo: { name: 'chart-widget', version: '1.0.0' } },
      });
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 1,
        result: expect.objectContaining({
          protocolVersion: '2026-01-26',
          hostContext: expect.objectContaining({
            theme: 'dark',
            displayMode: 'inline',
          }),
        }),
      }),
      '*',
    );

    // ui/notifications/initialized flushes tool-input and tool-result
    act(() => {
      dispatchFromFrame(iframe, {
        jsonrpc: '2.0',
        method: 'ui/notifications/initialized',
      });
    });

    expect(postSpy).toHaveBeenCalledWith(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-input',
        params: { arguments: initialInput },
      },
      '*',
    );
    expect(postSpy).toHaveBeenCalledWith(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: initialResult,
      },
      '*',
    );

    // Host theme change pushes ui/notifications/host-context-changed
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        {
          jsonrpc: '2.0',
          method: 'ui/notifications/host-context-changed',
          params: { theme: 'light' },
        },
        '*',
      );
    });

    // Incremental toolResult update pushes fresh notification
    const nextResult = { structuredContent: { p95: 19 } };
    rerender(
      <McpAppFrame
        serverName="alpha_widgets"
        resourceUri="ui://widgets/chart.html"
        toolName="render_chart"
        title="Metrics"
        mode="inline"
        toolInput={initialInput}
        toolResult={nextResult}
      />,
    );

    expect(postSpy).toHaveBeenCalledWith(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: nextResult,
      },
      '*',
    );
  });

  it('routes tools/call, ui/message, ui/update-model-context, ui/open-link, and clamps inline size', async () => {
    vi.mocked(pluginRuntime.pluginMcpAppReadResource).mockResolvedValue(makeResourcePayload());
    vi.mocked(pluginRuntime.pluginMcpAppCallTool).mockResolvedValue({
      content: [{ type: 'text', text: 'updated' }],
    });

    const onSendMessage = vi.fn();
    const onUpdateModelContext = vi.fn();
    const onOpenLink = vi.fn();

    render(
      <McpAppFrame
        serverName="alpha_widgets"
        resourceUri="ui://widgets/chart.html"
        title="Bridge Test"
        mode="inline"
        instanceId="inst-bridge"
        workspaceId="ws-1"
        onSendMessage={onSendMessage}
        onUpdateModelContext={onUpdateModelContext}
        onOpenLink={onOpenLink}
      />,
    );

    const iframe = (await screen.findByTestId('mcp-app-iframe')) as HTMLIFrameElement;
    const postSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    // tools/call
    act(() => {
      dispatchFromFrame(iframe, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'refresh_data', arguments: { window: '1h' } },
      });
    });

    await waitFor(() => {
      expect(pluginRuntime.pluginMcpAppCallTool).toHaveBeenCalledWith({
        instanceId: 'inst-bridge',
        serverName: 'alpha_widgets',
        toolName: 'refresh_data',
        arguments: { window: '1h' },
        workspaceId: 'ws-1',
      });
      expect(postSpy).toHaveBeenCalledWith(
        {
          jsonrpc: '2.0',
          id: 10,
          result: { content: [{ type: 'text', text: 'updated' }] },
        },
        '*',
      );
    });

    // ui/message & ui/update-model-context
    act(() => {
      dispatchFromFrame(iframe, {
        jsonrpc: '2.0',
        id: 11,
        method: 'ui/message',
        params: { content: [{ type: 'text', text: 'Inspect spike at 14:00' }] },
      });
      dispatchFromFrame(iframe, {
        jsonrpc: '2.0',
        id: 12,
        method: 'ui/update-model-context',
        params: { structuredContent: { selectedRow: 4 } },
      });
    });

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith(
        'Inspect spike at 14:00',
        expect.objectContaining({ content: [{ type: 'text', text: 'Inspect spike at 14:00' }] }),
      );
      expect(onUpdateModelContext).toHaveBeenCalledWith({
        structuredContent: { selectedRow: 4 },
      });
    });

    // ui/open-link accepts https:// and blocks javascript:
    act(() => {
      dispatchFromFrame(iframe, {
        jsonrpc: '2.0',
        id: 13,
        method: 'ui/open-link',
        params: { url: 'https://example.com/docs' },
      });
      dispatchFromFrame(iframe, {
        jsonrpc: '2.0',
        id: 14,
        method: 'ui/open-link',
        params: { url: 'javascript:alert(1)' },
      });
    });

    await waitFor(() => {
      expect(onOpenLink).toHaveBeenCalledTimes(1);
      expect(onOpenLink).toHaveBeenCalledWith('https://example.com/docs');
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          id: 14,
          error: expect.objectContaining({ code: -32602 }),
        }),
        '*',
      );
    });

    // ui/notifications/size-changed clamps 150px..800px
    const viewport = iframe.parentElement as HTMLElement;
    act(() => {
      dispatchFromFrame(iframe, {
        jsonrpc: '2.0',
        method: 'ui/notifications/size-changed',
        params: { height: 50 },
      });
    });
    expect(viewport.style.getPropertyValue('--mcp-app-inline-height')).toBe('150px');

    act(() => {
      dispatchFromFrame(iframe, {
        jsonrpc: '2.0',
        method: 'ui/notifications/size-changed',
        params: { height: 1500 },
      });
    });
    expect(viewport.style.getPropertyValue('--mcp-app-inline-height')).toBe('800px');
  });

  it('displays error banner and supports retrying resource fetch', async () => {
    vi.mocked(pluginRuntime.pluginMcpAppReadResource)
      .mockRejectedValueOnce(new Error('Resource offline'))
      .mockResolvedValueOnce(makeResourcePayload());

    render(
      <McpAppFrame
        serverName="alpha_widgets"
        resourceUri="ui://widgets/chart.html"
        title="Retry App"
      />,
    );

    expect(await screen.findByText('Resource offline')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('mcp-app-iframe')).toBeInTheDocument();
  });

  it('renders inline McpAppFrame inside ChatItemRow for mcpApp and _meta.ui.resourceUri tool rows', async () => {
    vi.mocked(pluginRuntime.pluginMcpAppReadResource).mockResolvedValue(makeResourcePayload());

    const baseTool: ChatItem = {
      id: 'tool-app-1',
      kind: 'tool',
      text: 'Rendered summary',
      title: 'Render chart',
      detail: '{"range":"7d"}',
      status: 'completed',
      streaming: false,
      exitCode: null,
      createdAtUnixMs: Date.now(),
      attachments: [],
      toolName: 'render_chart',
      serverName: 'alpha_widgets',
    };

    const { rerender } = render(
      <ChatItemRow
        item={{
          ...baseTool,
          mcpApp: {
            serverName: 'alpha_widgets',
            resourceUri: 'ui://widgets/chart.html',
            toolName: 'render_chart',
            input: { range: '7d' },
            result: { structuredContent: { total: 10 } },
          },
        }}
      />,
    );

    expect(await screen.findByTestId('mcp-app-iframe')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-mode', 'inline');
    expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-instance-id', 'chat-tool-app-1');

    // Also detects _meta.ui.resourceUri when mcpApp is omitted
    rerender(
      <ChatItemRow
        item={{
          ...baseTool,
          id: 'tool-app-2',
          _meta: {
            ui: {
              resourceUri: 'ui://widgets/meta-chart.html',
              title: 'Meta Chart',
            },
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-instance-id', 'chat-tool-app-2');
      expect(pluginRuntime.pluginMcpAppReadResource).toHaveBeenCalledWith({
        serverName: 'alpha_widgets',
        uri: 'ui://widgets/meta-chart.html',
        workspaceId: null,
      });
    });
  });
});
