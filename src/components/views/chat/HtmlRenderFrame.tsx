import { useEffect, useState } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import { HtmlRenderDialog } from './HtmlRenderDialog';

function withExternalLinkBridge(html: string): string {
  const bridge = `<script>document.addEventListener('click',function(event){var node=event.target&&event.target.closest?event.target.closest('a'):null;if(!node||!node.href)return;event.preventDefault();parent.postMessage({type:'kite-open-external',href:node.href},'*');});</script>`;
  if (html.includes('</body>')) return html.replace('</body>', `${bridge}</body>`);
  return `${html}${bridge}`;
}

export function HtmlRenderFrame({ html, title = 'Visual reply' }: { html: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const srcDoc = withExternalLinkBridge(html);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; href?: string } | null;
      if (!data || data.type !== 'kite-open-external' || !data.href) return;
      void invokeCommand('open_external_link', { url: data.href }).catch(() => undefined);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <section className="html-render-frame rounded-card relative overflow-hidden border border-border">
      <button
        type="button"
        className="html-render-frame__expand chrome-button"
        onClick={() => setOpen(true)}
      >
        Expand
      </button>
      <iframe title={title} sandbox="allow-scripts" srcDoc={srcDoc} className="html-render-frame__iframe" />
      {open ? <HtmlRenderDialog html={srcDoc} title={title} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}
