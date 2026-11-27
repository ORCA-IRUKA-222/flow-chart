// 無限キャンバス: 描画と操作（パン・ズーム・ノードの移動・接続・編集・手書き）
import {
  GRID,
  arrowHead,
  center,
  containsPoint,
  dist,
  distToPolyline,
  parallelogramSkew,
  pointAlong,
  rectsIntersect,
  roundedPath,
  routeEdge,
  sidePoint,
  snap,
} from './geometry.js';
import { clamp, el, svg, uid } from './util.js';

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 4;
const DOUBLE_TAP_MS = 380;
const DRAG_THRESHOLD = 5;
const HANDLE_OFFSET = 18;
const SIDES = ['top', 'right', 'bottom', 'left'];
const ERASER_RADIUS = 14; // 画面上のピクセル

/** 形ごとの、文字を入れる範囲（ノードに対する割合）と余白 */
export const INSETS = {
  rect: { rx: 1, ry: 1, pad: 10 },
  round: { rx: 0.9, ry: 1, pad: 8 },
  ellipse: { rx: 0.72, ry: 0.72, pad: 4 },
  diamond: { rx: 0.58, ry: 0.58, pad: 2 },
  parallelogram: { rx: 0.76, ry: 1, pad: 8 },
  text: { rx: 1, ry: 1, pad: 4 },
};

const DEFAULT_SIZE = { w: 140, h: 60 };
const MAX_NODE_W = 480;
const MIN_NODE_SIZE = {
  rect: [80, 50],
  round: [100, 50],
  parallelogram: [120, 50],
  diamond: [120, 70],
  ellipse: [100, 60],
  text: [40, 30],
};

export class Canvas extends EventTarget {
  constructor(root, doc) {
    super();
    this.root = root;
    this.doc = doc;
    this.view = { x: 0, y: 0, k: 1 };
    this.tool = 'select'; // select | text | shape | eraser
    this.lastPen = 'text';
    this.penButtons = 0;
    this.swapPenButtons = false;
    this.selNodes = new Set();
    this.selEdges = new Set();
    this.selInk = new Set(); // 選択中の手書きの線（整形の範囲にする）
    this.editing = null; // { k: 'node'|'edge', id }
    this.ink = [];
    this.penSeen = false;
    this.pointers = new Map();
    this.action = null;
    this.hoverNode = null;
    this.lastTap = null;
    this.guides = [];
    this.nodeEls = new Map();
    this.edgeEls = new Map();
    this.labelEls = new Map();
    this.routeCache = new Map();
    this.inkDirty = true;
    this.raf = 0;
    this.build();
    this.bind();
    doc.addEventListener('change', (e) => {
      if (e.detail.reset) {
        this.selNodes.clear();
        this.selEdges.clear();
        this.editing = null;
        this.emitSelection();
      } else {
        this.pruneSelection();
      }
      this.requestRender();
    });
  }

  // ---------- DOM ----------
  build() {
    this.root.classList.add('viewport');
    this.world = el('div', { class: 'world' });
    this.edgeSvg = svg('svg', { class: 'edges-layer' });
    this.edgeG = svg('g');
    this.edgeSvg.append(this.edgeG);
    this.nodesLayer = el('div', { class: 'nodes-layer' });
    this.labelsLayer = el('div', { class: 'labels-layer' });
    this.inkSvg = svg('svg', { class: 'ink-layer' });
    this.inkG = svg('g');
    this.inkSvg.append(this.inkG);
    this.world.append(this.edgeSvg, this.nodesLayer, this.labelsLayer, this.inkSvg);
    this.overlay = svg('svg', { class: 'overlay' });
    this.handles = el('div', { class: 'handles' });
    this.measureEl = el('div', { class: 'measure', 'aria-hidden': 'true' });
    this.root.append(this.world, this.overlay, this.handles, this.measureEl);
  }

