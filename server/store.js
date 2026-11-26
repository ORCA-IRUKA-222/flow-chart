// ボードを JSON ファイルとして保存・読み込みする。
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyOp, boardSummary, emptyBoard, isValidId, pruneTombstones } from '../public/shared/ops.js';

const SAVE_DELAY_MS = 400;

export class BoardStore {
  constructor(dir) {
    this.dir = dir;
    this.boardDir = path.join(dir, 'boards');
    this.boards = new Map();
    this.deleted = new Set();
    this.timers = new Map();
  }

  async load() {
    await mkdir(this.boardDir, { recursive: true });
    for (const file of await readdir(this.boardDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const board = JSON.parse(await readFile(path.join(this.boardDir, file), 'utf8'));
        if (!isValidId(board.id)) continue;
        board.nodes ||= {};
        board.edges ||= {};
        pruneTombstones(board);
        this.boards.set(board.id, board);
      } catch (err) {
        console.warn(`[store] ${file} を読み込めませんでした:`, err.message);
      }
    }
    try {
      const list = JSON.parse(await readFile(path.join(this.dir, 'deleted.json'), 'utf8'));
      if (Array.isArray(list)) list.filter(isValidId).forEach((id) => this.deleted.add(id));
    } catch {
      // まだ削除履歴がない
    }
  }

  list() {
    return [...this.boards.values()].map(boardSummary).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.boards.get(id) || null;
  }

  isDeleted(id) {
    return this.deleted.has(id);
  }

  /** ボードがなければ作る。削除済みなら null */
  ensure(id, name) {
    if (!isValidId(id) || this.deleted.has(id)) return null;
    let board = this.boards.get(id);
    if (!board) {
      board = emptyBoard(id, cleanName(name));
      this.boards.set(id, board);
      this.scheduleSave(id);
    }
    return board;
  }

  rename(id, name) {
    const board = this.boards.get(id);
    if (!board) return null;
    board.name = cleanName(name);
    board.updatedAt = Date.now();
    this.scheduleSave(id);
    return board;
  }

  async remove(id) {
    if (!this.boards.has(id)) return false;
    this.boards.delete(id);
    this.deleted.add(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    await unlink(path.join(this.boardDir, `${id}.json`)).catch(() => {});
    await this.atomicWrite(path.join(this.dir, 'deleted.json'), JSON.stringify([...this.deleted]));
    return true;
  }

  /** op の配列を適用し、実際に反映されたものを返す */
  applyOps(id, ops) {
    const board = this.boards.get(id);
    if (!board || !Array.isArray(ops)) return [];
    const applied = [];
    for (const op of ops.slice(0, 5000)) {
      if (applyOp(board, op)) applied.push(op);
    }
    if (applied.length) {
      board.updatedAt = Date.now();
      this.scheduleSave(id);
    }
    return applied;
  }

  scheduleSave(id) {
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.save(id).catch((err) => console.error('[store] 保存に失敗しました:', err));
      }, SAVE_DELAY_MS),
    );
  }

  async save(id) {
    const board = this.boards.get(id);
    if (!board) return;
    await this.atomicWrite(path.join(this.boardDir, `${id}.json`), JSON.stringify(board));
  }

  async atomicWrite(file, content) {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, content);
    await rename(tmp, file);
  }

  async flush() {
    const ids = [...this.timers.keys()];
    for (const id of ids) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      await this.save(id);
    }
  }
}

function cleanName(name) {
  const s = typeof name === 'string' ? name.trim().slice(0, 100) : '';
  return s || '無題のボード';
}
