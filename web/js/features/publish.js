/**
 * features/publish.js
 * Public note publishing — NIP-23 long-form content (kind 30023).
 *
 * A note becomes a public, indexable Nostr event whose `d` tag is the note id,
 * so re-publishing the same note replaces the previous version in place.
 * The event is signed by the active account (nsec or NIP-07) and written to
 * every write-enabled relay, then shared as a NIP-19 `naddr` link.
 *
 * This is the Nostr-native counterpart to private sync (kind 30078): private
 * notes stay NIP-44 encrypted to yourself, public notes are plaintext and
 * addressable by anyone with the link.
 */

import { account } from './account.js';
import { relays } from './relays.js';
import { npubToPk, toHex, naddrEncode } from '../core/nostr.js';
import { stripHtml, flattenChecklistItems } from './notes.js';

const KIND_LONGFORM = 30023;
const SEND_TIMEOUT_MS = 6000;
export const NJUMP_BASE = 'https://njump.me';

/* ---------- account helpers ---------- */

/** Resolve the active account's hex pubkey, or null. */
export function pubkeyHex() {
  const acc = account.current();
  if (!acc) return null;
  if (acc.rawPubkey) return acc.rawPubkey;
  if (acc.npub) {
    try { return toHex(npubToPk(acc.npub)); } catch { return null; }
  }
  return null;
}

/** True when the active account can sign (nsec or NIP-07). */
export function canPublish() {
  const acc = account.current();
  return !!acc && acc.source !== 'npub';
}

/* ---------- payload ---------- */

/** Build the markdown body for a note (prose + checklist task items). */
export function noteToMarkdown(note) {
  const parts = [];
  const body = htmlToMarkdown(note?.body || '');
  if (body.trim()) parts.push(body.trim());

  const items = flattenChecklistItems(note?.checklist);
  if (items.length) {
    const list = items
      .filter((it) => (it?.t || '').trim())
      .map((it) => `- [${it.d ? 'x' : ' '}] ${it.t.trim()}`)
      .join('\n');
    if (list) parts.push(list);
  }
  return parts.join('\n\n');
}

/** A one-line summary for the `summary` tag (max ~200 chars). */
function summarize(note) {
  const text = [stripHtml(note?.body || ''), noteToMarkdown(note)]
    .find((s) => s && s.trim()) || '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/* ---------- public API ---------- */

export const publish = {
  canPublish,
  noteToMarkdown,

  /**
   * Publish (or update) a note as a public kind-30023 event.
   * Returns { eventId, naddr, url, sent, total } on success.
   * Throws with an i18n error key when publishing is not possible.
   */
  async note(note) {
    if (!note) throw new Error('publish.readOnly');
    if (!canPublish()) throw new Error('publish.readOnly');

    const author = pubkeyHex();
    if (!author) throw new Error('publish.readOnly');

    const title = (note.title || '').trim() || 'Untitled';
    const createdSec = Math.floor((note.createdAt || Date.now()) / 1000);
    const updatedSec = Math.floor(Date.now() / 1000);

    const unsigned = {
      kind: KIND_LONGFORM,
      created_at: updatedSec,
      tags: [
        ['d', note.id],
        ['title', title],
        ['summary', summarize(note)],
        ['published_at', String(createdSec)],
        ['client', 'bitos-notes'],
      ],
      content: noteToMarkdown(note),
    };

    const signed = await account.signEvent(unsigned);

    const writeRelays = relays.all().filter((r) => r.write);
    const msg = JSON.stringify(['EVENT', signed]);
    let sent = 0;
    for (const r of writeRelays) {
      try { if (await sendViaPoolOrSocket(r.url, msg)) sent++; } catch {}
    }
    if (sent === 0) throw new Error('publish.failed');

    const naddr = naddrEncode({
      identifier: note.id,
      pubkey: author,
      kind: KIND_LONGFORM,
      relays: writeRelays.slice(0, 2).map((r) => r.url),
    });

    return {
      eventId: signed.id,
      naddr,
      url: `${NJUMP_BASE}/${naddr}`,
      sent,
      total: writeRelays.length,
    };
  },
};

/* ---------- HTML → Markdown (best-effort, covers the editor's output) ---------- */

const INLINE_WRAP = {
  STRONG: '**', B: '**',
  EM: '*', I: '*',
  S: '~~', DEL: '~~',
  CODE: '`',
};

/** Convert the editor's HTML body into Markdown for NIP-23. */
export function htmlToMarkdown(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  const blocks = [];
  for (const node of root.childNodes) {
    const md = blockToMarkdown(node);
    if (md && md.trim()) blocks.push(md.trim());
  }
  return blocks.join('\n\n');
}

function blockToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName;
  switch (tag) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
      return `${'#'.repeat(Number(tag[1]))} ${inline(node).trim()}`;
    case 'BLOCKQUOTE':
      return inline(node).trim().split('\n').map((l) => `> ${l}`).join('\n');
    case 'PRE':
      return `\`\`\`\n${node.textContent.replace(/\n$/, '')}\n\`\`\``;
    case 'UL':
      return listToMarkdown(node, false);
    case 'OL':
      return listToMarkdown(node, true);
    case 'HR':
      return '---';
    case 'BR':
      return '';
    case 'P': case 'DIV': case 'SECTION': case 'ARTICLE':
      return inline(node).trim();
    default:
      return inline(node).trim();
  }
}

function listToMarkdown(list, ordered) {
  const lines = [];
  let i = 1;
  for (const li of list.children) {
    if (li.tagName !== 'LI') continue;
    const marker = ordered ? `${i++}.` : '-';
    // Inline content only (nested lists are rare in this editor).
    const text = Array.from(li.childNodes)
      .filter((c) => !(c.nodeType === Node.ELEMENT_NODE && /^(UL|OL)$/.test(c.tagName)))
      .map((c) => inline(c))
      .join('')
      .trim();
    lines.push(`${marker} ${text}`.trim());
  }
  return lines.join('\n');
}

function inline(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName;
  const children = Array.from(node.childNodes).map((c) => inline(c)).join('');

  if (INLINE_WRAP[tag]) {
    const wrap = INLINE_WRAP[tag];
    return children.trim() ? `${wrap}${children}${wrap}` : children;
  }
  if (tag === 'BR') return '\n';
  if (tag === 'A') {
    const href = node.getAttribute('href') || '';
    return href ? `[${children}](${href})` : children;
  }
  if (tag === 'IMG') {
    const alt = node.getAttribute('alt') || '';
    const src = node.getAttribute('src') || '';
    return src ? `![${alt}](${src})` : '';
  }
  if (tag === 'INPUT' || tag === 'BUTTON') return '';
  return children;
}

/* ---------- relay transport ---------- */

/** Send a message to a relay, reusing the sync pool's socket when possible. */
async function sendViaPoolOrSocket(url, msg) {
  try {
    const { sync } = await import('../core/sync.js');
    const ws = sync.socket(url);
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(msg); return true; }
  } catch {}
  return new Promise((resolve) => {
    let ws;
    const timer = setTimeout(() => { try { ws?.close(); } catch {} resolve(false); }, SEND_TIMEOUT_MS);
    try { ws = new WebSocket(url); }
    catch { clearTimeout(timer); return resolve(false); }
    ws.onopen = () => { try { ws.send(msg); } catch {} clearTimeout(timer); try { ws.close(); } catch {} resolve(true); };
    ws.onerror = () => { clearTimeout(timer); resolve(false); };
  });
}
