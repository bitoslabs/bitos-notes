/**
 * features/draw.js
 * Drawing engine for notes (SRP: create + edit vector shapes inside the editor).
 *
 * Each drawing is a self-contained `.shape-block` living inside `#editor-body`,
 * parallel to the checklist block:
 *
 *   <div class="shape-block" contenteditable="false"
 *        data-shapes='[{...}, ...]'>
 *     <svg class="shape-svg" viewBox="0 0 W H">…rendered shapes…</svg>
 *   </div>
 *
 * `data-shapes` is the canonical model (source of truth); the inner <svg> is a
 * render derived from it and regenerated on every change. Because the whole
 * block — model + render — is just DOM, it round-trips through the editor's
 * body-HTML save path and the Nostr sync payload with no schema change.
 *
 * Shape model:
 *   { id, type:'rect'|'ellipse'|'line'|'arrow'|'pen',
 *     x, y, w, h, stroke, fill, strokeW, pts:[[x,y],…] }
 */

import { editor } from './editor.js';
import { i18n } from '../core/i18n.js';
import { theme } from '../core/theme.js';
import { bus } from '../core/eventbus.js';
import * as popup from '../ui/popup.js';

const CANVAS_W = 600;
const CANVAS_H = 320;
const ARROW_HEAD = 12;
// Shared font stack so text on the canvas matches the app's prose.
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

// Default drawing colour + fill. Pen/line/arrow are stroke-only.
const DEFAULT_STROKE = '#1d1d1f';
const DEFAULT_STROKE_W = 2;

// Drawing-tool palette: the user's accent presets + neutrals + a fill style.
function palette() {
  const accents = (theme.accents || []).map((a) => a.hex);
  return ['#1d1d1f', ...accents, '#8e8e93'];
}

const TOOLS = [
  { id: 'select',  labelKey: 'draw.select' },
  { id: 'rect',    labelKey: 'draw.rect' },
  { id: 'ellipse', labelKey: 'draw.ellipse' },
  { id: 'line',    labelKey: 'draw.line' },
  { id: 'arrow',   labelKey: 'draw.arrow' },
  { id: 'pen',     labelKey: 'draw.pen' },
  { id: 'text',    labelKey: 'draw.text' },
  { id: 'list',    labelKey: 'draw.list' },
];
const WIDTHS = [1, 2, 4];
// Text-size presets: a relative label (more legible than raw px) + the px value
// used in the SVG viewBox (600 wide). Default is the medium preset.
const FONT_SIZES = [
  { px: 16, label: 'S' },
  { px: 24, label: 'M' },
  { px: 36, label: 'L' },
  { px: 54, label: 'XL' },
];
const DEFAULT_FONT_SIZE = 24;

// Tools that create new shapes when you drag (vs. 'select', which selects).
const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'line', 'arrow', 'pen']);

/* ---- module state ---- */
const state = {
  active: false,          // are we editing a block right now?
  block: null,            // the active .shape-block element
  svg: null,              // its <svg> render element
  tool: 'select',
  stroke: DEFAULT_STROKE,
  strokeW: DEFAULT_STROKE_W,
  fontSize: DEFAULT_FONT_SIZE,
  bold: false,
  italic: false,
  viewMode: 'none',       // canvas background: 'none' | 'grid' | 'lines'
  listStyle: 'bullet',    // new list default: 'bullet' | 'number'
  drawing: false,         // mid-stroke (pointer down, creating a shape)
  marquee: false,         // mid-marquee (pointer down, rubber-band selecting)
  marqueeRect: null,      // {x,y,w,h} of the active marquee box (svg coords)
  draft: null,            // in-progress shape being drawn
  startX: 0, startY: 0,
  selectedIds: new Set(), // ids of selected shapes (multi-select)
  dragMode: null,         // 'move' | 'nw'|'ne'|'sw'|'se' | null
  dragLastX: 0, dragLastY: 0,
  toolsEl: null,          // the floating tool strip
};

/** Read-only view of the current selection as an array. */
function selectedShapes() {
  const shapes = readModel(state.block);
  return shapes.filter((s) => state.selectedIds.has(s.id));
}

/* =====================================================================
 * Public API
 * ===================================================================== */

