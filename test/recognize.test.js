import test from 'node:test';
import assert from 'node:assert/strict';
import { alignNodes, analyzeInk, classifyShape, splitLines, tidyBox, unifySizes } from '../public/js/recognize.js';
import {
  S,
  diamondStroke,
  ellipseStroke,
  lineStroke,
  parallelogramStroke,
  rectFourStrokes,
  rectStroke,
  scribble,
  stadiumStroke,
} from './fixtures.js';

test('図形の種類を判定できる', () => {
  assert.equal(classifyShape(rectStroke(0, 0, 200, 100)), 'rect');
  assert.equal(classifyShape(diamondStroke(0, 0, 200, 120)), 'diamond');
  assert.equal(classifyShape(ellipseStroke(0, 0, 200, 120)), 'ellipse');
  assert.equal(classifyShape(stadiumStroke(0, 0, 240, 80)), 'round');
  assert.equal(classifyShape(parallelogramStroke(0, 0, 220, 90)), 'parallelogram');
});

test('1本で描いた図形と、中の文字を見分ける', () => {
  const strokes = [S(rectStroke(0, 0, 200, 100)), ...scribble(80, 40).map(S)];
  const r = analyzeInk(strokes);
  assert.equal(r.shapes.length, 1);
  assert.equal(r.shapes[0].shape, 'rect');
  assert.equal(r.texts.length, 1);
  assert.deepEqual(r.texts[0].target, { type: 'shape', index: 0 });
  assert.equal(r.texts[0].strokes.length, 3);
  assert.deepEqual(r.leftover, []);
});

test('4本の線で描いた四角も図形として扱う', () => {
  const r = analyzeInk(rectFourStrokes(0, 0, 180, 90).map(S));
  assert.equal(r.shapes.length, 1);
  assert.equal(r.shapes[0].shape, 'rect');
  assert.equal(r.shapes[0].idx.length, 4);
});

test('図形どうしを結ぶ線を矢印として扱い、矢じりの向きを読む', () => {
  const strokes = [
    S(rectStroke(0, 0, 200, 80)),
    S(diamondStroke(0, 200, 200, 120)),
    S(lineStroke({ x: 100, y: 88 }, { x: 100, y: 196 })),
    // 矢じり（下向き）
    S(lineStroke({ x: 90, y: 182 }, { x: 100, y: 196 })),
  ];
  const r = analyzeInk(strokes);
  assert.equal(r.shapes.length, 2);
  assert.equal(r.connectors.length, 1);
  const c = r.connectors[0];
  assert.equal(r.shapes[c.from.index].shape, 'rect');
  assert.equal(r.shapes[c.to.index].shape, 'diamond');
  assert.deepEqual(r.leftover, []);
});

test('始点側に矢じりがあれば向きを逆にする', () => {
  const strokes = [
    S(rectStroke(0, 0, 200, 80)),
    S(rectStroke(0, 200, 200, 80)),
    S(lineStroke({ x: 100, y: 88 }, { x: 100, y: 196 })),
    S(lineStroke({ x: 90, y: 100 }, { x: 100, y: 88 })),
  ];
  const r = analyzeInk(strokes);
  const c = r.connectors[0];
  assert.ok(r.shapes[c.from.index].bbox.y > 100, '下の四角から上の四角へ');
});

test('既存ノードの間に引いた線や、ノード内の文字も認識する', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0, w: 160, h: 60 },
    { id: 'b', x: 300, y: 0, w: 160, h: 60 },
  ];
  const strokes = [S(lineStroke({ x: 165, y: 30 }, { x: 295, y: 30 })), ...scribble(60, 20).map(S)];
  const r = analyzeInk(strokes, { nodes });
  assert.equal(r.connectors.length, 1);
  assert.deepEqual(r.connectors[0].from, { type: 'node', id: 'a' });
  assert.deepEqual(r.connectors[0].to, { type: 'node', id: 'b' });
  assert.equal(r.texts.length, 1);
  assert.deepEqual(r.texts[0].target, { type: 'node', id: 'a' });
});

