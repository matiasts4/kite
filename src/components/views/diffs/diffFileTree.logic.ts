import type { GitFileChange } from '../files/gitTypes';

export interface DiffTreeFolderNode {
  kind: 'folder';
  id: string;
  name: string;
  path: string;
  children: DiffTreeNode[];
  fileCount: number;
}

export interface DiffTreeFileNode {
  kind: 'file';
  id: string;
  name: string;
  path: string;
  file: GitFileChange;
}

export type DiffTreeNode = DiffTreeFolderNode | DiffTreeFileNode;

interface MutableFolder {
  name: string;
  path: string;
  folders: Map<string, MutableFolder>;
  files: DiffTreeFileNode[];
}

function sortAndCompressNode(folder: MutableFolder): DiffTreeFolderNode {
  const folderChildren: DiffTreeFolderNode[] = [];
  for (const child of folder.folders.values()) {
    folderChildren.push(sortAndCompressNode(child));
  }

  folderChildren.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const sortedFiles = [...folder.files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );

  // Compact linear folder chains (e.g. src/components/views) into one row when no sibling exists.
  if (folder.path && folderChildren.length === 1 && sortedFiles.length === 0) {
    const onlyChild = folderChildren[0];
    return {
      kind: 'folder',
      id: `folder:${onlyChild.path}`,
      name: `${folder.name}/${onlyChild.name}`,
      path: onlyChild.path,
      children: onlyChild.children,
      fileCount: onlyChild.fileCount,
    };
  }

  const children: DiffTreeNode[] = [...folderChildren, ...sortedFiles];
  const fileCount =
    sortedFiles.length + folderChildren.reduce((acc, child) => acc + child.fileCount, 0);

  return {
    kind: 'folder',
    id: `folder:${folder.path}`,
    name: folder.name,
    path: folder.path,
    children,
    fileCount,
  };
}

/**
 * Builds a directory-first, compressed-path hierarchical file tree for changed
 * workspace files, preserving original repository paths for selection callbacks.
 */
export function buildDiffFileTree(files: GitFileChange[], searchQuery = ''): DiffTreeNode[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filtered = normalizedQuery
    ? files.filter((file) => file.path.toLowerCase().includes(normalizedQuery))
    : files;

  const root: MutableFolder = {
    name: '',
    path: '',
    folders: new Map(),
    files: [],
  };

  for (const file of filtered) {
    const normalizedPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = normalizedPath.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const folderPath = current.path ? `${current.path}/${part}` : part;
      let existing = current.folders.get(part);
      if (!existing) {
        existing = {
          name: part,
          path: folderPath,
          folders: new Map(),
          files: [],
        };
        current.folders.set(part, existing);
      }
      current = existing;
    }

    const fileName = parts[parts.length - 1];
    current.files.push({
      kind: 'file',
      id: `file:${file.path}`,
      name: fileName,
      path: file.path,
      file,
    });
  }

  const compressedRoot = sortAndCompressNode(root);
  return compressedRoot.children;
}

export function collectDiffTreeFolderPaths(nodes: DiffTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'folder') {
      paths.push(node.path);
      paths.push(...collectDiffTreeFolderPaths(node.children));
    }
  }
  return paths;
}
