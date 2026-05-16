import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const dir = 'Vless_workers_pages';
const coreSrc = `${dir}/_worker混淆.js`;
const wrapSrc = `${dir}/_worker_chrome_obf.js`;
const coreOut = `${dir}/_worker_core_generated.js`;
const wrapOut = `${dir}/_worker_chrome_obf_generated.js`;
const buildDir = 'build/generated-worker';

mkdirSync(buildDir, { recursive: true });

const coreTmp = `${buildDir}/core.js`;
const wrapInput = `${buildDir}/wrapper-input.js`;
const wrapTmp = `${buildDir}/wrapper.js`;

let wrapper = readFileSync(wrapSrc, 'utf8');
wrapper = wrapper.replace('./_worker混淆.js', './_worker_core_generated.js');
writeFileSync(wrapInput, wrapper);

const common = [
  '--compact', 'true',
  '--identifier-names-generator', 'hexadecimal',
  '--rename-globals', 'false',
  '--string-array', 'true',
  '--string-array-rotate', 'true',
  '--string-array-shuffle', 'true',
  '--string-array-encoding', 'base64',
  '--unicode-escape-sequence', 'true',
  '--transform-object-keys', 'true',
  '--self-defending', 'false',
  '--debug-protection', 'false',
  '--dead-code-injection', 'false'
];

execFileSync('javascript-obfuscator', [
  coreSrc,
  '--output', coreTmp,
  '--string-array-threshold', '0.65',
  '--split-strings', 'true',
  '--split-strings-chunk-length', '8',
  '--control-flow-flattening', 'false',
  ...common
], { stdio: 'inherit' });

execFileSync('javascript-obfuscator', [
  wrapInput,
  '--output', wrapTmp,
  '--string-array-threshold', '0.85',
  '--split-strings', 'true',
  '--split-strings-chunk-length', '6',
  '--control-flow-flattening', 'true',
  '--control-flow-flattening-threshold', '0.3',
  ...common
], { stdio: 'inherit' });

renameSync(coreTmp, coreOut);
renameSync(wrapTmp, wrapOut);
rmSync(buildDir, { recursive: true, force: true });

console.log(`Generated ${coreOut}`);
console.log(`Generated ${wrapOut}`);