  bind() {
    const r = this.root;
    r.addEventListener('pointerdown', (e) => this.onDown(e));
    r.addEventListener('pointermove', (e) => this.onMove(e));
    r.addEventListener('pointerup', (e) => this.onUp(e));
    r.addEventListener('pointercancel', (e) => this.onUp(e, true));
    r.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    r.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS Safari のジェスチャー（ページ全体の拡大）を止める
    r.addEventListener('gesturestart', (e) => e.preventDefault());
    r.addEventListener('touchmove', (e) => this.editing || e.preventDefault(), { passive: false });
    new ResizeObserver(() => this.requestRender()).observe(r);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------- 座標 ----------
  rect() {
    return this.root.getBoundingClientRect();
  }

  screenPoint(e) {
    const r = this.rect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  toWorld(p) {
    return { x: (p.x - this.view.x) / this.view.k, y: (p.y - this.view.y) / this.view.k };
  }

  toScreen(p) {
    return { x: p.x * this.view.k + this.view.x, y: p.y * this.view.k + this.view.y };
  }

  visibleWorld(margin = 200) {
    const r = this.rect();
    const k = this.view.k;
    return {
      x: (-this.view.x - margin) / k,
      y: (-this.view.y - margin) / k,
      w: (r.width + margin * 2) / k,
      h: (r.height + margin * 2) / k,
    };
  }

  setView(v) {
    this.view = { x: v.x, y: v.y, k: clamp(v.k, MIN_ZOOM, MAX_ZOOM) };
    this.requestRender();
    this.emit('view', this.view);
  }

  zoomAt(p, factor) {
    const k = clamp(this.view.k * factor, MIN_ZOOM, MAX_ZOOM);
    const w = this.toWorld(p);
    this.setView({ x: p.x - w.x * k, y: p.y - w.y * k, k });
  }

  zoomBy(factor) {
    const r = this.rect();
    this.zoomAt({ x: r.width / 2, y: r.height / 2 }, factor);
  }

  centerOn(p, k = this.view.k) {
    const r = this.rect();
    this.setView({ x: r.width / 2 - p.x * k, y: r.height / 2 - p.y * k, k });
  }

  fit() {
    const nodes = this.doc.nodes();
    const r = this.rect();
    if (!nodes.length) {
      this.setView({ x: r.width / 2, y: r.height / 3, k: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    const pad = 60;
    const k = clamp(Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY)), MIN_ZOOM, 1.5);
    this.centerOn({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, k);
  }

  setTool(tool) {
    if (tool === 'text' || tool === 'shape') this.lastPen = tool;
    if (tool !== 'eraser') this.hideEraser?.();
    this.tool = tool;
    this.root.dataset.tool = tool;
    this.emit('tool', tool);
  }

  // ---------- 選択 ----------
  emitSelection() {
    this.emit('selection', { nodes: [...this.selNodes], edges: [...this.selEdges], ink: this.selInk.size });
  }

  select(nodes = [], edges = [], ink = []) {
    this.selNodes = new Set(nodes);
    this.selEdges = new Set(edges);
    if (this.selInk.size || ink.length) this.inkDirty = true;
    this.selInk = new Set(ink);
    this.emitSelection();
    this.requestRender();
  }

  /** 選択中の手書き（ない場合は空） */
  selectedInk() {
    return this.ink.filter((s) => this.selInk.has(s));
  }

  pruneSelection() {
    let changed = false;
    for (const id of this.selNodes) if (!this.doc.node(id)) this.selNodes.delete(id), (changed = true);
    for (const id of this.selEdges) if (!this.doc.edge(id)) this.selEdges.delete(id), (changed = true);
    if (this.editing && !this.doc.get(this.editing.k, this.editing.id)) this.editing = null;
    if (changed) this.emitSelection();
  }

  deleteSelection() {
    // 選択中の手書きも消す（元に戻せる）
    if (this.selInk.size) {
      const before = this.ink;
      const after = before.filter((st) => !this.selInk.has(st));
      this.selInk = new Set();
      this.setInk(after);
      this.emit('ink-history', { type: 'replace', before, after });
    }
    const tx = this.doc.tx();
    for (const id of this.selNodes) tx.delNode(id);
    for (const id of this.selEdges) tx.del('edge', id);
    if (tx.size) tx.commit();
    this.select();
  }

  /** 投げ縄で囲んだノード・手書きを選ぶ（中心が囲みの中にあるもの） */
  finishLasso(a) {
    const poly = a.points;
    const nodes = this.doc
      .nodes()
      .filter((n) => pointInPolygon(center(n), poly))
      .map((n) => n.id);
    const ink = this.ink.filter((st) => {
      const inside = st.points.filter((q) => pointInPolygon(q, poly)).length;
      return inside >= st.points.length * 0.6;
    });
    if (a.shift) {
      this.select([...new Set([...this.selNodes, ...nodes])], [...this.selEdges], [...new Set([...this.selInk, ...ink])]);
    } else {
      this.select(nodes, [], ink);
    }
  }

  // ---------- ノード操作 ----------
  createNode(at, props = {}) {
    const shape = props.shape || 'rect';
    const w = props.w || DEFAULT_SIZE.w;
    const h = props.h || (shape === 'diamond' ? 80 : DEFAULT_SIZE.h);
    const node = {
      id: uid(),
      x: snap(at.x - w / 2),
      y: snap(at.y - h / 2),
      w,
      h,
      shape,
      color: props.color || 'default',
      text: props.text || '',
      z: this.doc.maxZ() + 1,
    };
    return node;
  }

  addNodeAt(at, props = {}, { edit = true } = {}) {
    const node = this.createNode(at, props);
    this.doc.tx().put('node', node).commit();
    this.select([node.id]);
    if (edit) this.startEdit('node', node.id);
    return node;
  }

  /** 選択中ノードから、指定方向に新しいノードを線でつないで作る */
  addConnected(fromId, side = 'bottom') {
    const from = this.doc.node(fromId);
    if (!from) return null;
    const shape = ['diamond', 'text'].includes(from.shape) ? 'rect' : from.shape;
    const w = shape === from.shape ? from.w : DEFAULT_SIZE.w;
    const h = shape === from.shape ? from.h : DEFAULT_SIZE.h;
    const c = center(from);
    const gap = 70;
    const at = {
      top: { x: c.x, y: from.y - gap - h / 2 },
      bottom: { x: c.x, y: from.y + from.h + gap + h / 2 },
      left: { x: from.x - gap - w / 2, y: c.y },
      right: { x: from.x + from.w + gap + w / 2, y: c.y },
    }[side];
    const node = this.createNode(at, { shape, w, h, color: from.color });
    // 既存ノードと重なるなら、さらに先へずらす
    for (let i = 0; i < 20 && this.doc.nodes().some((n) => rectsIntersect(inflate(n, 10), node)); i++) {
      if (side === 'top' || side === 'bottom') node.x += from.w + 40;
      else node.y += from.h + 40;
    }
    const edge = { id: uid(), from: fromId, to: node.id, label: '', style: 'orthogonal', arrow: true };
    this.doc.tx().put('node', node).put('edge', edge).commit();
    this.select([node.id]);
    this.startEdit('node', node.id);
    return node;
  }

  connect(fromId, toId) {
    if (fromId === toId) return null;
    const exists = this.doc.edges().find((e) => e.from === fromId && e.to === toId);
    if (exists) {
      this.select([], [exists.id]);
      return exists;
    }
    const edge = { id: uid(), from: fromId, to: toId, label: '', style: 'orthogonal', arrow: true };
    this.doc.tx().put('edge', edge).commit();
    this.select([], [edge.id]);
    return edge;
  }

  duplicateSelection() {
    const ids = [...this.selNodes];
    if (!ids.length) return;
    const map = new Map();
    const tx = this.doc.tx();
    let z = this.doc.maxZ();
    for (const id of ids) {
      const n = this.doc.node(id);
      const copy = { ...n, id: uid(), x: n.x + 40, y: n.y + 40, z: ++z };
      delete copy.u;
      delete copy.c;
      map.set(id, copy.id);
      tx.put('node', copy);
    }
    for (const e of this.doc.edges()) {
      if (map.has(e.from) && map.has(e.to)) {
        tx.put('edge', { id: uid(), from: map.get(e.from), to: map.get(e.to), label: e.label, style: e.style, arrow: e.arrow });
      }
    }
    tx.commit();
    this.select([...map.values()]);
  }

  nudge(dx, dy) {
    const tx = this.doc.tx();
    for (const id of this.selNodes) {
      const n = this.doc.node(id);
      if (n) tx.put('node', { id, x: n.x + dx, y: n.y + dy });
    }
    if (tx.size) tx.commit();
  }

  // ---------- 文字の大きさに合わせる ----------
  measure(text, maxWidth, fontSize = 15) {
    const m = this.measureEl;
    m.style.maxWidth = `${Math.max(10, maxWidth)}px`;
    m.style.fontSize = `${fontSize}px`;
    m.textContent = text || ' ';
    // 末尾の改行も高さに含める
    if (text.endsWith('\n')) m.textContent += ' ';
    return { w: m.offsetWidth, h: m.offsetHeight };
  }

  /**
   * 文字がちょうど収まる大きさ（形ごとの最小サイズ以上）。
   * fixedW を渡すと、その幅のときに必要な高さを返す。
   */
  requiredSize(shape, text, fixedW) {
    const ins = INSETS[shape] || INSETS.rect;
    const [minW, minH] = MIN_NODE_SIZE[shape] || MIN_NODE_SIZE.rect;
    const t = text || '';
    let w = fixedW;
    if (!w) {
      // いちばん長い行が1行に収まる幅（長すぎる場合は折り返す）
      const natural = this.measure(t, 100000);
      w = Math.max(minW, Math.min(MAX_NODE_W, Math.ceil((natural.w + ins.pad * 2 + 6) / ins.rx / (GRID * 2)) * GRID * 2));
    }
    const wrapped = this.measure(t, w * ins.rx - ins.pad * 2);
    const h = Math.max(minH, Math.ceil((wrapped.h + ins.pad * 2 + 4) / ins.ry / GRID) * GRID);
    return { w, h };
  }

  /** 文字が収まるようにノードを大きくする（小さくはしない） */
  fitSize(n, text) {
    const ins = INSETS[n.shape] || INSETS.rect;
    if (!text) return { x: n.x, y: n.y, w: n.w, h: n.h };
    const maxW = 380;
    let w = n.w;
    const natural = this.measure(text, 100000);
    const needW = (natural.w + ins.pad * 2 + 4) / ins.rx;
    if (needW > w) w = Math.min(maxW, Math.ceil(needW / (GRID * 2)) * GRID * 2);
    const wrapped = this.measure(text, w * ins.rx - ins.pad * 2);
    const needH = (wrapped.h + ins.pad * 2 + 4) / ins.ry;
    const h = needH > n.h ? Math.ceil(needH / GRID) * GRID : n.h;
    const cx = n.x + n.w / 2;
    return { x: snap(cx - w / 2), y: n.y, w, h };
  }

  // ---------- 文字の編集 ----------
  startEdit(k, id) {
    this.finishEdit();
    this.editing = { k, id };
    this.render();
    const host = k === 'node' ? this.nodeEls.get(id)?.label : this.labelEls.get(id);
    if (!host) {
      this.editing = null;
      return;
    }
    const item = this.doc.get(k, id);
    host.textContent = (k === 'node' ? item.text : item.label) || '';
    try {
      host.contentEditable = 'plaintext-only';
    } catch {
      host.contentEditable = 'true';
    }
    if (host.contentEditable !== 'plaintext-only') host.contentEditable = 'true';
    host.classList.add('editing');
    host.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(host);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const onKey = (e) => {
      e.stopPropagation();
      if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Escape') {
        e.preventDefault();
        this.finishEdit();
      } else if (e.key === 'Tab' && k === 'node') {
        e.preventDefault();
        this.finishEdit();
        this.addConnected(id, 'bottom');
      }
    };
    const onBlur = () => this.finishEdit();
    host.addEventListener('keydown', onKey);
    host.addEventListener('blur', onBlur);
    this.editCleanup = () => {
      host.removeEventListener('keydown', onKey);
      host.removeEventListener('blur', onBlur);
    };
    this.emit('edit', this.editing);
  }

  finishEdit() {
    if (!this.editing) return;
    const { k, id } = this.editing;
    this.editing = null;
    this.editCleanup?.();
    this.editCleanup = null;
    const host = k === 'node' ? this.nodeEls.get(id)?.label : this.labelEls.get(id);
    const item = this.doc.get(k, id);
    if (host) {
      const text = host.innerText.replace(/\n$/, '').replace(/ /g, ' ');
      host.contentEditable = 'false';
      host.classList.remove('editing');
      host.blur();
      if (item) {
        if (k === 'node' && text !== item.text) {
          this.doc.tx().put('node', { id, text, ...this.fitSize(item, text) }).commit();
        } else if (k === 'edge' && text !== item.label) {
          this.doc.tx().put('edge', { id, label: text }).commit();
        }
      }
    }
    this.emit('edit', null);
    this.requestRender();
  }

  // ---------- 当たり判定 ----------
  nodeAt(w, exclude) {
    let best = null;
    for (const n of this.doc.nodes()) {
      if (n.id === exclude || !containsPoint(n, w)) continue;
      if (!best || (n.z || 0) >= (best.z || 0)) best = n;
    }
    return best;
  }

  hitTest(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return { type: 'empty' };
    const h = t.closest('[data-handle]');
    if (h) return { type: 'handle', side: h.dataset.handle, id: h.dataset.node };
    const rs = t.closest('[data-resize]');
    if (rs) return { type: 'resize', id: rs.dataset.resize };
    const n = t.closest('.node');
    if (n) return { type: 'node', id: n.dataset.id };
    const lb = t.closest('.edge-label');
    if (lb) return { type: 'edge', id: lb.dataset.id };
    const ed = t.closest('.edge');
    if (ed) return { type: 'edge', id: ed.dataset.id };
    return { type: 'empty' };
  }

  // ---------- ポインター操作 ----------
  onDown(e) {
    if (e.target.closest?.('.editing')) return; // 編集中の文字のカーソル操作
    if (this.editing) this.finishEdit();
    if (e.pointerType === 'pen') {
      this.penSeen = true;
      // サイドボタンを押した瞬間（ペン先が浮いていても届く）
      const pressed = e.buttons & ~this.penButtons;
      this.penButtons = e.buttons;
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        this.onPenButton(e.button === 2 ? 'barrel' : 'aux');
        return;
      }
      // ボタンを押したままペン先を付けた（浮かせた状態を検出できないペン）
      if (pressed & 2) this.onPenButton('barrel');
      else if (pressed & 4) this.onPenButton('aux');
      if (e.button > 2 && e.button !== 5) {
        this.emit('pen-button', { unknown: e.button });
        return;
      }
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      // 無視
    }
    // ペンが触れたら、手のひらなどによる指の操作は取り消してペンを優先する
    if (e.pointerType === 'pen' && this.action && this.action.ptype === 'touch') this.cancelAction();
    const touches = [...this.pointers.entries()].filter(([, p]) => p.type === 'touch');
    if (e.pointerType === 'touch' && touches.length === 2 && this.action?.ptype !== 'pen') {
      this.cancelAction();
      this.startPinch(touches);
      return;
    }
    if (this.action) return;
    e.preventDefault();

    const p = this.screenPoint(e);
    const w = this.toWorld(p);
    const hit = this.hitTest(e);
    const base = { pid: e.pointerId, ptype: e.pointerType, sx: p.x, sy: p.y, wx: w.x, wy: w.y, hit, moved: false, shift: e.shiftKey || e.metaKey || e.ctrlKey };

    // ペン先が付いたときの動き（ペンを使ったことがあれば、指は画面の移動・拡大に使う）
    const fingerFree = e.pointerType === 'touch' && this.penSeen;
    const eraserTip = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
    if ((this.tool === 'eraser' && !fingerFree) || eraserTip) {
      this.startErase(e, w);
      return;
    }
    if ((this.tool === 'text' || this.tool === 'shape') && !fingerFree && e.button === 0) {
      this.startInk(e, w, this.tool);
      return;
    }
    if (e.button === 1 || e.button === 2) {
      this.action = { ...base, type: 'pan', view: { ...this.view } };
      return;
    }

    switch (hit.type) {
      case 'handle':
        this.action = { ...base, type: 'connect', from: hit.id, side: hit.side, cur: w, target: null };
        break;
      case 'resize': {
        const n = this.doc.node(hit.id);
        this.action = { ...base, type: 'resize', id: hit.id, orig: { ...n } };
        break;
      }
      case 'node': {
        if (base.shift) {
          if (!this.selNodes.has(hit.id)) this.selNodes.add(hit.id), (base.addedNow = true);
        } else if (!this.selNodes.has(hit.id)) {
          this.selNodes = new Set([hit.id]);
          this.selEdges.clear();
        }
        this.emitSelection();
        const origins = new Map();
        for (const id of this.selNodes) {
          const n = this.doc.node(id);
          if (n) origins.set(id, { x: n.x, y: n.y });
        }
        this.action = { ...base, type: 'move', id: hit.id, origins };
        this.requestRender();
        break;
      }
      case 'edge':
        if (base.shift) this.selEdges.add(hit.id);
        else this.select([], [hit.id]);
        this.emitSelection();
        this.action = { ...base, type: 'tap' };
        this.requestRender();
        break;
      default:
        // マウスは Shift + ドラッグ、ペンはそのままドラッグで範囲選択
        if ((base.shift && e.pointerType === 'mouse') || (e.pointerType === 'pen' && this.tool === 'select')) {
          this.action = { ...base, type: 'lasso', points: [w] };
        } else {
          this.action = { ...base, type: 'pan', view: { ...this.view } };
        }
    }
  }

  onMove(e) {
    const ptr = this.pointers.get(e.pointerId);
    if (ptr) {
      ptr.x = e.clientX;
      ptr.y = e.clientY;
    }
    const a = this.action;
    if (e.pointerType === 'pen') {
      // ペンを浮かせたままサイドボタンを押したとき、pointermove だけが届く環境もある
      const pressed = e.buttons & ~this.penButtons;
      this.penButtons = e.buttons;
      // 書いている途中にボタンを押した場合も切り替える（次の線から有効）
      if (pressed & 2) this.onPenButton('barrel');
      else if (pressed & 4) this.onPenButton('aux');
      if (this.tool === 'eraser' || e.buttons & 32) this.showEraserAt(this.screenPoint(e));
    }
    if (!a) {
      if (e.pointerType === 'mouse') {
        this.updateHover(e);
        if (this.tool === 'eraser') this.showEraserAt(this.screenPoint(e));
      }
      return;
    }
    if (a.type === 'pinch') {
      this.updatePinch();
      return;
    }
    if (!ptr || a.pid !== e.pointerId) return;
    const p = this.screenPoint(e);
    const w = this.toWorld(p);
    if (!a.moved && Math.hypot(p.x - a.sx, p.y - a.sy) < DRAG_THRESHOLD && a.type !== 'ink' && a.type !== 'erase') return;
    a.moved = true;

    switch (a.type) {
      case 'ink': {
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) {
          const q = this.toWorld(this.screenPoint(ev));
          const last = a.stroke.points[a.stroke.points.length - 1];
          if (dist(last, q) * this.view.k >= 1) a.stroke.points.push({ x: q.x, y: q.y, t: performance.now() - a.t0 });
        }
        this.updateLiveStroke(a.stroke);
        break;
      }
      case 'erase': {
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) this.eraseAt(this.toWorld(this.screenPoint(ev)), a);
        this.showEraserAt(p);
        break;
      }
      case 'pan':
        this.setView({ x: a.view.x + (p.x - a.sx), y: a.view.y + (p.y - a.sy), k: a.view.k });
        break;
      case 'move':
        this.dragMove(a, w, e.altKey);
        break;
      case 'resize': {
        const o = a.orig;
        const nw = Math.max(40, snap(o.w + (w.x - a.wx)));
        const nh = Math.max(30, snap(o.h + (w.y - a.wy)));
        this.doc.tx().put('node', { id: a.id, w: nw, h: nh }).commit({ history: false });
        break;
      }
      case 'connect': {
        a.cur = w;
        const t = this.nodeAt(w, a.from);
        a.target = t ? t.id : null;
        this.requestRender();
        break;
      }
      case 'lasso': {
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) {
          const q = this.toWorld(this.screenPoint(ev));
          if (dist(a.points[a.points.length - 1], q) * this.view.k >= 3) a.points.push(q);
        }
        this.requestRender();
        break;
      }
      default:
        break;
    }
  }

  dragMove(a, w, free) {
    const main = a.origins.get(a.id);
    const node = this.doc.node(a.id);
    if (!main || !node) return;
    let nx = main.x + (w.x - a.wx);
    let ny = main.y + (w.y - a.wy);
    this.guides = [];
    if (!free) {
      nx = snap(nx);
      ny = snap(ny);
      // 1つだけ動かすときは、他のノードと中心がそろう位置に吸い付ける
      if (a.origins.size === 1) {
        const tol = 8 / this.view.k;
        const vis = this.visibleWorld(0);
        let bx = null;
        let by = null;
        for (const o of this.doc.nodes()) {
          if (o.id === a.id || !rectsIntersect(o, vis)) continue;
          const ocx = o.x + o.w / 2;
          const ocy = o.y + o.h / 2;
          const dx = Math.abs(ocx - (nx + node.w / 2));
          const dy = Math.abs(ocy - (ny + node.h / 2));
          if (dx < tol && (!bx || dx < bx.d)) bx = { d: dx, v: ocx };
          if (dy < tol && (!by || dy < by.d)) by = { d: dy, v: ocy };
        }
        if (bx) {
          nx = bx.v - node.w / 2;
          this.guides.push({ axis: 'x', v: bx.v });
        }
        if (by) {
          ny = by.v - node.h / 2;
          this.guides.push({ axis: 'y', v: by.v });
        }
      }
    }
    const dx = nx - main.x;
    const dy = ny - main.y;
    const tx = this.doc.tx();
    for (const [id, o] of a.origins) tx.put('node', { id, x: o.x + dx, y: o.y + dy });
    tx.commit({ history: false });
  }

  onUp(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    if (e.pointerType === 'pen') this.penButtons = e.buttons;
    try {
      this.root.releasePointerCapture(e.pointerId);
    } catch {
      // 無視
    }
    const a = this.action;
    if (!a) return;
    if (a.type === 'pinch') {
      if (this.pointers.size < 2) this.action = null;
      return;
    }
    if (a.pid !== e.pointerId) return;
    this.action = null;
    this.guides = [];
    if (cancelled) {
      this.requestRender();
      return;
    }
    const p = this.screenPoint(e);
    const w = this.toWorld(p);

    switch (a.type) {
      case 'ink':
        if (a.stroke.points.length === 1) {
          const q = a.stroke.points[0];
          a.stroke.points.push({ x: q.x + 0.5, y: q.y + 0.5, t: q.t + 1 });
        }
        this.ink.push(a.stroke);
        this.liveStroke?.remove();
        this.liveStroke = null;
        this.inkDirty = true;
        this.emit('ink', this.ink.length);
        this.emit('ink-history', { type: 'add', stroke: a.stroke });
        break;
      case 'erase':
        this.finishErase(a);
        break;
      case 'move':
        if (a.moved) {
          const changes = [];
          for (const [id, o] of a.origins) {
            const n = this.doc.node(id);
            if (!n) continue;
            const before = { ...n, x: o.x, y: o.y };
            changes.push({ k: 'node', id, before: stripMeta(before), after: stripMeta(n) });
          }
          this.doc.pushHistory(changes);
        } else {
          if (a.shift && !a.addedNow) {
            this.selNodes.delete(a.id);
            this.emitSelection();
          } else if (!a.shift) {
            this.select([a.id]);
          }
          this.handleTap(a, w);
        }
        break;
      case 'resize':
        if (a.moved) {
          const n = this.doc.node(a.id);
          if (n) this.doc.pushHistory([{ k: 'node', id: a.id, before: stripMeta(a.orig), after: stripMeta(n) }]);
        }
        break;
      case 'connect':
        this.finishConnect(a, w);
        break;
      case 'lasso':
        if (!a.moved || a.points.length < 3) {
          if (!a.shift) this.select();
          this.handleTap({ ...a, hit: { type: 'empty' } }, w);
        } else {
          this.finishLasso(a);
        }
        break;
      case 'pan':
        if (!a.moved && a.hit.type === 'empty') {
          if (!a.shift) this.select();
          this.handleTap(a, w);
        }
        break;
      case 'tap':
        this.handleTap(a, w);
        break;
      default:
        break;
    }
    this.requestRender();
  }

  handleTap(a, w) {
    const now = performance.now();
    const key = `${a.hit.type}:${a.hit.id || ''}`;
    const last = this.lastTap;
    const isDouble = last && now - last.time < DOUBLE_TAP_MS && last.key === key && Math.hypot(a.sx - last.x, a.sy - last.y) < 24;
    this.lastTap = isDouble ? null : { time: now, key, x: a.sx, y: a.sy };
    if (!isDouble) return;
    if (a.hit.type === 'node') this.startEdit('node', a.hit.id);
    else if (a.hit.type === 'edge') this.startEdit('edge', a.hit.id);
    else if (a.hit.type === 'empty') this.addNodeAt(w);
  }

  finishConnect(a, w) {
    const from = this.doc.node(a.from);
    if (!from) return;
    if (!a.moved) {
      this.addConnected(a.from, a.side);
      return;
    }
    if (a.target) {
      this.connect(a.from, a.target);
      return;
    }
    // 何もない場所で離したら、そこに新しいノードを作ってつなぐ
    const shape = ['diamond', 'text'].includes(from.shape) ? 'rect' : from.shape;
    const node = this.createNode(w, { shape, color: from.color, w: shape === from.shape ? from.w : undefined, h: shape === from.shape ? from.h : undefined });
    const edge = { id: uid(), from: a.from, to: node.id, label: '', style: 'orthogonal', arrow: true };
    this.doc.tx().put('node', node).put('edge', edge).commit();
    this.select([node.id]);
    this.startEdit('node', node.id);
  }

  cancelAction() {
    const a = this.action;
    if (!a) return;
    if (a.type === 'ink') {
      this.liveStroke?.remove();
      this.liveStroke = null;
    }
    if (a.type === 'erase') this.finishErase(a);
    if (a.type === 'move' && a.moved) {
      const tx = this.doc.tx();
      for (const [id, o] of a.origins) tx.put('node', { id, x: o.x, y: o.y });
      tx.commit({ history: false });
    }
    this.action = null;
    this.guides = [];
    this.requestRender();
  }

  startPinch(touches) {
    const [p1, p2] = touches.map(([, p]) => p);
    const r = this.rect();
    this.action = {
      type: 'pinch',
      ids: touches.map(([id]) => id),
      d0: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1,
      m0: { x: (p1.x + p2.x) / 2 - r.left, y: (p1.y + p2.y) / 2 - r.top },
      view: { ...this.view },
    };
  }

  updatePinch() {
    const a = this.action;
    const pts = a.ids.map((id) => this.pointers.get(id)).filter(Boolean);
    if (pts.length < 2) return;
    const r = this.rect();
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const m = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
    const k = clamp(a.view.k * (d / a.d0), MIN_ZOOM, MAX_ZOOM);
    const wx = (a.m0.x - a.view.x) / a.view.k;
    const wy = (a.m0.y - a.view.y) / a.view.k;
    this.setView({ x: m.x - wx * k, y: m.y - wy * k, k });
  }

  onWheel(e) {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const p = this.screenPoint(e);
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(p, Math.exp(-e.deltaY * scale * 0.01));
    } else {
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * scale;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY * scale;
      this.setView({ x: this.view.x - dx, y: this.view.y - dy, k: this.view.k });
    }
  }

  updateHover(e) {
    const t = e.target instanceof Element ? e.target : null;
    let id = t?.closest('.node')?.dataset.id || t?.closest('[data-handle]')?.dataset.node || null;
    if (!id && this.hoverNode) {
      const n = this.doc.node(this.hoverNode);
      const w = this.toWorld(this.screenPoint(e));
      if (n && containsPoint(n, w, (HANDLE_OFFSET + 14) / this.view.k)) id = n.id;
    }
    if (id !== this.hoverNode) {
      this.hoverNode = id;
      this.renderHandles();
    }
  }

  // ---------- 手書き ----------
  /** ペンのサイドボタン: barrel（1つ目）でペンの種類を切り替え、aux（2つ目）で消しゴムの切り替え */
  onPenButton(which) {
    const role = (which === 'barrel') !== this.swapPenButtons ? 'switch' : 'eraser';
    if (role === 'switch') {
      const next = this.tool === 'text' ? 'shape' : this.tool === 'shape' ? 'text' : this.lastPen;
      this.setTool(next);
    } else {
      this.setTool(this.tool === 'eraser' ? this.lastPen : 'eraser');
    }
    this.emit('pen-button', { role, tool: this.tool });
  }

  startInk(e, w, kind) {
    const stroke = { points: [{ x: w.x, y: w.y, t: 0 }], k: this.view.k, width: (kind === 'text' ? 2.2 : 2.6) / this.view.k, kind };
    this.action = { type: 'ink', pid: e.pointerId, ptype: e.pointerType, stroke, t0: performance.now(), sx: 0, sy: 0, moved: true };
    this.liveStroke = svg('path', { class: `ink ink-${kind}`, 'stroke-width': stroke.width });
    this.inkG.append(this.liveStroke);
    this.updateLiveStroke(stroke);
  }

  updateLiveStroke(stroke) {
    this.liveStroke?.setAttribute('d', inkPath(stroke.points));
  }

  startErase(e, w) {
    // mode: 最初に触れたものの種類（'ink' = 手書きだけ、'items' = ノードと線だけ）を、このなぞりの間は消す
    this.action = { type: 'erase', pid: e.pointerId, ptype: e.pointerType, sx: 0, sy: 0, moved: true, removed: [], docChanges: [], mode: null };
    this.eraseAt(w, this.action);
    this.showEraserAt(this.screenPoint(e));
  }

  /** 消しゴムが触れた手書きの線を、線ごと消す（前回の位置からの通り道もすべて調べる） */
  eraseAt(w, a) {
    const r = ERASER_RADIUS / this.view.k;
    const from = a.last || w;
    a.last = w;
    const steps = Math.max(1, Math.ceil(dist(from, w) / (r / 2)));
    for (let i = 1; i <= steps; i++) {
      this.eraseNear({ x: from.x + ((w.x - from.x) * i) / steps, y: from.y + ((w.y - from.y) * i) / steps }, r, a);
    }
  }

  eraseNear(w, r, a) {
    if (a.mode !== 'items' && this.eraseInkNear(w, r, a)) a.mode = 'ink';
    if (a.mode === 'ink') return;
    // なぞり始めに近くに手書きがあれば、手書きを消したいのだと考えてノードや線は消さない
    if (a.mode === null && this.inkNear(w, r * 3)) return;
    if (this.eraseItemsNear(w, r, a)) a.mode = 'items';
  }

  inkNear(w, r) {
    for (const s of this.ink) {
      const b = s.box || (s.box = boxOfPoints(s.points));
      if (w.x < b.x - r || w.x > b.x + b.w + r || w.y < b.y - r || w.y > b.y + b.h + r) continue;
      if (s.points.some((q, j) => distToSeg(w, s.points[j - 1] || q, q) <= r)) return true;
    }
    return false;
  }

  /** 消しゴムが触れた線（橋）を消す。線に触れていなければ、その下のノードを、つながる線ごと消す */
  eraseItemsNear(w, r, a) {
    const changes = [];
    for (const e of this.doc.edges()) {
      const from = this.doc.node(e.from);
      const to = this.doc.node(e.to);
      if (!from || !to) continue;
      if (distToPolyline(w, this.edgeRoute(e, from, to).pts) <= r + 2) changes.push({ k: 'edge', id: e.id, before: stripMeta(e), after: null });
    }
    if (!changes.length) {
      const n = this.nodeAt(w);
      if (n) {
        changes.push({ k: 'node', id: n.id, before: stripMeta(n), after: null });
        for (const e of this.doc.edges()) {
          if (e.from === n.id || e.to === n.id) changes.push({ k: 'edge', id: e.id, before: stripMeta(e), after: null });
        }
      }
    }
    if (!changes.length) return false;
    this.doc.commitChanges(changes, { history: false });
    a.docChanges.push(...changes);
    return true;
  }

  eraseInkNear(w, r, a) {
    let changed = false;
    for (let i = this.ink.length - 1; i >= 0; i--) {
      const s = this.ink[i];
      if (!s.box) s.box = boxOfPoints(s.points);
      const b = s.box;
      if (w.x < b.x - r || w.x > b.x + b.w + r || w.y < b.y - r || w.y > b.y + b.h + r) continue;
      let hit = false;
      for (let j = 0; j < s.points.length && !hit; j++) {
        const q = s.points[j];
        const prev = s.points[j - 1] || q;
        if (distToSeg(w, prev, q) <= r + (s.width || 0) / 2) hit = true;
      }
      if (hit) {
        a.removed.push({ stroke: s, index: i });
        this.ink.splice(i, 1);
        changed = true;
      }
    }
    if (changed) {
      this.inkDirty = true;
      this.requestRender();
      this.emit('ink', this.ink.length);
    }
    return changed;
  }

  finishErase(a) {
    this.hideEraser();
    if (a.removed.length || a.docChanges.length) this.emit('erase-history', { items: a.removed, docChanges: a.docChanges });
  }

  showEraserAt(p) {
    if (!this.eraserEl) {
      this.eraserEl = el('div', { class: 'eraser-cursor' });
      this.root.append(this.eraserEl);
    }
    this.eraserEl.style.transform = `translate(${p.x}px, ${p.y}px)`;
    this.eraserEl.style.display = 'block';
  }

  hideEraser() {
    if (this.eraserEl) this.eraserEl.style.display = 'none';
  }

  setInk(strokes) {
    this.ink = strokes;
    if (this.selInk.size) {
      const alive = new Set(strokes);
      const before = this.selInk.size;
      this.selInk = new Set([...this.selInk].filter((st) => alive.has(st)));
      if (this.selInk.size !== before) this.emitSelection();
    }
    this.inkDirty = true;
    this.requestRender();
    this.emit('ink', this.ink.length);
  }

  clearInk() {
    if (!this.ink.length) return;
    const before = this.ink;
    this.setInk([]);
    this.emit('ink-history', { type: 'replace', before, after: [] });
  }

  /** 手書きの操作を元に戻す / やり直す */
  applyInkRecord(rec, dir) {
    const undo = dir === 'undo';
    if (rec.type === 'add') {
      if (undo) this.ink = this.ink.filter((s) => s !== rec.stroke);
      else this.ink.push(rec.stroke);
    } else if (rec.type === 'erase') {
      if (undo) {
        const items = [...rec.items].sort((x, y) => x.index - y.index);
        for (const it of items) this.ink.splice(Math.min(it.index, this.ink.length), 0, it.stroke);
      } else {
        const gone = new Set(rec.items.map((it) => it.stroke));
        this.ink = this.ink.filter((s) => !gone.has(s));
      }
    } else if (rec.type === 'replace') {
      this.ink = [...(undo ? rec.before : rec.after)];
    }
    this.setInk(this.ink);
  }

  // ---------- 描画 ----------
  requestRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  render() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    const { x, y, k } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    let g = 20 * k;
    while (g < 12) g *= 5;
    this.root.style.setProperty('--grid', `${g}px`);
    this.root.style.backgroundPosition = `${x}px ${y}px`;
    const vis = this.visibleWorld();
    this.renderNodes(vis);
    this.renderEdges(vis);
    if (this.inkDirty) this.renderInk();
    this.renderOverlay();
    this.renderHandles();
  }

  renderNodes(vis) {
    const seen = new Set();
    for (const n of this.doc.nodes()) {
      const keep = this.selNodes.has(n.id) || this.editing?.id === n.id || this.action?.from === n.id;
      if (!keep && !rectsIntersect(n, vis)) continue;
      seen.add(n.id);
      let ne = this.nodeEls.get(n.id);
      if (!ne) {
        ne = createNodeEl(n.id);
        this.nodesLayer.append(ne.root);
        this.nodeEls.set(n.id, ne);
      }
      const sel = this.selNodes.has(n.id);
      const target = this.action?.type === 'connect' && this.action.target === n.id;
      const stateKey = `${n.u}|${sel}|${target}`;
      if (ne.key === stateKey) continue;
      ne.key = stateKey;
      updateNodeEl(ne, n, { sel, target, editing: this.editing?.k === 'node' && this.editing.id === n.id });
    }
    for (const [id, ne] of this.nodeEls) {
      if (!seen.has(id)) {
        ne.root.remove();
        this.nodeEls.delete(id);
      }
    }
  }

  edgeRoute(e, a, b) {
    const key = `${a.u}|${b.u}|${e.u}`;
    const c = this.routeCache.get(e.id);
    if (c && c.key === key) return c;
    const pts = routeEdge(a, b, e.style);
    const r = { key, pts, bbox: boxOfPoints(pts) };
    this.routeCache.set(e.id, r);
    return r;
  }

  /** ラベル付けや手書き認識用に、線の経路を返す */
  edgeLines() {
    const out = [];
    for (const e of this.doc.edges()) {
      const a = this.doc.node(e.from);
      const b = this.doc.node(e.to);
      if (a && b) out.push({ id: e.id, points: this.edgeRoute(e, a, b).pts });
    }
    return out;
  }

  renderEdges(vis) {
    const seen = new Set();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const e of this.doc.edges()) {
      const a = this.doc.node(e.from);
      const b = this.doc.node(e.to);
      if (!a || !b) continue;
      const route = this.edgeRoute(e, a, b);
      const sel = this.selEdges.has(e.id);
      const editingLabel = this.editing?.k === 'edge' && this.editing.id === e.id;
      if (!sel && !editingLabel && !rectsIntersect(inflate(route.bbox, 20), vis)) continue;
      seen.add(e.id);
      minX = Math.min(minX, route.bbox.x);
      minY = Math.min(minY, route.bbox.y);
      maxX = Math.max(maxX, route.bbox.x + route.bbox.w);
      maxY = Math.max(maxY, route.bbox.y + route.bbox.h);
      let ee = this.edgeEls.get(e.id);
      if (!ee) {
        const gEl = svg('g', { class: 'edge' });
        gEl.dataset.id = e.id;
        const hit = svg('path', { class: 'hit' });
        const line = svg('path', { class: 'line' });
        const head = svg('path', { class: 'head' });
        gEl.append(hit, line, head);
        this.edgeG.append(gEl);
        ee = { g: gEl, hit, line, head, key: '' };
        this.edgeEls.set(e.id, ee);
      }
      const key = `${route.key}|${sel}`;
      if (ee.key !== key) {
        ee.key = key;
        const d = e.style === 'straight' ? roundedPath(route.pts, 0) : roundedPath(route.pts, 10);
        ee.hit.setAttribute('d', d);
        ee.line.setAttribute('d', d);
        ee.head.setAttribute('d', e.arrow ? arrowHead(route.pts) : '');
        ee.g.classList.toggle('selected', sel);
      }
      // ラベル
      let lb = this.labelEls.get(e.id);
      if (e.label || editingLabel) {
        if (!lb) {
          lb = el('div', { class: 'edge-label' });
          lb.dataset.id = e.id;
          this.labelsLayer.append(lb);
          this.labelEls.set(e.id, lb);
        }
        const pos = pointAlong(route.pts, 0.5);
        lb.style.left = `${pos.x}px`;
        lb.style.top = `${pos.y}px`;
        lb.classList.toggle('selected', sel);
        if (!editingLabel && lb.textContent !== e.label) lb.textContent = e.label;
      } else if (lb) {
        lb.remove();
        this.labelEls.delete(e.id);
      }
    }
    for (const [id, ee] of this.edgeEls) {
      if (!seen.has(id)) {
        ee.g.remove();
        this.edgeEls.delete(id);
        const lb = this.labelEls.get(id);
        if (lb) {
          lb.remove();
          this.labelEls.delete(id);
        }
      }
    }
    for (const id of this.routeCache.keys()) if (!this.doc.edge(id)) this.routeCache.delete(id);
    if (seen.size) {
      const m = 30;
      const bx = Math.floor(minX - m);
      const by = Math.floor(minY - m);
      Object.assign(this.edgeSvg.style, {
        left: `${bx}px`,
        top: `${by}px`,
        width: `${Math.ceil(maxX - minX + m * 2)}px`,
        height: `${Math.ceil(maxY - minY + m * 2)}px`,
      });
      this.edgeG.setAttribute('transform', `translate(${-bx} ${-by})`);
    }
  }

  renderInk() {
    this.inkDirty = false;
    for (const child of [...this.inkG.children]) if (child !== this.liveStroke) child.remove();
    for (const s of this.ink) {
      const cls = `ink ink-${s.kind || 'any'}${this.selInk.has(s) ? ' selected' : ''}`;
      this.inkG.insertBefore(svg('path', { class: cls, d: inkPath(s.points), 'stroke-width': s.width }), this.liveStroke || null);
    }
  }

  renderOverlay() {
    const o = this.overlay;
    o.replaceChildren();
    const a = this.action;
    for (const gd of this.guides) {
      const r = this.rect();
      if (gd.axis === 'x') {
        const sx = this.toScreen({ x: gd.v, y: 0 }).x;
        o.append(svg('line', { class: 'guide', x1: sx, y1: 0, x2: sx, y2: r.height }));
      } else {
        const sy = this.toScreen({ x: 0, y: gd.v }).y;
        o.append(svg('line', { class: 'guide', x1: 0, y1: sy, x2: r.width, y2: sy }));
      }
    }
    if (a?.type === 'connect' && a.moved) {
      const from = this.doc.node(a.from);
      if (from) {
        const s = this.toScreen(sidePoint(from, a.side));
        const target = a.target && this.doc.node(a.target);
        const e = this.toScreen(target ? center(target) : a.cur);
        o.append(svg('line', { class: 'connect-preview', x1: s.x, y1: s.y, x2: e.x, y2: e.y }));
        o.append(svg('circle', { class: 'connect-dot', cx: e.x, cy: e.y, r: 5 }));
      }
    }
    if (a?.type === 'lasso' && a.moved && a.points.length > 1) {
      const pts = a.points.map((q) => this.toScreen(q));
      o.append(svg('path', { class: 'lasso', d: `M${pts.map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' L')} Z` }));
    }
    // 選択中の手書きを点線の枠で囲む
    if (this.selInk.size && !(a && a.type === 'lasso')) {
      const sel = this.selectedInk();
      if (sel.length) {
        const b = boxOfPoints(sel.flatMap((st) => st.points));
        const p1 = this.toScreen({ x: b.x, y: b.y });
        const p2 = this.toScreen({ x: b.x + b.w, y: b.y + b.h });
        o.append(svg('rect', { class: 'ink-selection', x: p1.x - 8, y: p1.y - 8, width: p2.x - p1.x + 16, height: p2.y - p1.y + 16, rx: 6 }));
      }
    }
  }

  renderHandles() {
    const h = this.handles;
    const busy = this.action && ['move', 'resize', 'pinch', 'pan', 'ink'].includes(this.action.type) && this.action.moved;
    const ids = new Set();
    if (!busy && this.tool === 'select') {
      if (this.selNodes.size === 1) ids.add([...this.selNodes][0]);
      if (this.hoverNode && !this.action) ids.add(this.hoverNode);
      if (this.action?.type === 'connect') ids.add(this.action.from);
    }
    if (this.editing) ids.clear();
    const parts = [];
    for (const id of ids) {
      const n = this.doc.node(id);
      if (!n) continue;
      for (const side of SIDES) {
        const sp = this.toScreen(sidePoint(n, side));
        const off = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[side];
        parts.push({ kind: 'handle', id, side, x: sp.x + off[0] * HANDLE_OFFSET, y: sp.y + off[1] * HANDLE_OFFSET });
      }
      if (this.selNodes.size === 1 && this.selNodes.has(id)) {
        const br = this.toScreen({ x: n.x + n.w, y: n.y + n.h });
        parts.push({ kind: 'resize', id, x: br.x, y: br.y });
      }
    }
    // 要素は作り直さず使い回す（操作中の要素が消えないように）
    this.handleEls ||= new Map();
    const alive = new Set();
    for (const p of parts) {
      const key = `${p.kind}:${p.id}:${p.side || ''}`;
      alive.add(key);
      let d = this.handleEls.get(key);
      if (!d) {
        d =
          p.kind === 'handle'
            ? el('div', { class: 'handle', 'data-handle': p.side, 'data-node': p.id, title: 'ドラッグで線を引く／タップで次のノードを追加' })
            : el('div', { class: 'resize', 'data-resize': p.id, title: 'ドラッグで大きさを変更' });
        h.append(d);
        this.handleEls.set(key, d);
      }
      d.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    for (const [key, d] of this.handleEls) {
      if (!alive.has(key)) {
        d.remove();
        this.handleEls.delete(key);
      }
    }
  }

  // ---------- キーボード ----------
  handleKey(e) {
    if (this.editing) return false;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (key === 'Delete' || key === 'Backspace') {
      if (!this.selNodes.size && !this.selEdges.size) return false;
      this.deleteSelection();
      return true;
    }
    if (key === 'Escape') {
      this.cancelAction();
      this.select();
      return true;
    }
    if (key === 'Enter' && this.selNodes.size === 1) {
      this.startEdit('node', [...this.selNodes][0]);
      return true;
    }
    if (key === 'Enter' && this.selEdges.size === 1 && !this.selNodes.size) {
      this.startEdit('edge', [...this.selEdges][0]);
      return true;
    }
    if (key === 'Tab' && this.selNodes.size === 1) {
      this.addConnected([...this.selNodes][0], e.shiftKey ? 'right' : 'bottom');
      return true;
    }
    if (mod && key.toLowerCase() === 'a') {
      this.select(
        this.doc.nodes().map((n) => n.id),
        [],
      );
      return true;
    }
    if (mod && key.toLowerCase() === 'd') {
      this.duplicateSelection();
      return true;
    }
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (arrows[key] && this.selNodes.size) {
      const step = e.shiftKey ? GRID * 5 : GRID;
      this.nudge(arrows[key][0] * step, arrows[key][1] * step);
      return true;
    }
    return false;
  }
}

