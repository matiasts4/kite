export type ReleaseCategory = 'added' | 'changed' | 'fixed' | 'security';

export interface RawReleaseItem {
  kind: ReleaseCategory;
  description: string;
}

export interface ReleaseItem {
  kind: ReleaseCategory;
  category: ReleaseCategory;
  description: string;
  text: string;
}

export interface ReleaseNote {
  version: string;
  tag: string;
  date: string;
  title?: string;
  isCurrent?: boolean;
  isIncoming?: boolean;
  items: ReleaseItem[];
}

export interface RawReleaseNote {
  version: string;
  tag: string;
  date: string;
  title?: string;
  items: RawReleaseItem[];
}