export const draw = {
  init() {
    // Global click delegation: clicking an existing shape block re-enters its
    // editor. Blocks are contenteditable=false so clicks land on the SVG.
    document.addEventListener('click', (e) => {
      if (state.active) return;                       // already editing
      const body = document.getElementById('editor-body');
      if (!body) return;
      const block = e.target.closest?.('.shape-block');
      if (block && body.contains(block)) {
        e.preventDefault();
        this.editBlock(block);
      }
    });

    // Escape exits draw mode; Delete/Backspace removes the selected shapes.
    document.addEventListener('keydown', (e) => {
      if (!state.active) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIds.size) {
        e.preventDefault();
        for (const id of state.selectedIds) removeShape(id);
        state.selectedIds.clear();
        renderTools(); render();
      }
    });

    // Re-render tool labels on locale change.
    bus.on('locale:changed', () => { if (state.active) renderTools(); });
  },

  isEditing() { return state.active; },

  /**
   * Toggle draw mode on the editor body. First call inserts a fresh shape
   * block at the caret and enters its editor; subsequent calls close it.
   */
  toggle(bodyEl) {
    if (state.active) return this.close();
    if (!bodyEl) bodyEl = document.getElementById('editor-body');
    const block = createShapeBlock();
    insertBlockAtCaret(bodyEl, block);
    this.editBlock(block);
  },

  /** Open the editor overlay for an existing block (re-entry). */
  editBlock(block) {
    if (state.active) this.close();
    if (!block) return;

    state.block = block;
    state.svg = block.querySelector('.shape-svg');
    if (!state.svg) { this.close(); return; }

    // Ensure the SVG has its interaction layer + selection overlay.
    ensureInteractionLayer();

    state.active = true;
    state.selectedIds.clear();
    document.body.classList.add('draw-active');
    block.classList.add('editing');
    restoreViewMode();          // pick up this block's saved background
    applyViewMode();            // ensure the attribute is set on the block

    renderTools();
    bindCanvas();
    bindEditorScroll();
    render();
  },

  /** Exit draw mode (also called by editor.load/clear on note switch). */
  close() {
    if (!state.active && !state.block) return;
    closeTextEditor();
    closeOptionsPopover();
    unbindCanvas();
    unbindEditorScroll();
    if (state.toolsEl) { state.toolsEl.remove(); state.toolsEl = null; }
    state.block?.classList.remove('editing');
    document.body.classList.remove('draw-active');
    state.active = false;
    state.block = null;
    state.svg = null;
    state.drawing = false;
    state.draft = null;
    state.marquee = false;
    state.marqueeRect = null;
    state.selectedIds.clear();
    state.dragMode = null;
    // Remove position listeners so they don't fire for a non-existent tools strip.
    if (state._toolsBound) {
      state._toolsBound = false;
      window.removeEventListener('scroll', positionTools);
      window.removeEventListener('resize', positionTools);
    }
  },
};

/* =====================================================================
 * Shape block creation + insertion
 * ===================================================================== */

/** Build an empty shape-block element (model = [], blank render). */
function createShapeBlock() {
  const block = document.createElement('div');
  block.className = 'shape-block';
  block.contentEditable = 'false';
  block.setAttribute('data-shapes', '[]');
  block.innerHTML = svgWrap('');
  return block;
}

/** Insert a node at the caret, or at the end of the body if none. */
function insertBlockAtCaret(body, node) {
  const sel = window.getSelection();
  if (sel?.rangeCount) {
    const range = sel.getRangeAt(0);
    const anchor = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    if (anchor && body.contains(anchor)) {
      range.collapse(true);
      // Wrap the block in its own line so it sits between paragraphs.
      const before = document.createElement('div'); before.innerHTML = '<br>';
      const after = document.createElement('div'); after.innerHTML = '<br>';
      range.insertNode(after);
      range.insertNode(node);
      range.insertNode(before);
      return;
    }
  }
  body.appendChild(node);
}

/* =====================================================================
 * SVG rendering (pure: model → markup)
 * ===================================================================== */

