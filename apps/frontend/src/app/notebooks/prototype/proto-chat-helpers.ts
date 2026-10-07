import { Citation } from '../../chat/chat.store';

/**
 * PROTOTYPE — throwaway. The marker-splitting and Citation-link helpers the
 * real chat panel keeps as protected methods, copied here so the variants can
 * render answers without mounting `ChatPanel`. Same behaviour as
 * chat-panel.ts, minus the comments that explain it (read those).
 */
export interface ProtoSegment {
  text: string;
  citation: Citation | null;
}

const MARKER = /\[(\d{1,3})\]/g;

export function protoSegments(content: string, citations: Citation[]): ProtoSegment[] {
  const byMarker = new Map(citations.map((c) => [c.marker, c]));
  const out: ProtoSegment[] = [];
  let from = 0;
  for (const match of content.matchAll(MARKER)) {
    const citation = byMarker.get(Number(match[1]));
    if (!citation) continue;
    const at = match.index!;
    if (at > from) out.push({ text: content.slice(from, at), citation: null });
    out.push({ text: match[0], citation });
    from = at + match[0].length;
  }
  if (from < content.length) out.push({ text: content.slice(from), citation: null });
  return out;
}

export function protoCitationName(c: Citation): string {
  return c.headingPath.length > 0 ? `${c.filename} — ${c.headingPath.join(' > ')}` : c.filename;
}

export function protoCitationLink(notebookId: string, c: Citation): (string | number)[] {
  return ['/notebooks', notebookId, 'documents', c.documentId];
}

export function protoCitationParams(c: Citation): Record<string, string | number> {
  const params: Record<string, string | number> = {
    version: c.documentVersionId,
    chunk: c.chunkId,
  };
  if (c.charStart !== null) params['from'] = c.charStart;
  if (c.charEnd !== null) params['to'] = c.charEnd;
  return params;
}

/** Initials for an avatar, from an e-mail's local part ("jane.doe@x" → "JD"). */
export function protoInitials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return letters.toUpperCase();
}
