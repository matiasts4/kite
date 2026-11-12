export function clipboardImageFormat(mime: string, fileName?: string): 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | null {
  const cleanMime = (mime || '').toLowerCase().split(';')[0].trim();
  if (cleanMime === 'image/png') return 'png';
  if (cleanMime === 'image/jpeg' || cleanMime === 'image/jpg') return 'jpeg';
  if (cleanMime === 'image/gif') return 'gif';
  if (cleanMime === 'image/webp') return 'webp';
  if (cleanMime === 'image/bmp') return 'bmp';
  if (fileName) {
    const ext = fileName.toLowerCase().split('.').pop();
    if (ext === 'png') return 'png';
    if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
    if (ext === 'gif') return 'gif';
    if (ext === 'webp') return 'webp';
    if (ext === 'bmp') return 'bmp';
  }
  return null;
}

export function extractClipboardImage(clipboardData: DataTransfer | null): { file: File; format: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' } | null {
  if (!clipboardData) return null;
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind === 'file' || item.type.toLowerCase().startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        const format = clipboardImageFormat(file.type || item.type, file.name);
        if (format) return { file, format };
      }
    }
  }
  for (const file of Array.from(clipboardData.files ?? [])) {
    const format = clipboardImageFormat(file.type, file.name);
    if (format) return { file, format };
  }
  return null;
}