/** Wrap inner shape markup in the viewBox-sized <svg>. */
function svgWrap(inner) {
  return `<svg class="shape-svg" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

/** Render one shape element to SVG markup. */
function renderShape(s) {
  const common = `stroke="${escAttr(s.stroke)}" stroke-width="${s.strokeW}" fill="${s.fill || 'none'}"`;
  switch (s.type) {
    case 'rect': {
      // Defensive: clamp to a normalised, non-negative box. Geometry may be
      // briefly unnormalised during a drag (draft / live resize) and shapes
      // arriving from Nostr reconcile are untrusted, so never emit negative
      // width/height — the SVG parser rejects them.
      const b = bbox(s);
      return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3" ${common}/>`;
    }
    case 'ellipse': {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const rx = Math.abs(s.w / 2), ry = Math.abs(s.h / 2);
      return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" ${common}/>`;
    }
    case 'line':
      return `<line x1="${s.x}" y1="${s.y}" x2="${s.x + s.w}" y2="${s.y + s.h}" stroke="${escAttr(s.stroke)}" stroke-width="${s.strokeW}" stroke-linecap="round"/>`;
    case 'arrow': {
      const x1 = s.x, y1 = s.y, x2 = s.x + s.w, y2 = s.y + s.h;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const h = ARROW_HEAD;
      const ax = x2 - h * Math.cos(ang - Math.PI / 6);
      const ay = y2 - h * Math.sin(ang - Math.PI / 6);
      const bx = x2 - h * Math.cos(ang + Math.PI / 6);
      const by = y2 - h * Math.sin(ang + Math.PI / 6);
      return `<g stroke="${escAttr(s.stroke)}" stroke-width="${s.strokeW}" stroke-linecap="round" stroke-linejoin="round" fill="none">`
           + `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`
           + `<polygon points="${x2},${y2} ${ax},${ay} ${bx},${by}" fill="${escAttr(s.stroke)}" stroke="none"/></g>`;
    }
    case 'pen': {
      const pts = (s.pts || []).map((p) => p.join(',')).join(' ');
      return `<polyline points="${pts}" stroke="${escAttr(s.stroke)}" stroke-width="${s.strokeW}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    case 'text': {
      // Render text as one <tspan> per line. The <text> y = the FIRST line's
      // baseline (tspan dy=0 on line 0), so the geometry matches bbox() and the
      // selection outline wraps the visible glyphs instead of floating above.
      const fs = s.fontSize || DEFAULT_FONT_SIZE;
      const weight = s.bold ? 'bold' : 'normal';
      const style = s.italic ? 'italic' : 'normal';
      const lines = String(s.text || '').split('\n');
      const tspans = lines.map((ln, i) =>
        `<tspan x="${s.x}" dy="${i === 0 ? 0 : fs * 1.2}">${escXml(ln)}</tspan>`
      ).join('');
      return `<text class="text-shape" x="${s.x}" y="${s.y}" font-size="${fs}" font-weight="${weight}" font-style="${style}" fill="${escAttr(s.stroke)}" font-family="${FONT_FAMILY}">${tspans}</text>`;
    }
    case 'list': {
      // A list = one <text> whose lines each carry a marker (bullet • or a
      // running number). Reuses the text editor (each line = one item).
      const fs = s.fontSize || DEFAULT_FONT_SIZE;
      const weight = s.bold ? 'bold' : 'normal';
      const style = s.italic ? 'italic' : 'normal';
      const ordered = s.listStyle === 'number';
      const lines = String(s.text || '').split('\n');
      const indent = fs * 1.4;                       // x offset for the text body
      const tspans = lines.map((ln, i) => {
        const marker = ordered ? `${i + 1}.` : '•';
        const yOff = i === 0 ? 0 : fs * 1.3;
        return `<tspan x="${s.x}" dy="${yOff}" class="li-marker">${escXml(marker)}</tspan>`
             + `<tspan x="${s.x + indent}" dy="0">${escXml(ln)}</tspan>`;
      }).join('');
      return `<text class="list-shape" x="${s.x}" y="${s.y}" font-size="${fs}" font-weight="${weight}" font-style="${style}" fill="${escAttr(s.stroke)}" font-family="${FONT_FAMILY}">${tspans}</text>`;
    }
    default:
      return '';
  }
}

/** Re-render the active block's <svg> from its model + any draft/selection. */
function render() {
  if (!state.block) return;
  const shapes = readModel(state.block);
  let inner = shapes.map(renderShape).join('');
  if (state.draft) inner += renderShape(state.draft);
  if (state.marquee && state.marqueeRect) inner += renderMarquee(state.marqueeRect);
  if (state.selectedIds.size) inner += renderSelectionGroup(selectedShapes());
  state.svg.innerHTML = inner;
}

/**
 * Apply the canvas background view mode (grid / lines / none). Stored on the
 * block as data-view so it round-trips through save + Nostr sync like shapes,
 * and reflected to a CSS attribute that paints the background pattern.
 */
function applyViewMode() {
  if (!state.block) return;
  state.block.setAttribute('data-view', state.viewMode);
}

/** Restore the saved view mode when (re)entering a block's editor. */
function restoreViewMode() {
  if (!state.block) return;
  const saved = state.block.getAttribute('data-view');
  if (saved) state.viewMode = saved;
}

/** Marquee rubber-band box (Photoshop-style). */
function renderMarquee(r) {
  const x = Math.min(r.x, r.x + r.w), y = Math.min(r.y, r.y + r.h);
  const w = Math.abs(r.w), h = Math.abs(r.h);
  return `<rect class="marquee" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
}

/**
 * Selection overlay for one or more shapes (Photoshop-style):
 *   - a thin outline around each selected shape,
 *   - a single combined bounding box with 8 resize handles (resize is only
 *     active for a single selected box-shape; multi-select shows the group
 *     box for move + visual reference).
 */
function renderSelectionGroup(shapes) {
  if (!shapes.length) return '';
  const accent = escAttr(theme.accentHex);
  let out = '';
  // Per-shape outline so each member of a multi-select is visible.
  for (const s of shapes) {
    const b = bbox(s);
    if (b.w <= 0 && b.h <= 0) continue;
    out += `<rect class="sel-outline" x="${b.x - 2}" y="${b.y - 2}" width="${b.w + 4}" height="${b.h + 4}"/>`;
  }
  // Combined bounding box.
  const g = groupBbox(shapes);
  const pad = 4;
  const x = g.x - pad, y = g.y - pad, w = g.w + pad * 2, h = g.h + pad * 2;
  out += `<rect class="sel-box" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
  // Handles only when exactly one resizable shape is selected (single-shape
  // resize); multi-select handles would resize non-uniformly, so we omit them
  // and rely on move + per-shape delete/recolor instead.
  if (shapes.length === 1 && shapes[0].type !== 'pen') {
    const corners = [['nw', x, y], ['ne', x + w, y], ['sw', x, y + h], ['se', x + w, y + h]];
    for (const [id, hx, hy] of corners) {
      out += `<rect class="handle" data-corner="${id}" x="${hx - 4}" y="${hy - 4}" width="8" height="8" rx="1.5"/>`;
    }
  }
  return out;
}

/** Bounding box of a group of shapes. */
function groupBbox(shapes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    const b = bbox(s);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* =====================================================================
 * Model read/write
 * ===================================================================== */

function readModel(block) {
  try { return JSON.parse(block.getAttribute('data-shapes') || '[]'); }
  catch { return []; }
}

function writeModel(block, shapes) {
  block.setAttribute('data-shapes', JSON.stringify(shapes));
}

/** Persist the current model into the block, re-render, and trigger a note save. */
function commit() {
  if (!state.block) return;
  writeModel(state.block, readModel(state.block));
  render();
  editor.requestSave?.();
}

function newId() { return 's' + Math.random().toString(36).slice(2, 9); }

function removeShape(id) {
  const shapes = readModel(state.block).filter((s) => s.id !== id);
  writeModel(state.block, shapes);
  commit();
}

/* =====================================================================
 * Interaction layer (an invisible rect that captures pointer events)
 * ===================================================================== */

function ensureInteractionLayer() {
  if (!state.svg) return;
  let layer = state.svg.querySelector('.interaction-layer');
  if (!layer) {
    state.svg.insertAdjacentHTML('beforeend',
      `<rect class="interaction-layer" x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" fill="transparent"/>`);
  }
}

