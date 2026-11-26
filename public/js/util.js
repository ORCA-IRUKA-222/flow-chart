// 小さな共通関数

/** http（非セキュア）の LAN 接続でも使える ID 生成 */
export function uid(len = 12) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

let toastTimer = null;
export function toast(message, { duration = 2600, kind = '' } = {}) {
  const box = document.getElementById('toast');
  if (!box) return;
  box.textContent = message;
  box.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  if (duration > 0) toastTimer = setTimeout(() => (box.className = 'toast'), duration);
}

export function hideToast() {
  const box = document.getElementById('toast');
  if (box) box.className = 'toast';
}
