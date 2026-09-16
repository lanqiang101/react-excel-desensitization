import * as ort from 'onnxruntime-web';
import wasmModuleUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import wasmBinaryUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';

import type { ModelEntity } from './desensitizer';

const MODEL_PATH = '/models/rampart/model.onnx';
const VOCAB_PATH = '/models/rampart/vocab.txt';
const CONFIG_PATH = '/models/rampart/config.json';
const MAX_LENGTH = 512;

type Token = { id: number; text: string; start: number; end: number };

type ScannerState = {
  session: ort.InferenceSession;
  vocab: Map<string, number>;
  labels: Record<string, string>;
};

let scannerState: ScannerState | null = null;
let scannerPromise: Promise<ScannerState> | null = null;

ort.env.wasm.wasmPaths = {
  mjs: wasmModuleUrl,
  wasm: wasmBinaryUrl,
};

async function loadScanner(): Promise<ScannerState> {
  const [vocabResponse, configResponse] = await Promise.all([
    fetch(VOCAB_PATH),
    fetch(CONFIG_PATH),
  ]);
  if (!vocabResponse.ok || !configResponse.ok) throw new Error('模型词表或配置文件不可用');

  const vocab = new Map<string, number>();
  (await vocabResponse.text()).split(/\r?\n/).forEach((token, id) => {
    if (token) vocab.set(token, id);
  });
  const config = (await configResponse.json()) as { id2label?: Record<string, string> };
  const session = await ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return { session, vocab, labels: config.id2label ?? {} };
}

export async function initializeModelScanner(): Promise<void> {
  if (scannerState) return;
  scannerPromise ??= loadScanner();
  scannerState = await scannerPromise;
}

function wordPieceTokens(
  text: string,
  start: number,
  end: number,
  vocab: Map<string, number>
): Token[] {
  const tokens: Token[] = [];
  const value = text.slice(start, end).toLowerCase();
  if (vocab.has(value)) return [{ id: vocab.get(value)!, text: value, start, end }];

  let cursor = 0;
  while (cursor < value.length) {
    let matchEnd = value.length;
    let match = '';
    while (cursor < matchEnd) {
      const candidate = `${cursor === 0 ? '' : '##'}${value.slice(cursor, matchEnd)}`;
      if (vocab.has(candidate)) {
        match = candidate;
        break;
      }
      matchEnd -= 1;
    }
    if (!match) return [{ id: vocab.get('[UNK]') ?? 100, text: '[UNK]', start, end }];
    const pieceLength = match.replace(/^##/, '').length;
    tokens.push({
      id: vocab.get(match)!,
      text: match,
      start: start + cursor,
      end: start + cursor + pieceLength,
    });
    cursor += pieceLength;
  }
  return tokens;
}

function tokenize(text: string, vocab: Map<string, number>): Token[] {
  const tokens: Token[] = [{ id: vocab.get('[CLS]') ?? 101, text: '[CLS]', start: -1, end: -1 }];
  const basicPattern = /[A-Za-z0-9]+|[\u4e00-\u9fff]|[^\sA-Za-z0-9\u4e00-\u9fff]/g;
  for (const match of text.matchAll(basicPattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    tokens.push(...wordPieceTokens(text, start, end, vocab));
    if (tokens.length >= MAX_LENGTH - 1) break;
  }
  tokens.push({ id: vocab.get('[SEP]') ?? 102, text: '[SEP]', start: -1, end: -1 });
  return tokens.slice(0, MAX_LENGTH);
}

function softmax(values: number[]): number[] {
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

export async function scanText(text: string): Promise<ModelEntity[]> {
  await initializeModelScanner();
  if (!scannerState) throw new Error('模型扫描器未初始化');
  const tokens = tokenize(text, scannerState.vocab);
  const length = tokens.length;
  const inputIds = BigInt64Array.from(tokens.map((token) => BigInt(token.id)));
  const attentionMask = BigInt64Array.from(tokens.map(() => 1n));
  const tokenTypeIds = BigInt64Array.from(tokens.map(() => 0n));
  const output = await scannerState.session.run({
    input_ids: new ort.Tensor('int64', inputIds, [1, length]),
    attention_mask: new ort.Tensor('int64', attentionMask, [1, length]),
    token_type_ids: new ort.Tensor('int64', tokenTypeIds, [1, length]),
  });
  const logits = output.logits as ort.Tensor;
  const numLabels = logits.dims[2] as number;
  const entities: ModelEntity[] = [];
  let current: ModelEntity | null = null;

  for (let index = 1; index < length - 1; index += 1) {
    const row = Array.from(logits.data as Float32Array).slice(
      index * numLabels,
      (index + 1) * numLabels
    );
    const probabilities = softmax(row);
    const labelId = probabilities.indexOf(Math.max(...probabilities));
    const label = scannerState.labels[String(labelId)] ?? 'O';
    const token = tokens[index];
    if (label.startsWith('B-') && token.start >= 0) {
      if (current) entities.push(current);
      current = {
        text: text.slice(token.start, token.end),
        label: label.slice(2),
        confidence: probabilities[labelId],
        start: token.start,
        end: token.end,
      };
    } else if (label.startsWith('I-') && current && label.slice(2) === current.label) {
      current.end = token.end;
      current.text = text.slice(current.start, current.end);
      current.confidence = Math.min(current.confidence, probabilities[labelId]);
    } else if (current) {
      entities.push(current);
      current = null;
    }
  }
  if (current) entities.push(current);
  return entities;
}