/* =====================================================================
 * Pointer handling: draw new shapes + select/move/resize existing ones
 * ===================================================================== */

function bindCanvas() {
  state.svg.addEventListener('pointerdown', onDown);
  state.svg.addEventListener('pointermove', onMove);
  state.svg.addEventListener('dblclick', onDblClick);
  // Persistent (not once) — a single listener lives for the whole edit session;
  // removed in unbindCanvas. The once-variant broke sequential draws because the
  // draw/marquee branches return before re-registering it.
  window.addEventListener('pointerup', onUp);
}

function unbindCanvas() {
  state.svg?.removeEventListener('pointerdown', onDown);
  state.svg?.removeEventListener('pointermove', onMove);
  state.svg?.removeEventListener('dblclick', onDblClick);
  window.removeEventListener('pointerup', onUp);
}

/** Convert a pointer event to SVG viewBox coordinates. */
function toSvg(e) {
  const pt = state.svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const ctm = state.svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function onDown(e) {
  if (!state.active) return;
  e.preventDefault();
  state.svg.setPointerCapture?.(e.pointerId);

  const p = toSvg(e);
  const additive = e.shiftKey;   // shift = add to selection (Photoshop)

  // 1) Resize handle on a single-selected shape?
  const handle = e.target.closest?.('.handle');
  if (handle && state.selectedIds.size === 1) {
    state.dragMode = whichHandle(p);
    state.dragLastX = p.x; state.dragLastY = p.y;
    return;
  }

  // 2) Click on an existing shape → select/move it.
  const hit = hitTest(p);
  if (hit) {
    if (additive) {
      // Toggle membership of the current selection.
      if (state.selectedIds.has(hit.id)) state.selectedIds.delete(hit.id);
      else state.selectedIds.add(hit.id);
    } else if (!state.selectedIds.has(hit.id)) {
      // Clicking a non-selected shape replaces the selection.
      state.selectedIds.clear();
      state.selectedIds.add(hit.id);
    }
    // (If already selected without shift, keep the group so a drag moves all.)
    state.dragMode = 'move';
    state.dragLastX = p.x; state.dragLastY = p.y;
    syncToolsToSelection();
    renderTools();
    render();
    return;
  }

  // 3) Empty space. Behaviour depends on the active tool:
  //    - 'select' tool → marquee (rubber-band) selection
  //    - shape tools    → draw a new shape
  if (!additive) { state.selectedIds.clear(); renderTools(); }

  state.startX = p.x; state.startY = p.y;

  if (state.tool === 'select') {
    state.marquee = true;
    state.marqueeRect = { x: p.x, y: p.y, w: 0, h: 0 };
    if (!additive) state.selectedIds.clear();
    render();
    return;
  }

  // Text tool: a click places a new text shape and opens its inline editor
  // immediately (no drag). Same as double-clicking an existing text shape.
  if (state.tool === 'text') {
    const shape = {
      id: newId(), type: 'text', x: p.x, y: p.y, w: 0, h: 0,
      stroke: state.stroke, fontSize: state.fontSize, bold: state.bold, italic: state.italic,
      text: '',
    };
    const shapes = readModel(state.block);
    shapes.push(shape);
    writeModel(state.block, shapes);
    render();
    openTextEditor(shape.id);
    return;
  }

  // List tool: like text — click to place a list (one item per line) and edit.
  if (state.tool === 'list') {
    const shape = {
      id: newId(), type: 'list', x: p.x, y: p.y, w: 0, h: 0,
      stroke: state.stroke, fontSize: state.fontSize, bold: state.bold, italic: state.italic,
      listStyle: state.listStyle, text: '',
    };
    const shapes = readModel(state.block);
    shapes.push(shape);
    writeModel(state.block, shapes);
    render();
    openTextEditor(shape.id);
    return;
  }

  state.drawing = true;
  if (state.tool === 'pen') {
    state.draft = { id: newId(), type: 'pen', pts: [[p.x, p.y]], stroke: state.stroke, strokeW: state.strokeW, fill: 'none' };
  } else {
    state.draft = { id: newId(), type: state.tool, x: p.x, y: p.y, w: 0, h: 0, stroke: state.stroke, strokeW: state.strokeW, fill: 'none' };
  }
  render();
}

/** Double-click: if a text/list shape is under the cursor, edit it inline. */
function onDblClick(e) {
  if (!state.active) return;
  const p = toSvg(e);
  const hit = hitTest(p);
  if (hit && (hit.type === 'text' || hit.type === 'list')) {
    state.selectedIds.clear();
    state.selectedIds.add(hit.id);
    renderTools();
    render();
    openTextEditor(hit.id);
  }
}

function onMove(e) {
  if (!state.active) return;
  const p = toSvg(e);

  // Drawing a new shape.
  if (state.drawing && state.draft) {
    if (state.draft.type === 'pen') {
      state.draft.pts.push([p.x, p.y]);
    } else {
      state.draft.w = p.x - state.startX;
      state.draft.h = p.y - state.startY;
    }
    render();
    return;
  }

  // Marquee rubber-band selection.
  if (state.marquee) {
    state.marqueeRect = { x: state.startX, y: state.startY, w: p.x - state.startX, h: p.y - state.startY };
    // Live-select shapes intersecting the marquee (replace mode each move;
    // shift-marquee adds to whatever was selected at pointer-down instead).
    const box = normRect(state.marqueeRect);
    const shapes = readModel(state.block);
    const hits = shapes.filter((s) => rectsIntersect(box, bbox(s))).map((s) => s.id);
    if (e.shiftKey) {
      // Additive: union with the base selection captured at down-time.
      hits.forEach((id) => state.selectedIds.add(id));
    } else {
      state.selectedIds = new Set(hits);
    }
    render();
    return;
  }

  // Move / resize the current selection.
  if (state.dragMode && state.selectedIds.size) {
    const dx = p.x - state.dragLastX;
    const dy = p.y - state.dragLastY;
    state.dragLastX = p.x; state.dragLastY = p.y;
    const shapes = readModel(state.block);
    const sel = shapes.filter((s) => state.selectedIds.has(s.id));
    for (const s of sel) {
      if (state.dragMode === 'move') moveShape(s, dx, dy);
      else { resizeShape(s, dx, dy, state.dragMode); normaliseBox(s); }
    }
    writeModel(state.block, shapes);
    render();
  }
}

function onUp(e) {
  // Finish drawing a new shape.
  if (state.drawing && state.draft) {
    const d = state.draft;
    if (d.type !== 'pen') normaliseBox(d);
    const hasSize = d.type === 'pen'
      ? d.pts.length > 1
      : (Math.abs(d.w) > 2 || Math.abs(d.h) > 2);
    if (hasSize) {
      const shapes = readModel(state.block);
      shapes.push(d);
      writeModel(state.block, shapes);
      state.selectedIds.clear();
      state.selectedIds.add(d.id);     // auto-select the freshly drawn shape
    }
    state.drawing = false;
    state.draft = null;
    commit();
    renderTools();
    return;
  }

  // Finish marquee selection.
  if (state.marquee) {
    state.marquee = false;
    state.marqueeRect = null;
    syncToolsToSelection();
    renderTools();
    render();
    return;
  }

  state.dragMode = null;
}

/** Hit-test a point against shapes (topmost first). Returns the shape or null. */
function hitTest(p) {
  const shapes = readModel(state.block);
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === 'pen') {
      if (nearPolyline(p, s.pts)) return s;
    } else {
      const b = bbox(s);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return s;
    }
  }
  return null;
}

