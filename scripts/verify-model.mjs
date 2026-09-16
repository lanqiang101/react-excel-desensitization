import { existsSync, readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';

const modelPath = new URL('../model/model.onnx', import.meta.url);
const tokenizerPath = new URL('../model/tokenizer.json', import.meta.url);
const configPath = new URL('../model/config.json', import.meta.url);
const session = await ort.InferenceSession.create(modelPath.pathname);
const shape = [1, 16];
const inputIds = new BigInt64Array(16).fill(0n);
inputIds[0] = 101n;
inputIds[1] = 102n;
const attentionMask = new BigInt64Array(16).fill(1n);
const tokenTypeIds = new BigInt64Array(16);
const output = await session.run({
  input_ids: new ort.Tensor('int64', inputIds, shape),
  attention_mask: new ort.Tensor('int64', attentionMask, shape),
  token_type_ids: new ort.Tensor('int64', tokenTypeIds, shape),
});
const logits = output.logits;
const finite = Array.from(logits.data).every(Number.isFinite);

console.log(
  JSON.stringify(
    {
      inputs: session.inputNames,
      outputs: session.outputNames,
      logitsShape: logits.dims,
      finite,
      tokenizerPresent: existsSync(tokenizerPath),
      configLabels: Object.keys(JSON.parse(readFileSync(configPath, 'utf8')).id2label ?? {}).length,
    },
    null,
    2
  )
);

if (!finite || logits.dims.join(',') !== '1,16,111') {
  process.exitCode = 1;
}