test('線の近くの文字はラベル、離れた文字は独立したテキストになる', () => {
  const strokes = [
    S(rectStroke(0, 0, 200, 80)),
    S(rectStroke(0, 300, 200, 80)),
    S(lineStroke({ x: 100, y: 86 }, { x: 100, y: 296 })),
    ...scribble(110, 180, 16).map(S),
    ...scribble(600, 600, 20).map(S),
  ];
  const r = analyzeInk(strokes);
  const targets = r.texts.map((t) => t.target.type).sort();
  assert.deepEqual(targets, ['connector', 'free']);
});

test('どこにもつながらない長い線はインクのまま残す', () => {
  const r = analyzeInk([S(lineStroke({ x: 0, y: 0 }, { x: 400, y: 10 }))]);
  assert.deepEqual(r.leftover, [0]);
});

test('拡大表示中に書いた小さな図形も、画面上の大きさで判定する', () => {
  const strokes = [{ points: rectStroke(0, 0, 50, 25), k: 4 }];
  const r = analyzeInk(strokes);
  assert.equal(r.shapes.length, 1);
});

test('行ごとに分ける', () => {
  const line1 = scribble(0, 0, 20);
  const line2 = scribble(0, 50, 20);
  const lines = splitLines([...line2, ...line1]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].every((s) => s[0].y < 30));
});

test('ノードの大きさを整え、中心線をそろえる', () => {
  const box = tidyBox('rect', { x: 3, y: 7, w: 147, h: 61 });
  assert.equal(box.w % 20, 0);
  assert.equal(box.x % 10, 0);
  const aligned = alignNodes(
    [
      { x: 108, y: 200, w: 100, h: 50 },
      { x: 95, y: 400, w: 120, h: 60 },
    ],
    [{ x: 100, y: 0, w: 100, h: 50 }],
  );
  for (const n of aligned) assert.equal(n.x + n.w / 2, 150);
  const unified = unifySizes([
    { shape: 'rect', x: 0, y: 0, w: 100, h: 50 },
    { shape: 'rect', x: 0, y: 100, w: 120, h: 60 },
  ]);
  assert.equal(unified[0].w, unified[1].w);
});

test('ペンの種類: 文字ペンの線は図形や矢印にならず、図形ペンの線は文字にならない', () => {
  const T = (points) => ({ points, k: 1, kind: 'text' });
  const G = (points) => ({ points, k: 1, kind: 'shape' });
  // 文字ペンで大きな「口」を書いても図形にはならない
  let r = analyzeInk([T(rectStroke(0, 0, 80, 80))]);
  assert.equal(r.shapes.length, 0);
  assert.equal(r.texts.length, 1);
  // 図形ペンの小さな線は文字にならず、手書きのまま残る
  r = analyzeInk([G(lineStroke({ x: 0, y: 0 }, { x: 15, y: 3 }))]);
  assert.equal(r.texts.length, 0);
  assert.deepEqual(r.leftover, [0]);
  // 図形の間でも、文字ペンの横線は矢印ではなく文字（線のラベルなど）
  r = analyzeInk([
    G(rectStroke(0, 0, 200, 80)),
    G(rectStroke(300, 0, 200, 80)),
    T(lineStroke({ x: 205, y: 40 }, { x: 295, y: 40 })),
  ]);
  assert.equal(r.shapes.length, 2);
  assert.equal(r.connectors.length, 0);
  assert.equal(r.texts.length, 1);
  // 図形ペンなら、既存ノードの中に描いた小さめの四角も図形になる
  r = analyzeInk([G(rectStroke(20, 20, 120, 60))], { nodes: [{ id: 'big', x: 0, y: 0, w: 600, h: 400 }] });
  assert.equal(r.shapes.length, 1);
});