function nearPolyline(p, pts, tol = 8) {
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(p, pts[i - 1], pts[i]) <= tol) return true;
  }
  return false;
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * dx, cy = a[1] + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/* ---- shape transforms ---- */

function moveShape(s, dx, dy) {
  if (s.type === 'pen') {
    s.pts = s.pts.map(([x, y]) => [x + dx, y + dy]);
  } else {
    s.x += dx; s.y += dy;
  }
}

function resizeShape(s, dx, dy, corner) {
  // corner: 'nw' | 'ne' | 'sw' | 'se' (relative to current box)
  if (corner === 'se')      { s.w += dx; s.h += dy; }
  else if (corner === 'ne') { s.w += dx; s.y += dy; s.h -= dy; }
  else if (corner === 'sw') { s.x += dx; s.w -= dx; s.h += dy; }
  else if (corner === 'nw') { s.x += dx; s.y += dy; s.w -= dx; s.h -= dy; }
}

/** Determine which corner handle a point is closest to (for resize). */
function whichHandle(p) {
  const s = selectedShapes()[0];
  if (!s) return 'se';
  const b = bbox(s);
  const corners = { nw: [b.x, b.y], ne: [b.x + b.w, b.y], sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h] };
  let best = 'se', bestD = Infinity;
  for (const [k, [cx, cy]] of Object.entries(corners)) {
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/** Normalise a {x,y,w,h} rectangle (positive w/h). */
function normRect(r) {
  return {
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

/** Do two {x,y,w,h} rectangles (positive w/h) overlap? */
function rectsIntersect(a, b) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

function bbox(s) {
  if (s.type === 'pen') {
    const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (s.type === 'text') {
    // Estimate the box from text metrics (no DOM measurement in this pure fn).
    // Geometry must match renderShape: the <text> y is the FIRST line's
    // baseline, so the visible glyphs span from ~0.8*fs above that baseline.
    const fs = s.fontSize || DEFAULT_FONT_SIZE;
    const lines = String(s.text || '').split('\n');
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const w = Math.max(longest * fs * 0.55, fs * 0.6);     // ~0.55em per char
    const top = s.y - fs * 0.8;                             // ascent above baseline
    const h = (lines.length - 1) * fs * 1.2 + fs;          // all lines + descent
    return { x: s.x, y: top, w, h };
  }
  if (s.type === 'list') {
    // Like text, but each line is indented past a bullet/number marker.
    const fs = s.fontSize || DEFAULT_FONT_SIZE;
    const lines = String(s.text || '').split('\n');
    const indent = fs * 1.4;
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const w = indent + Math.max(longest * fs * 0.55, fs * 0.6);
    const top = s.y - fs * 0.8;
    const h = (lines.length - 1) * fs * 1.3 + fs;
    return { x: s.x, y: top, w, h };
  }
  return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
}

function normaliseBox(s) {
  if (s.w < 0) { s.x += s.w; s.w = -s.w; }
  if (s.h < 0) { s.y += s.h; s.h = -s.h; }
}

/* =====================================================================
 * Inline text editor — an absolutely-positioned <textarea> layered over the
 * SVG, aligned to the text shape's anchor. Edits write back into the model on
 * commit (blur / Esc / Ctrl+Enter). While open it owns pointer input so the
 * canvas handlers don't interfere.
 * ===================================================================== */

let textEditorEl = null;       // the active <textarea>, or null

/** Open the inline editor for a text shape (newly created or existing). */
function openTextEditor(id) {
  closeTextEditor();   // only one at a time
  const shape = readModel(state.block).find((s) => s.id === id);
  if (!shape) return;

  const block = state.block;
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.rows = 1;
  ta.value = shape.text || '';
  ta.placeholder = i18n.t('draw.textPlaceholder');
  ta.style.color = shape.stroke;
  ta.style.fontSize = `${svgToScreenPx(shape.fontSize || DEFAULT_FONT_SIZE)}px`;
  ta.style.fontWeight = shape.bold ? '700' : '400';
  ta.style.fontStyle = shape.italic ? 'italic' : 'normal';

  // Position the textarea at the text anchor (SVG coords → block-relative px).
  const anchor = svgPointToBlock(shape.x, shape.y);
  ta.style.left = `${anchor.x}px`;
  ta.style.top = `${anchor.y - (shape.fontSize || DEFAULT_FONT_SIZE) * svgScale()}px`;

  block.appendChild(ta);
  textEditorEl = ta;
  ta.focus();

  // One-shot guard: blur can fire more than once (the browser re-blurs when we
  // remove the focused element), so the commit must run exactly once.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const txt = ta.value;
    const shapes = readModel(state.block);
    const s = shapes.find((x) => x.id === id);
    if (!s) { closeTextEditor(); return; }
    // Empty text → remove the shape (a click with no typing is a no-op/cancel).
    if (!txt.trim()) {
      removeShape(id);
      state.selectedIds.delete(id);
    } else {
      s.text = txt;                       // mutate the model array we'll write back
      writeModel(state.block, shapes);
      state.selectedIds.clear();
      state.selectedIds.add(id);
      commit();   // module-level commit: re-render + persist note (debounced save)
    }
    closeTextEditor();
    renderTools();
    render();
  };

  ta.addEventListener('blur', finish);
  ta.addEventListener('keydown', (e) => {
    // Enter (without shift) ends editing; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); ta.blur(); }
    // Stop the document-level draw keydown (Delete/Backspace) from firing
    // while typing — it must edit text, not delete the shape.
    e.stopPropagation();
  });
  ta.addEventListener('input', () => autoSize(ta));
  autoSize(ta);
}

/** Close + discard the inline text editor (if open). Idempotent: safe to call
 *  repeatedly or from a blur handler triggered by the removal itself. */
function closeTextEditor() {
  if (!textEditorEl) return;
  const el = textEditorEl;
  textEditorEl = null;          // clear the reference BEFORE removing so a
  // re-entrant blur (fired by the removal) finds nothing to do.
  if (el.parentNode) el.parentNode.removeChild(el);
}

/** Grow the textarea to fit its content (1 row minimum). */
function autoSize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

/** SVG-viewbox → CSS pixels scale factor (how 1 viewBox unit maps on screen). */
function svgScale() {
  if (!state.svg) return 1;
  const r = state.svg.getBoundingClientRect();
  return r.width / CANVAS_W;
}

/** Convert a viewBox font-size (units) to on-screen CSS pixels. */
function svgToScreenPx(sizeUnits) {
  return sizeUnits * svgScale();
}

/** Convert a viewBox {x,y} point to block-relative CSS pixels (for overlay pos). */
function svgPointToBlock(vx, vy) {
  const r = state.svg.getBoundingClientRect();
  const br = state.block.getBoundingClientRect();
  const sx = vx / CANVAS_W * r.width;
  const sy = vy / CANVAS_H * r.height;
  return { x: r.left - br.left + sx, y: r.top - br.top + sy };
}

/* =====================================================================
 * Floating tool strip
 * ===================================================================== */

function renderTools() {
  if (!state.block) return;
  if (state.toolsEl) state.toolsEl.remove();

  const el = document.createElement('div');
  el.className = 'draw-tools';

  const selCount = state.selectedIds.size;
  // Font options are only relevant to text-like shapes: show them when a text
  // or list tool is active OR such a shape is in the current selection.
  const selShapes = selectedShapes();
  const isFontShape = (s) => s && (s.type === 'text' || s.type === 'list');
  const showFont = state.tool === 'text' || state.tool === 'list' || selShapes.some(isFontShape);

  el.innerHTML = `
    <div class="dt-tools">
      ${TOOLS.map((t) => `<button class="dt-btn ${state.tool === t.id ? 'active' : ''}" data-tool="${t.id}" title="${i18n.t(t.labelKey)}">${toolGlyph(t.id)}</button>`).join('')}
    </div>
    <span class="dt-sep"></span>
    <div class="dt-swatches">
      ${palette().map((hex) => `<button class="dt-sw ${state.stroke === hex ? 'active' : ''}" data-color="${hex}" style="--sw:${hex}" title="${i18n.t('draw.color')}"></button>`).join('')}
    </div>
    ${state.tool !== 'text' && state.tool !== 'list' ? `<span class="dt-sep"></span>
    <div class="dt-widths">
      ${WIDTHS.map((w) => `<button class="dt-w ${state.strokeW === w ? 'active' : ''}" data-w="${w}" title="${i18n.t('draw.strokeWidth')}"><span style="height:${w + 1}px"></span></button>`).join('')}
    </div>` : ''}
    ${showFont ? `<span class="dt-sep"></span>
    <div class="dt-fontsizes">
      ${FONT_SIZES.map((fs) => `<button class="dt-fs ${state.fontSize === fs.px ? 'active' : ''}" data-fs="${fs.px}" title="${i18n.t('draw.fontSize')}">${fs.label}</button>`).join('')}
    </div>
    <button class="dt-toggle ${state.bold ? 'active' : ''}" data-toggle="bold" title="${i18n.t('draw.bold')}"><b>B</b></button>
    <button class="dt-toggle ${state.italic ? 'active' : ''}" data-toggle="italic" title="${i18n.t('draw.italic')}"><i>I</i></button>` : ''}
    <span class="dt-sep"></span>
    <button class="dt-opt-btn" data-options title="${i18n.t('draw.options')}">
      <svg viewBox="0 0 24 24" class="dt-ico"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
    ${selCount ? `<button class="dt-del" data-del title="${i18n.t('draw.deleteShape')}">✕</button>` : ''}
    <button class="dt-done" data-done>${i18n.t('draw.done')}</button>
  `;

  // Place the strip just above the shape block.
  document.body.appendChild(el);
  positionTools();

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tool]');
    const c = e.target.closest('[data-color]');
    const w = e.target.closest('[data-w]');
    const fs = e.target.closest('[data-fs]');
    const tg = e.target.closest('[data-toggle]');
    const opts = e.target.closest('[data-options]');
    const del = e.target.closest('[data-del]');
    const done = e.target.closest('[data-done]');
    if (t) {
      state.tool = t.dataset.tool;
      // Switching to a shape tool keeps the selection (handy); switching to
      // 'select' is the explicit move/select mode.
      renderTools(); render();
    }
    else if (c) {
      state.stroke = c.dataset.color;
      applyStyleToSelection({ stroke: state.stroke });   // recolor all selected
      renderTools(); render();
    }
    else if (w) {
      state.strokeW = Number(w.dataset.w);
      applyStyleToSelection({ strokeW: state.strokeW });  // re-stroke all selected
      renderTools(); render();
    }
    else if (fs) {
      state.fontSize = Number(fs.dataset.fs);
      applyStyleToSelection({ fontSize: state.fontSize }); // re-size text in selection
      renderTools(); render();
    }
    else if (tg) {
      const key = tg.dataset.toggle;            // 'bold' | 'italic'
      state[key] = !state[key];
      applyStyleToSelection({ [key]: state[key] });
      renderTools(); render();
    }
    else if (opts) {
      // Open the options dropdown (same shared popup chrome as "Sort By").
      openOptionsMenu(opts);
    }
    else if (del) {
      for (const id of state.selectedIds) removeShape(id);
      state.selectedIds.clear();
      renderTools(); render();
    }
    else if (done) { draw.close(); }
  });

  state.toolsEl = el;
  if (!state._toolsBound) {
    state._toolsBound = true;
    window.addEventListener('scroll', positionTools, { passive: true });
    window.addEventListener('resize', positionTools);
  }
  // Position now (after assignment so positionTools can read offsetWidth),
  // then again next frame once fonts/flex layout settle.
  positionTools();
  requestAnimationFrame(positionTools);
}

