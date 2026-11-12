import React from 'react';

export interface IconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

interface CreateIconOptions {
  size?: number;
  fill?: string;
  fillOpacity?: string;
  strokeWidth?: number;
  viewBox?: string;
}

function createIcon(
  render: React.ReactNode,
  options: CreateIconOptions = {}
): React.FC<IconProps> {
  const {
    size: defaultSize = 13,
    fill = 'none',
    fillOpacity,
    strokeWidth = 2,
    viewBox = '0 0 24 24',
  } = options;

  return ({ size = defaultSize, className = '', style }) => (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox={viewBox}
      fill={fill}
      {...(fillOpacity ? { fillOpacity } : {})}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {render}
    </svg>
  );
}

export const FolderIcon = createIcon(
  <>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </>, { fill: 'currentColor', fillOpacity: '0.25' }
);

export const FolderOpenIcon = createIcon(
  <>
    <path d="M6 14l1.45-6.55A2 2 0 0 1 9.4 6H20a2 2 0 0 1 2 2v2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4" />
    <path d="M2 5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v1" />
  </>, { fill: 'currentColor', fillOpacity: '0.25' }
);

export const ChevronLeftIcon = createIcon(
  <>
    <path d="M15 18l-6-6 6-6" />
  </>, { size: 11, strokeWidth: 2.4 }
);

export const ChevronRightIcon = createIcon(
  <>
    <path d="M9 18l6-6-6-6" />
  </>, { size: 11, strokeWidth: 2.4 }
);

export const ChevronDownIcon = createIcon(
  <>
    <path d="M6 9l6 6 6-6" />
  </>, { size: 11, strokeWidth: 2.4 }
);

export const FileCodeIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <polyline points="10 13 8 15 10 17" />
    <polyline points="14 13 16 15 14 17" />
  </>
);

export const FileJsonIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M9 13.5c-.8 0-1 .4-1 1v.5c0 .6-.4 1-1 1 .6 0 1 .4 1 1v.5c0 .6.2 1 1 1" />
    <path d="M15 13.5c.8 0 1 .4 1 1v.5c0 .6.4 1 1 1-.6 0-1 .4-1 1v.5c0 .6-.2 1-1 1" />
  </>
);

export const FileMarkdownIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M8 17v-4l2 2 2-2v4" />
    <path d="M16 15l-1.5 2h3z" />
  </>
);

export const FileLockIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <rect x="9" y="13" width="6" height="5" rx="1" />
    <path d="M10 13v-1.5a2 2 0 1 1 4 0V13" />
  </>
);

export const FileAssetIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <circle cx="9" cy="13" r="1.5" />
    <path d="M16 17l-3.5-3.5-4.5 4.5" />
  </>
);

export const FileAudioIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <circle cx="8" cy="16" r="1.5" />
    <path d="M9.5 16V11l6-2v4.5" />
    <circle cx="14" cy="15" r="1.5" />
  </>
);

export const FileStyleIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M8.5 15.5h7M8 13h8M10.5 11.5l-1 5M14.5 11.5l-1 5" />
  </>
);

export const FileGitIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <circle cx="10" cy="13" r="1.5" />
    <circle cx="14" cy="16" r="1.5" />
    <path d="M10 14.5v2.5M10 14.5a3 3 0 0 0 4 1.5" />
  </>
);

export const FileArchiveIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M10 12h1M11 14h1M10 16h1M11 18h1" />
  </>
);

export const FileTextIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <line x1="10" y1="9" x2="8" y2="9" />
  </>
);

export const FileIcon = createIcon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </>
);

export const RefreshIcon = createIcon(
  <>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </>
);

export const PanelLeftIcon = createIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <line x1="9" y1="3" x2="9" y2="21" />
  </>
);

export const CheckIcon = createIcon(
  <>
    <polyline points="20 6 9 17 4 12" />
  </>, { size: 11, strokeWidth: 2.5 }
);

export const AlertCircleIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </>
);

export const SaveIcon = createIcon(
  <>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </>, { size: 12 }
);

export const ColumnsIcon = createIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <line x1="12" y1="3" x2="12" y2="21" />
  </>, { size: 12 }
);

export const RotateCcwIcon = createIcon(
  <>
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </>, { size: 12 }
);

export const CloseIcon = createIcon(
  <>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </>, { size: 10, strokeWidth: 2.5 }
);

export const GitBranchIcon = createIcon(
  <>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </>
);

export const CircleArrowDownIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <polyline points="8 12 12 16 16 12" />
    <line x1="12" y1="8" x2="12" y2="16" />
  </>
);

