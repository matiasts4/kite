import type { ChatItem } from '../../../types';
import type { ApprovalRequest } from '../../../components/views/chat/types';

export interface ChatAttachment {
  id: string;
  name: string;
}

export const ATTACHMENTS: ChatAttachment[] = [
  { id: 'a1', name: 'TitleBar.tsx' },
  { id: 'a2', name: 'RightDock.tsx' },
  { id: 'a3', name: 'chat.css' },
];

export const CHAT_MODELS = [
  { id: 'opus', label: 'Kite 2 · Opus', detail: 'razonamiento largo', quota: 72 },
  { id: 'sonnet', label: 'Kite 2 · Sonnet', detail: 'equilibrado', quota: 45 },
  { id: 'haiku', label: 'Kite 2 · Haiku', detail: 'rápido', quota: 88 },
] as const;

export type ChatModelId = (typeof CHAT_MODELS)[number]['id'];

export const CHAT_REPLY =
  'Listo: leo el archivo, ajusto el borde vivo y te dejo el diff en el dock.';

export const SAMPLE_APPROVAL: ApprovalRequest = {
  id: 'appr-titlebar',
  toolName: 'write',
  title: 'Escribir en src/components/TitleBar.tsx',
  detail: `--- a/src/components/TitleBar.tsx
+++ b/src/components/TitleBar.tsx
@@ -14,6 +14,8 @@
+import { DictationControl } from './DictationControl';
+import { SyncStatusBadge } from './SyncStatusBadge';`,
  risk: 'fileChange',
  impact: 'Modificará 1 archivo en el workspace actual (+18 −4 líneas).',
};

export const SEED_CHAT_ITEMS: ChatItem[] = [
  {
    id: 'm1',
    kind: 'user',
    text: 'Refactoricemos TitleBar.tsx para incorporar el control de dictado y el estado de sincronización.',
    title: null,
    detail: null,
    status: 'completed',
    streaming: false,
    exitCode: null,
    createdAtUnixMs: Date.now() - 45000,
    attachments: [
      { displayName: 'src/components/TitleBar.tsx', byteSize: 14540 },
    ],
  },
  {
    id: 'm2',
    kind: 'reasoning',
    text: '**Analizando dependencias de TitleBar y el hook useDictation**\n\nRevisando TitleBar.tsx para integrar el control de dictado por voz y el badge de estado sin alterar el layout existente en modo ventana y pantalla completa.',
    title: null,
    detail: null,
    status: 'completed',
    streaming: true,
    exitCode: null,
    durationSeconds: 1.8,
    createdAtUnixMs: Date.now() - 40000,
    attachments: [],
  },
  {
    id: 'm3a',
    kind: 'tool',
    title: 'cat src/components/TitleBar.tsx',
    detail: 'src/components/TitleBar.tsx · 412 líneas',
    toolName: 'cat',
    toolKind: 'fileChange',
    status: 'completed',
    streaming: false,
    exitCode: 0,
    durationSeconds: 0.4,
    createdAtUnixMs: Date.now() - 35000,
    attachments: [],
    text: 'export function TitleBar() {\n  return <header className="titlebar">TitleBar</header>;\n}',
  },
  {
    id: 'm3b',
    kind: 'command',
    title: 'npm test -- --filter=TitleBar · Exit 0',
    command: 'npm test -- --filter=TitleBar',
    detail: 'npm test -- --filter=TitleBar · Exit 0',
    toolName: 'npm',
    toolKind: 'commandExecution',
    status: 'completed',
    streaming: false,
    exitCode: 0,
    durationSeconds: 1.2,
    createdAtUnixMs: Date.now() - 30000,
    attachments: [],
    text: 'PASS src/components/TitleBar.test.tsx (4 tests)\n  ✓ TitleBar mounts with window controls\n  ✓ Dictation trigger toggles audio recording\n  ✓ SyncStatus reflects workspace state\nTests: 4 passed, 4 total',
  },
  {
    id: 'm3c',
    kind: 'tool',
    title: 'Edit src/components/TitleBar.tsx',
    detail: 'src/components/TitleBar.tsx · +18 −4',
    toolName: 'edit',
    toolKind: 'fileChange',
    status: 'completed',
    streaming: false,
    exitCode: 0,
    addedLines: 18,
    removedLines: 4,
    durationSeconds: 0.8,
    createdAtUnixMs: Date.now() - 25000,
    attachments: [],
    text: `--- a/src/components/TitleBar.tsx
+++ b/src/components/TitleBar.tsx
@@ -14,6 +14,8 @@
 import { ZedOrb } from './ZedOrb';
+import { DictationControl } from './DictationControl';
+import { SyncStatusBadge } from './SyncStatusBadge';

 export function TitleBar() {
-  return <header className="titlebar" />;
+  return (
+    <header className="titlebar titlebar--synced">
       <DictationControl />
       <SyncStatusBadge />
     </header>
   );
 }`,
  },
  {
    id: 'm4',
    kind: 'assistant',
    text: `He completado el refactor de \`TitleBar.tsx\`. Los cambios aplicados son:

- **DictationControl**: Añadido con soporte para streaming de voz y feedback táctil.
- **SyncStatusBadge**: Indicador de sincronización en tiempo real con animación de pulso.

\`\`\`tsx
export function TitleBar() {
  return (
    <header className="titlebar titlebar--synced">
      <DictationControl />
      <SyncStatusBadge />
    </header>
  );
}
\`\`\`

Todos los tests unitarios pasaron exitosamente (\`4 passed\`). ¿Querés que ejecute el build de producción?`,
    title: null,
    detail: null,
    status: 'completed',
    streaming: false,
    exitCode: null,
    createdAtUnixMs: Date.now() - 5000,
    attachments: [],
  },
];