/**
 * Open the ⚙ Options as a dropdown menu — the same shared popup chrome the
 * "Sort By" menu uses (positioned, checkmarked items, outside-click + Escape
 * to close). Contains the canvas view-mode (grid / lines / none) and, when a
 * list is in play, the list style (bullets / numbered).
 */
function openOptionsMenu(anchor) {
  // Toggle: if the popup is already open, close it.
  if (popup.isOpen()) { popup.close(); return; }

  const showingListOpts = state.tool === 'list' ||
    selectedShapes().some((s) => s.type === 'list');

  const body = [
    popup.header(i18n.t('draw.viewMode')),
    popup.item({ id: 'view:grid',  label: i18n.t('draw.viewGrid'),  checked: state.viewMode === 'grid' }),
    popup.item({ id: 'view:lines', label: i18n.t('draw.viewLines'), checked: state.viewMode === 'lines' }),
    popup.item({ id: 'view:none',  label: i18n.t('draw.viewNone'),  checked: state.viewMode === 'none' }),
  ];
  if (showingListOpts) {
    body.push(popup.separator());
    body.push(popup.header(i18n.t('draw.listStyle')));
    body.push(popup.item({ id: 'liststyle:bullet', label: i18n.t('draw.listBullet'), checked: state.listStyle === 'bullet' }));
    body.push(popup.item({ id: 'liststyle:number', label: i18n.t('draw.listNumber'), checked: state.listStyle === 'number' }));
  }

  popup.open(anchor, body, (id) => {
    if (id.startsWith('view:')) {
      state.viewMode = id.slice('view:'.length);
      applyViewMode();
      editor.requestSave?.();                 // persist data-view on the block
    } else if (id.startsWith('liststyle:')) {
      state.listStyle = id.slice('liststyle:'.length);
      applyStyleToSelection({ listStyle: state.listStyle });
    }
    render();
  });
}