export const CircleArrowUpIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <polyline points="16 12 12 8 8 12" />
    <line x1="12" y1="16" x2="12" y2="8" />
  </>
);

export const PlusIcon = createIcon(
  <>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </>
);

export const MinusIcon = createIcon(
  <>
    <line x1="5" y1="12" x2="19" y2="12" />
  </>
);

export const Undo2Icon = createIcon(
  <>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
  </>
);

export function getFileIcon(name: string, size = 13): React.ReactElement {
  const lower = name.toLowerCase();

  // Lock files
  if (
    lower.endsWith('.lock') ||
    lower === 'package-lock.json' ||
    lower === 'yarn.lock' ||
    lower === 'pnpm-lock.yaml' ||
    lower === 'cargo.lock' ||
    lower === 'composer.lock' ||
    lower === 'gemfile.lock' ||
    lower === 'poetry.lock' ||
    lower === 'bun.lockb' ||
    lower === 'flake.lock'
  ) {
    return <FileLockIcon size={size} />;
  }

  // Git and VCS
  if (
    lower === '.gitignore' ||
    lower === '.gitattributes' ||
    lower === '.gitmodules' ||
    lower === '.gitkeep' ||
    lower.startsWith('.git')
  ) {
    return <FileGitIcon size={size} />;
  }

  const parts = lower.split('.');
  const ext = parts.length > 1 ? parts.pop() : '';

  // Asset / Image formats
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'avif', 'psd', 'ai'].includes(ext || '')) {
    return <FileAssetIcon size={size} />;
  }

  // Audio & Video media
  if (
    ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus', 'mp4', 'webm', 'mkv', 'mov', 'avi', 'flv'].includes(
      ext || ''
    )
  ) {
    return <FileAudioIcon size={size} />;
  }

  // Styles
  if (['css', 'scss', 'sass', 'less'].includes(ext || '')) {
    return <FileStyleIcon size={size} />;
  }

  // JSON, YAML, TOML, and config files
  if (
    ['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'webmanifest'].includes(
      ext || ''
    ) ||
    lower.startsWith('.env')
  ) {
    return <FileJsonIcon size={size} />;
  }

  // Markdown and document files
  if (['md', 'markdown', 'mdx', 'doc', 'docx', 'pdf', 'rtf'].includes(ext || '')) {
    return <FileMarkdownIcon size={size} />;
  }

  // Archives
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz', 'wasm'].includes(ext || '')) {
    return <FileArchiveIcon size={size} />;
  }

  // Code files
  if (
    [
      'ts',
      'tsx',
      'mts',
      'cts',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'rs',
      'py',
      'pyw',
      'pyi',
      'go',
      'c',
      'cpp',
      'cc',
      'cxx',
      'h',
      'hpp',
      'hxx',
      'cs',
      'swift',
      'php',
      'rb',
      'rake',
      'lua',
      'sh',
      'bash',
      'zsh',
      'fish',
      'ps1',
      'bat',
      'cmd',
      'sql',
      'html',
      'htm',
      'xml',
      'xhtml',
      'vue',
      'svelte',
      'java',
      'kt',
      'kts',
      'scala',
      'groovy',
      'dart',
    ].includes(ext || '') ||
    ['dockerfile', 'makefile', 'gemfile', 'rakefile'].includes(lower)
  ) {
    return <FileCodeIcon size={size} />;
  }

  // Plain text & logs
  if (['txt', 'log'].includes(ext || '')) {
    return <FileTextIcon size={size} />;
  }

  return <FileIcon size={size} />;
}

export const EyeIcon = createIcon(
  <>
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </>, { size: 12 }
);

export const PencilIcon = createIcon(
  <>
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </>, { size: 12 }
);

export const CodeIcon = createIcon(
  <>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </>, { size: 12 }
);

export const MoreHorizontalIcon = createIcon(
  <>
    <circle cx="12" cy="12" r="2" />
    <circle cx="19" cy="12" r="2" />
    <circle cx="5" cy="12" r="2" />
  </>, { fill: 'currentColor' }
);

export const ListTreeIcon = createIcon(
  <>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </>, { size: 12 }
);

export const ExternalLinkIcon = createIcon(
  <>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </>, { size: 12 }
);

export const CopyIcon = createIcon(
  <>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>, { size: 12 }
);

export const FolderSearchIcon = createIcon(
  <>
    <path d="M10.5 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v2.5" />
    <circle cx="17" cy="17" r="3" />
    <path d="m21 21-1.9-1.9" />
  </>, { size: 12 }
);


