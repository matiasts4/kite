import React, { useMemo } from 'react';
import type { FilesEntry } from '../../../types';
import type { OpenFileTab } from './CodeEditorPane';

export interface BreadcrumbSegment {
  name: string;
  path: string;
  entryId?: string;
  isFolder: boolean;
  isFile: boolean;
}

export interface FilesBreadcrumbsProps {
  workspaceName?: string;
  rootEntry: FilesEntry | null;
  activeTab: OpenFileTab | null;
  activeFolderPath: string;
  pathToEntryId: Map<string, string>;
  expandedFolders: Set<string>;
  onSelectActiveFile: (entryId: string) => void;
  onSetActiveFolderPath: (path: string) => void;
  onToggleFolder: (folderEntryId: string, folderRelativePath: string) => void;
}

export const FilesBreadcrumbs: React.FC<FilesBreadcrumbsProps> = ({
  workspaceName,
  rootEntry,
  activeTab,
  activeFolderPath,
  pathToEntryId,
  expandedFolders,
  onSelectActiveFile,
  onSetActiveFolderPath,
  onToggleFolder,
}) => {
  const breadcrumbSegments: BreadcrumbSegment[] = useMemo(() => {
    const rootName = workspaceName || (rootEntry ? rootEntry.displayName : 'Workspace');
    const rootSeg: BreadcrumbSegment = {
      name: rootName,
      path: '',
      entryId: rootEntry?.entryId,
      isFolder: true,
      isFile: false,
    };

    const targetPath = activeTab ? activeTab.relativePath : activeFolderPath;
    if (!targetPath) return [rootSeg];

    const parts = targetPath.split('/').filter(Boolean);
    const segs: BreadcrumbSegment[] = [rootSeg];

    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const isLast = i === parts.length - 1;
      const isFile = isLast && activeTab !== null && activeTab.relativePath === targetPath;
      const segEntryId = pathToEntryId.get(accumulated);

      segs.push({
        name: part,
        path: accumulated,
        entryId: segEntryId,
        isFolder: !isFile,
        isFile,
      });
    }

    return segs;
  }, [workspaceName, rootEntry, activeTab, activeFolderPath, pathToEntryId]);

  const handleBreadcrumbClick = (seg: BreadcrumbSegment) => {
    if (seg.isFile && activeTab) {
      onSelectActiveFile(activeTab.entryId);
      return;
    }
    if (seg.path === '') {
      onSetActiveFolderPath('');
      if (rootEntry && !expandedFolders.has(rootEntry.entryId)) {
        onToggleFolder(rootEntry.entryId, '');
      }
      return;
    }
    const folderEntryId = seg.entryId || pathToEntryId.get(seg.path);
    if (folderEntryId) {
      onToggleFolder(folderEntryId, seg.path);
    }
  };

  return (
    <nav aria-label="Breadcrumbs" className="files-breadcrumbs">
      {breadcrumbSegments.map((seg, idx) => {
        const isLast = idx === breadcrumbSegments.length - 1;
        return (
          <React.Fragment key={seg.path || 'root'}>
            {idx > 0 && <span className="files-breadcrumb-sep">/</span>}
            <button
              type="button"
              className={`files-breadcrumb-btn${isLast ? ' active' : ''}`}
              onClick={() => handleBreadcrumbClick(seg)}
              title={seg.path || seg.name}
            >
              {seg.name}
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
};
