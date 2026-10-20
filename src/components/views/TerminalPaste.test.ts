import { describe, it, expect } from 'vitest';
import { clipboardImageFormat, extractClipboardImage } from './TerminalView';

describe('Terminal Clipboard Image Handling', () => {
  it('correctly detects supported image mime types', () => {
    expect(clipboardImageFormat('image/png')).toBe('png');
    expect(clipboardImageFormat('image/PNG')).toBe('png');
    expect(clipboardImageFormat('image/png; charset=utf-8')).toBe('png');
    expect(clipboardImageFormat('image/jpeg')).toBe('jpeg');
    expect(clipboardImageFormat('image/jpg')).toBe('jpeg');
    expect(clipboardImageFormat('image/gif')).toBe('gif');
    expect(clipboardImageFormat('image/webp')).toBe('webp');
    expect(clipboardImageFormat('image/bmp')).toBe('bmp');
    expect(clipboardImageFormat('text/plain')).toBeNull();
    expect(clipboardImageFormat('application/pdf')).toBeNull();
  });

  it('detects image format from filename extension when mime is empty or generic', () => {
    expect(clipboardImageFormat('application/octet-stream', 'snapshot.png')).toBe('png');
    expect(clipboardImageFormat('', 'camera_photo.JPEG')).toBe('jpeg');
    expect(clipboardImageFormat('', 'anim.GIF')).toBe('gif');
    expect(clipboardImageFormat('', 'render.webp')).toBe('webp');
    expect(clipboardImageFormat('', 'bitmap.bmp')).toBe('bmp');
    expect(clipboardImageFormat('', 'notes.txt')).toBeNull();
  });

  it('extracts image from DataTransfer items', () => {
    const fakeFile = new File(['fake-png'], 'shot.png', { type: 'image/png' });
    const mockDataTransfer = {
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => fakeFile,
        },
      ],
      files: [],
    } as unknown as DataTransfer;

    const extracted = extractClipboardImage(mockDataTransfer);
    expect(extracted).not.toBeNull();
    expect(extracted?.format).toBe('png');
    expect(extracted?.file).toBe(fakeFile);
  });

  it('extracts image from DataTransfer files when items are empty', () => {
    const fakeFile = new File(['fake-jpg'], 'photo.jpg', { type: 'image/jpeg' });
    const mockDataTransfer = {
      items: [],
      files: [fakeFile],
    } as unknown as DataTransfer;

    const extracted = extractClipboardImage(mockDataTransfer);
    expect(extracted).not.toBeNull();
    expect(extracted?.format).toBe('jpeg');
    expect(extracted?.file).toBe(fakeFile);
  });

  it('returns null when DataTransfer contains only text', () => {
    const mockDataTransfer = {
      items: [
        {
          kind: 'string',
          type: 'text/plain',
          getAsFile: () => null,
        },
      ],
      files: [],
    } as unknown as DataTransfer;

    const extracted = extractClipboardImage(mockDataTransfer);
    expect(extracted).toBeNull();
  });
});
