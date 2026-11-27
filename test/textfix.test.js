import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCandidate, fixLookalikes, wordsOf } from '../public/js/textfix.js';
import { splitLines } from '../public/js/recognize.js';
import { scribble, jitter, polyline } from './fixtures.js';

test('見た目がそっくりな字を、前後の文字から直す', () => {
  assert.equal(fixLookalikes('入カ'), '入力');
  assert.equal(fixLookalikes('工ラー'), 'エラー');
  assert.equal(fixLookalikes('メ一ル'), 'メール');
  assert.equal(fixLookalikes('人ロ'), '人口');
  assert.equal(fixLookalikes('第ー'), '第一');
  assert.equal(fixLookalikes('データをへんしゅう'), 'データをへんしゅう');
  assert.equal(fixLookalikes('ヘルプ'), 'ヘルプ');
  assert.equal(fixLookalikes('あへい'), 'あへい');
  assert.equal(fixLookalikes('カ'), 'カ'); // 1文字だけなら判断できないのでそのまま
  assert.equal(fixLookalikes('力ード'), 'カード');
  assert.equal(fixLookalikes('Yes'), 'Yes');
});

test('候補選び: 前に直した内容、よく使う言葉を優先する', () => {
  // 見た目の修正が先頭に来る
  assert.equal(chooseCandidate(['入カ', '人カ']).text, '入力');
  // よく使う言葉に一致する候補
  const vocab = new Set(['承認']);
  assert.equal(chooseCandidate(['水認', '承認', '永認'], { vocab }).text, '承認');
  // 前に直した読み間違い
  assert.equal(chooseCandidate(['開治'], { corrections: { 開治: '開始' } }).text, '開始');
  // 候補は重複なし・選んだものが先頭
  const r = chooseCandidate(['A', 'B', 'A']);
  assert.deepEqual(r.candidates, ['A', 'B']);
  assert.equal(chooseCandidate([]).text, null);
});

test('単語の取り出し', () => {
  assert.deepEqual(wordsOf('開始\n入力する\nA'), ['開始', '入力する']);
});

test('行分け: 1行の文字を2行に分けない', () => {
  // 「二」のように横線だけの字
  const ni = [jitter(polyline([{ x: 0, y: 0 }, { x: 30, y: 0 }], 6), 1), jitter(polyline([{ x: -3, y: 16 }, { x: 33, y: 16 }], 6), 1)];
  assert.equal(splitLines(ni).length, 1);
  // 濁点のような小さな線は、行にならない
  const withDots = [...scribble(0, 0, 24), jitter(polyline([{ x: 26, y: -12 }, { x: 28, y: -8 }], 3), 0.5)];
  assert.equal(splitLines(withDots).length, 1);
  // はっきり離れた2行は分ける
  assert.equal(splitLines([...scribble(0, 0, 24), ...scribble(0, 60, 24)]).length, 2);
});

test('行分け: 行間を詰めて書いた2行・少し重なった2行も分ける', () => {
  // 字の高さ 24 に対して、行間 4（詰めて書いた）
  const tight = [...scribble(0, 8, 24), ...scribble(30, 8, 24), ...scribble(0, 44, 24), ...scribble(30, 44, 24)];
  const lines = splitLines(tight);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].every((s) => s[0].y < 40));
  // 下の行の字が上の行に少しかかっている（隙間なし）
  const overlap = [...scribble(0, 8, 24), ...scribble(30, 8, 24), ...scribble(60, 8, 24), ...scribble(0, 38, 24), ...scribble(30, 38, 24), ...scribble(60, 38, 24)];
  assert.equal(splitLines(overlap).length, 2);
  // 3行
  assert.equal(splitLines([...scribble(0, 8, 24), ...scribble(0, 44, 24), ...scribble(0, 80, 24)]).length, 3);
});

test('行分け: 書いた順を保つ', () => {
  const a = [{ x: 50, y: 0, t: 100 }, { x: 60, y: 10, t: 110 }];
  const b = [{ x: 0, y: 0, t: 200 }, { x: 10, y: 10, t: 210 }];
  const [line] = splitLines([b, a]);
  assert.deepEqual(line, [a, b]);
});

test('行分け: 縦に長い字が並んだ1行は、途中で切らない', () => {
  // 縦線の長い字（高さ 60）と、上下に分かれた短い線
  const tall = [];
  for (let i = 0; i < 4; i++) {
    const x = i * 40;
    tall.push(jitter(polyline([{ x: x + 15, y: 0 }, { x: x + 15, y: 60 }], 10), 1));
    tall.push(jitter(polyline([{ x, y: 5 }, { x: x + 30, y: 5 }], 6), 1));
    tall.push(jitter(polyline([{ x, y: 55 }, { x: x + 30, y: 55 }], 6), 1));
  }
  assert.equal(splitLines(tall).length, 1);
});