function closeOptionsPopover() {
  popup.close();
}

function positionTools() {
  if (!state.toolsEl || !state.block) return;
  // The strip is position:fixed, so getBoundingClientRect() (viewport-relative)
  // maps directly to top/left — no window-scroll math needed. This also keeps
  // it glued to the block as the editor pane scrolls internally.
  const r = state.block.getBoundingClientRect();
  const stripW = state.toolsEl.offsetWidth;
  let top = r.top - 48;                       // sit just above the block
  let left = r.left + r.width / 2 - stripW / 2; // center on the block
  // Clamp into the viewport so it never escapes on small screens.
  const margin = 8;
  top = Math.max(margin, Math.min(top, window.innerHeight - state.toolsEl.offsetHeight - margin));
  left = Math.max(margin, Math.min(left, window.innerWidth - stripW - margin));
  state.toolsEl.style.top = `${top}px`;
  state.toolsEl.style.left = `${left}px`;
}

/**
 * The strip is position:fixed, so it must reposition when the editor's own
 * scroll container (`.editor-wrap`) moves the block, in addition to window
 * scroll/resize. These bind/unbind that container listener for the active session.
 */
function editorScrollEl() {
  return document.querySelector('.editor-wrap') || null;
}
function bindEditorScroll() {
  const el = editorScrollEl();
  if (el && !state._editorScrollBound) {
    state._editorScrollBound = true;
    el.addEventListener('scroll', positionTools, { passive: true });
  }
}
function unbindEditorScroll() {
  if (state._editorScrollBound) {
    state._editorScrollBound = false;
    editorScrollEl()?.removeEventListener('scroll', positionTools);
  }
}

