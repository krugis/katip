#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// How often names are found in Turkish text (tracker P1-13). Builds the analyzer from the
// config, starts its own copy with made-up data only, and leaves nothing behind. `pnpm build` first.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const presidio = loadConfig().images.presidio_analyzer;
const IMAGE = 'katip-presidio-recall:local';
const NAME = `katip-presidio-recall-${process.pid}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const FLOOR = 0.8;
const CLEAN_CEILING = 0.1;

const buildArgs = {
  PRESIDIO_REGISTRY: presidio.registry,
  PRESIDIO_VERSION: presidio.version,
  SPACY_MODEL_VERSION: presidio.spacy_model_version,
  SPACY_MODEL_SHA256: presidio.spacy_model_sha256,
  NER_MODEL: presidio.ner_model,
  NER_MODEL_REVISION: presidio.ner_model_revision,
};
execFileSync(
  'docker',
  [
    'build',
    ...Object.entries(buildArgs).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]),
    '-t',
    IMAGE,
    join(root, 'infra/presidio'),
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

let failed = false;
// As in dev.yml, on 2 CPUs like a small server, so the times mean something.
docker(
  'run',
  '-d',
  '--name',
  NAME,
  '--cpus=2',
  '-e',
  'PORT=3000',
  '-e',
  'WORKERS=2',
  '-e',
  'OMP_NUM_THREADS=2',
  '-p',
  '127.0.0.1:0:3000',
  IMAGE,
);
try {
  const port = docker('port', NAME, '3000/tcp').split('\n')[0].split(':').pop();
  const url = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    up = await fetch(`${url}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (!up) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!up) throw new Error(`the analyzer did not start:\n${docker('logs', '--tail', '20', NAME)}`);

  const { PresidioClient } = await import(join(root, 'packages/pii/dist/index.js'));
  const fixtures = JSON.parse(
    readFileSync(join(root, 'packages/pii/test/fixtures/tr-recall.json'), 'utf8'),
  );
  const client = new PresidioClient({ baseUrl: url, timeoutMs: 30_000 });

  const byStyle = new Map();
  const missed = [];
  const times = [];
  for (const c of fixtures.cases) {
    const names = c.entities.filter((e) => e.type === 'PERSON');
    if (names.length === 0) continue;
    const started = performance.now();
    const person = (await client.detect(c.text)).filter((s) => s.type === 'PERSON');
    times.push(performance.now() - started);
    for (const name of names) {
      const start = c.text.indexOf(name.value);
      const end = start + name.value.length;
      const row = byStyle.get(c.style) ?? { total: 0, whole: 0, part: 0 };
      row.total += 1;
      if (person.some((s) => s.start <= start && s.end >= end)) row.whole += 1;
      else missed.push(c.text);
      if (person.some((s) => s.start < end && s.end > start)) row.part += 1;
      byStyle.set(c.style, row);
    }
  }

  let wrong = 0;
  for (const text of fixtures.clean) {
    const spans = await client.detect(text);
    if (spans.length > 0) {
      wrong += 1;
      console.log(`  wrongly named a person in: ${text} (${spans.map((s) => s.value).join(', ')})`);
    }
  }

  const rows = [...byStyle.values()];
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  for (const [style, row] of byStyle) {
    console.log(
      `  ${style.padEnd(12)} ${String(row.total).padStart(3)} names: whole ${(row.whole / row.total).toFixed(2)}, at least part ${(row.part / row.total).toFixed(2)}`,
    );
  }
  const recall = sum('whole') / sum('total');
  console.log(
    `  all          ${sum('total')} names: whole ${recall.toFixed(2)}, at least part ${(sum('part') / sum('total')).toFixed(2)}`,
  );
  console.log(`  clean sentences wrongly naming a person: ${wrong} of ${fixtures.clean.length}`);
  times.sort((a, b) => a - b);
  console.log(
    `  time per sentence: p50 ${Math.round(times[Math.floor(times.length / 2)])} ms, p95 ${Math.round(times[Math.floor(times.length * 0.95)])} ms`,
  );
  for (const text of missed.slice(0, 14))
    console.log(`  not whole: ${text.replaceAll('\n', ' / ')}`);

  // A long conversation: it must finish, find names as well as short text does, and take
  // little time on the next turn, which sends all of it again with one more message.
  const paragraphs = fixtures.cases.filter((c) => c.style === 'paragraph');
  let long = '';
  const expected = [];
  while (long.length < 100_000) {
    const c = paragraphs[expected.length % paragraphs.length];
    expected.push(...c.entities.map((e) => e.value));
    // Numbered, so no line repeats and the first pass can't lean on the cache.
    long += `Madde ${expected.length}: ${c.text}\n`;
  }
  let started = performance.now();
  const longSpans = await client.detect(long);
  const firstMs = Math.round(performance.now() - started);
  const remaining = new Map();
  for (const s of longSpans) remaining.set(s.value, (remaining.get(s.value) ?? 0) + 1);
  let foundInLong = 0;
  for (const value of expected) {
    if ((remaining.get(value) ?? 0) > 0) {
      foundInLong += 1;
      remaining.set(value, remaining.get(value) - 1);
    }
  }
  const longRecall = foundInLong / expected.length;
  started = performance.now();
  await client.detect(`${long}Son olarak Ayşe Yılmaz ile konuştum.`);
  const nextMs = Math.round(performance.now() - started);
  console.log(
    `  ${long.length} characters: first ${firstMs} ms, whole ${longRecall.toFixed(2)}; next turn ${nextMs} ms`,
  );
  if (longRecall < FLOOR || nextMs > 2000) {
    console.error('Long text fell short: recall below the floor, or the next turn was slow.');
    failed = true;
  }
  if (wrong / fixtures.clean.length > CLEAN_CEILING) {
    console.error(`More than ${CLEAN_CEILING} of the clean sentences named a person.`);
    failed = true;
  }

  if (recall < FLOOR) {
    console.error(`Whole-name recall ${recall.toFixed(3)} is below the ${FLOOR} floor.`);
    failed = true;
  } else {
    console.log(`Whole-name recall ${recall.toFixed(3)} meets the ${FLOOR} floor.`);
  }
} finally {
  execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
}
if (failed) process.exitCode = 1;