// ---------- ノード要素 ----------
function createNodeEl(id) {
  const root = el('div', { class: 'node' });
  root.dataset.id = id;
  const shapeSvg = svg('svg', { class: 'shape' });
  const label = el('div', { class: 'label' });
  root.append(shapeSvg, label);
  return { root, shapeSvg, label, key: '', shapeKey: '' };
}

function updateNodeEl(ne, n, { sel, target, editing }) {
  const s = ne.root.style;
  s.transform = `translate(${n.x}px, ${n.y}px)`;
  s.width = `${n.w}px`;
  s.height = `${n.h}px`;
  s.zIndex = String(Math.round(n.z || 0));
  ne.root.className = `node shape-${n.shape} c-${n.color || 'default'}${sel ? ' selected' : ''}${target ? ' drop-target' : ''}`;
  const shapeKey = `${n.shape}|${n.w}|${n.h}`;
  if (ne.shapeKey !== shapeKey) {
    ne.shapeKey = shapeKey;
    ne.shapeSvg.setAttribute('viewBox', `0 0 ${n.w} ${n.h}`);
    ne.shapeSvg.replaceChildren(shapeElement(n));
    const ins = INSETS[n.shape] || INSETS.rect;
    Object.assign(ne.label.style, {
      left: `${((1 - ins.rx) / 2) * 100}%`,
      top: `${((1 - ins.ry) / 2) * 100}%`,
      width: `${ins.rx * 100}%`,
      height: `${ins.ry * 100}%`,
      padding: `${ins.pad}px`,
    });
  }
  if (!editing && ne.label.textContent !== n.text) ne.label.textContent = n.text;
}

