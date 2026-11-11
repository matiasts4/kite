// Already transcribed speech stays on screen. A new chunk is only the unstable tail.

export function joinSpeechPartial(stable: string, interim: string): string {
  const head = stable.trim();
  const tail = interim.trim();
  if (!head) return tail;
  if (!tail) return head;
  if (tail.startsWith(head)) return tail;
  if (head.endsWith(tail)) return head;

  const max = Math.min(head.length, tail.length);
  for (let size = max; size > 0; size -= 1) {
    if (head.slice(-size) !== tail.slice(0, size)) continue;
    const before = size === head.length ? '' : head[head.length - size - 1];
    const after = size === tail.length ? '' : tail[size];
    const boundary = (ch: string) => ch === '' || /\s/.test(ch);
    if (!boundary(before) || !boundary(after)) continue;
    return `${head}${tail.slice(size)}`.replace(/\s+/g, ' ').trim();
  }
  return `${head} ${tail}`;
}