/** Sync the tool strip's color/width/font to the current selection (single
 *  source of truth: if all selected shapes share a value, reflect it active). */
function syncToolsToSelection() {
  const sel = selectedShapes();
  if (!sel.length) return;
  const strokes = new Set(sel.map((s) => s.stroke));
  const widths = new Set(sel.map((s) => s.strokeW));
  if (strokes.size === 1) state.stroke = [...strokes][0];
  if (widths.size === 1) state.strokeW = [...widths][0];
  // Font options only meaningfully apply to text shapes.
  const texts = sel.filter((s) => s.type === 'text');
  if (texts.length) {
    const sizes = new Set(texts.map((s) => s.fontSize));
    const bolds = new Set(texts.map((s) => s.bold));
    const italics = new Set(texts.map((s) => s.italic));
    if (sizes.size === 1) state.fontSize = [...sizes][0];
    if (bolds.size === 1) state.bold = [...bolds][0];
    if (italics.size === 1) state.italic = [...italics][0];
  }
}

/** Apply a style patch to every selected shape (recolor / re-width all). */
function applyStyleToSelection(patch) {
  if (!state.selectedIds.size) return;
  const shapes = readModel(state.block);
  let changed = false;
  for (const s of shapes) {
    if (state.selectedIds.has(s.id)) { Object.assign(s, patch); changed = true; }
  }
  if (changed) { writeModel(state.block, shapes); commit(); }
}

/* =====================================================================
 * Tiny glyph renderer for the tool buttons (inline-SVG idiom)
 * ===================================================================== */

function toolGlyph(id) {
  const c = 'class="dt-ico" viewBox="0 0 24 24"';
  switch (id) {
    case 'select':  return `<svg ${c}><path d="M5 3l14 8-6 1.5L10 19z"/></svg>`;   // arrow cursor
    case 'rect':    return `<svg ${c}><rect x="4" y="6" width="16" height="12" rx="2"/></svg>`;
    case 'ellipse': return `<svg ${c}><ellipse cx="12" cy="12" rx="8" ry="6"/></svg>`;
    case 'line':    return `<svg ${c}><line x1="5" y1="18" x2="19" y2="6"/></svg>`;
    case 'arrow':   return `<svg ${c}><line x1="5" y1="18" x2="17" y2="7"/><polyline points="11,6 18,6 18,13"/></svg>`;
    case 'pen':     return `<svg ${c}><path d="M3 20c4-1 8-5 12-9l-2-2c-4 4-8 8-9 12z"/></svg>`;
    case 'text':    return `<svg ${c}><path d="M5 5h14M12 5v14M9 19h6"/></svg>`;   // "T"
    case 'list':    return `<svg ${c}><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>`;
    default: return '';
  }
}

/* =====================================================================
 * Helpers
 * ===================================================================== */

function escAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;');
}

/** Escape text content for safe embedding in SVG markup. */
function escXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