function shapeElement(n) {
  const { w, h } = n;
  const i = 1.5;
  switch (n.shape) {
    case 'round':
      return svg('rect', { x: i, y: i, width: w - i * 2, height: h - i * 2, rx: Math.min(h / 2, 40) - i });
    case 'ellipse':
      return svg('ellipse', { cx: w / 2, cy: h / 2, rx: w / 2 - i, ry: h / 2 - i });
    case 'diamond':
      return svg('polygon', { points: `${w / 2},${i} ${w - i},${h / 2} ${w / 2},${h - i} ${i},${h / 2}` });
    case 'parallelogram': {
      const k = parallelogramSkew(n);
      return svg('polygon', { points: `${k + i},${i} ${w - i},${i} ${w - k - i},${h - i} ${i},${h - i}` });
    }
    case 'text':
      return svg('rect', { x: i, y: i, width: w - i * 2, height: h - i * 2, rx: 4, class: 'text-box' });
    case 'rect':
    default:
      return svg('rect', { x: i, y: i, width: w - i * 2, height: h - i * 2, rx: 4 });
  }
}

// ---------- 補助 ----------
function inkPath(pts) {
  if (!pts.length) return '';
  if (pts.length < 3) return `M${pts[0].x} ${pts[0].y} ${pts.map((p) => `L${p.x} ${p.y}`).join(' ')}`;
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function normRect(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function inflate(r, m) {
  return { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 };
}

function boxOfPoints(pts) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function stripMeta(v) {
  const out = { ...v };
  delete out.u;
  delete out.c;
  delete out.id;
  delete out.deleted;
  return out;
}
