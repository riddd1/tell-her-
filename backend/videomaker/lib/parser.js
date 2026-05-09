/**
 * DM Studio — Script Parser
 *
 * Syntax reference:
 *   1) text                → message, side 1 (left / received)
 *   2) text                → message, side 2 (right / sent)
 *   1) STORY_REPLY:        → story-reply block, side 1
 *   2) STORY_REPLY:        → story-reply block, side 2
 *   1) IMAGE:              → image placeholder, side 1
 *   2) IMAGE:              → image placeholder, side 2
 *   2) VIEWONCE:           → view-once photo bubble (always side 2)
 *   REACT:😤               → adds reaction emoji to the preceding block
 *   SEEN:just now          → seen indicator
 *   MEME: caption 🤡       → meme caption card (from AI output)
 *   🎬 MEME: caption       → same, alternate prefix from Script Maker output
 *
 * Block shapes:
 *   { type: 'message',     side: 1|2, text: '...', reaction: '😤'|null }
 *   { type: 'storyReply',  side: 1|2, reaction: null }
 *   { type: 'image',       side: 1|2, reaction: null }
 *   { type: 'viewOnce',    side: 2,   reaction: null }
 *   { type: 'seen',        text: '...' }
 *   { type: 'memeCaption', text: '...' }
 */

export function parseScript(text) {
  const blocks = [];
  const lines = (text || '').split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // ── REACT: ──────────────────────────────────────────────────────────────
    // Case-insensitive. Applied to the last block that was added.
    // If no prior block exists or emoji is empty, silently skip.
    if (/^REACT:/i.test(line)) {
      const emoji = line.slice(6).trim();
      if (emoji && blocks.length > 0) {
        blocks[blocks.length - 1].reaction = emoji;
      }
      continue;
    }

    // ── SEEN: ───────────────────────────────────────────────────────────────
    if (/^SEEN:/i.test(line)) {
      const seenText = line.slice(5).trim();
      blocks.push({ type: 'seen', text: seenText || 'Seen' });
      continue;
    }

    // ── MEME: (plain or 🎬 prefix) ─────────────────────────────────────────
    // Matches both "MEME: caption" and "🎬 MEME: caption"
    if (/^(?:🎬\s*)?MEME:/i.test(line)) {
      const memeText = line.replace(/^(?:🎬\s*)?MEME:\s*/i, '').trim();
      blocks.push({ type: 'memeCaption', text: memeText });
      continue;
    }

    // ── 1) / 2) ─────────────────────────────────────────────────────────────
    // The `s` flag allows `.` to match newlines but we trim first so it's a
    // safety measure only — real multi-line blocks are not expected.
    const match = line.match(/^([12])\)\s*([\s\S]*)/);
    if (match) {
      const side = parseInt(match[1], 10);
      const content = match[2].trim();
      const upper = content.toUpperCase();

      if (upper === 'STORY_REPLY:') {
        blocks.push({ type: 'storyReply', side, reaction: null });
      } else if (upper === 'IMAGE:') {
        blocks.push({ type: 'image', side, reaction: null });
      } else if (upper === 'VIEWONCE:') {
        // Spec locks this to side 2 regardless of what was written
        blocks.push({ type: 'viewOnce', side: 2, reaction: null });
      } else if (content) {
        // Non-empty text → regular message
        blocks.push({ type: 'message', side, text: content, reaction: null });
      }
      // Empty content after `1) ` → silently skip
      continue;
    }

    // Unrecognised lines (comments, [IMAGE N] headers from AI output, etc.)
    // are ignored — they don't round-trip through serializeBlocks.
  }

  return blocks;
}

export function serializeBlocks(blocks) {
  const lines = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'message':
        lines.push(`${block.side}) ${block.text}`);
        if (block.reaction) lines.push(`REACT:${block.reaction}`);
        break;

      case 'storyReply':
        lines.push(`${block.side}) STORY_REPLY:`);
        if (block.reaction) lines.push(`REACT:${block.reaction}`);
        break;

      case 'image':
        lines.push(`${block.side}) IMAGE:`);
        if (block.reaction) lines.push(`REACT:${block.reaction}`);
        break;

      case 'viewOnce':
        lines.push(`2) VIEWONCE:`);
        if (block.reaction) lines.push(`REACT:${block.reaction}`);
        break;

      case 'seen':
        lines.push(`SEEN:${block.text}`);
        break;

      case 'memeCaption':
        lines.push(`MEME: ${block.text}`);
        break;

      // Unknown block types are dropped — they were unrecognised on parse
    }
  }

  return lines.join('\n');
}
