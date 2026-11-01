// SPDX-License-Identifier: AGPL-3.0-only
// Shared helpers for the Kâtip bootstrap: YAML subset parser, env file,
// state file, child-process runner with SIGINT propagation.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..', '..');
export const INFRA = join(ROOT, 'infra');
export const STATE_DIR = join(ROOT, '.katip');
export const LOG_DIR = join(STATE_DIR, 'logs');
export const STATE_FILE = join(STATE_DIR, 'setup-state.json');

export class Interrupted extends Error {
  constructor() {
    super('interrupted');
    this.name = 'Interrupted';
  }
}

/** Minimal YAML subset parser for katip.config.yaml (nested maps, lists of
 * scalars/maps, inline flow lists, comments). Not a general YAML parser. */
export function parseYaml(text) {
  const lines = text.split('\n');
  let i = 0;

  const indentOf = (l) => (l.match(/^ */) || [''])[0].length;

  /** Next content line (skips blanks/comments) or null, without consuming. */
  function content() {
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || t.startsWith('#')) {
        i++;
        continue;
      }
      return lines[i];
    }
    return null;
  }

  function scalar(s) {
    s = s.trim().replace(/^["']|["']$/g, '');
    // strip trailing " # comment" (not inside quotes — good enough for our config)
    const h = s.indexOf(' #');
    if (h !== -1) s = s.slice(0, h).trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      return s
        .slice(1, -1)
        .split(',')
        .map((x) => scalar(x))
        .filter((x) => x !== '');
    }
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
    return s;
  }

  function parseBlock() {
    const first = content();
    if (!first) return null;
    const s = first.trim();
    if (s.startsWith('- ') || s === '-') return parseList(indentOf(first));
    return parseMap(indentOf(first));
  }

  function parseMap(ind) {
    const obj = {};
    let line;
    while ((line = content())) {
      const curInd = indentOf(line);
      if (curInd < ind) break;
      if (curInd > ind) {
        i++; // stray deeper line (shouldn't happen): skip
        continue;
      }
      const s = line.trim();
      if (s.startsWith('- ') || s === '-') break; // list at same indent: caller
      const m = s.match(/^([^:#]+):(.*)$/);
      if (!m) {
        i++;
        continue;
      }
      const key = m[1].trim();
      const val = m[2].trim();
      i++;
      if (val === '') {
        const next = content();
        if (next && indentOf(next) > curInd) obj[key] = parseBlock();
        else obj[key] = null;
      } else {
        obj[key] = scalar(val);
      }
    }
    return obj;
  }

  function parseList(ind) {
    const arr = [];
    let line;
    while ((line = content())) {
      const curInd = indentOf(line);
      if (curInd !== ind) break;
      const s = line.trim();
      if (!s.startsWith('- ')) break;
      const rest = s.slice(2);
      if (rest.includes(':') && !/^["']/.test(rest)) {
        // map item: rewrite "- key: val" as "  key: val" and parse a map
        lines[i] = ' '.repeat(curInd + 2) + rest;
        arr.push(parseMap(curInd + 2));
      } else {
        arr.push(scalar(rest));
        i++;
      }
    }
    return arr;
  }

  const out = parseBlock();
  return out ?? {};
}

export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    let t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    // strip inline comment (space + #), like docker compose env files
    const h = v.indexOf(' #');
    if (h !== -1) v = v.slice(0, h).trim();
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

export const genSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');

/**
 * Ensure infra/env/katip.env exists with every key from the template.
 * Existing values are NEVER overwritten. AUTO values are filled once.
 */
export function ensureEnvFile(autoKeys, derive) {
  const templatePath = join(INFRA, 'env', 'katip.example.env');
  const envPath = join(INFRA, 'env', 'katip.env');
  const tmpl = parseEnvFile(readFileSync(templatePath, 'utf8'));
  const existing = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  const out = { ...tmpl, ...existing };
  let changed = false;
  for (const k of Object.keys(out)) {
    if (autoKeys.has(k) && (!out[k] || out[k] === 'AUTO')) {
      out[k] = genSecret(32);
      changed = true;
    }
  }
  const derived = derive(out);
  for (const [k, v] of Object.entries(derived)) {
    if (out[k] !== v && (!out[k] || out[k] === 'AUTO')) {
      out[k] = v;
      changed = true;
    }
  }
  if (changed || !existsSync(envPath)) {
    mkdirSync(dirname(envPath), { recursive: true });
    const rendered = readFileSync(templatePath, 'utf8')
      .split('\n')
      .map((l) => {
        const t = l.trim();
        if (!t || t.startsWith('#')) return l;
        const eq = t.indexOf('=');
        if (eq === -1) return l;
        const k = t.slice(0, eq).trim();
        return k in out ? `${k}=${out[k]}` : l;
      });
    writeFileSync(envPath, rendered.join('\n'), { mode: 0o600 });
    chmodSync(envPath, 0o600);
  }
  return { env: out, path: envPath, changed };
}

// ---- state ----------------------------------------------------------------

export function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    } catch {
      /* re-init below */
    }
  }
  return { version: 1, startedAt: new Date().toISOString(), steps: {} };
}

export function saveState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ---- child processes --------------------------------------------------------

let currentChild = null;
let interruptFlag = false;

export function requestInterrupt() {
  interruptFlag = true;
  markChildInterrupt();
}
export const isInterrupted = () => interruptFlag;

function markChildInterrupt() {
  if (currentChild) {
    try {
      currentChild.kill('SIGINT');
      // force-kill after 3s if it ignores SIGINT
      const p = currentChild;
      setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3000).unref();
    } catch {
      /* already gone */
    }
  }
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: false,
    });
    let out = '';
    let forwarded = false;
    const onInt = () => {
      // forward SIGINT to the child once; the second Ctrl+C force-kills
      if (!forwarded) {
        forwarded = true;
        try {
          p.kill('SIGINT');
        } catch {
          /* already gone */
        }
      } else {
        try {
          p.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    process.on('SIGINT', onInt);
    currentChild = p;
    p.stdout.on('data', (d) => {
      const t = d.toString();
      out += t;
      opts.onOutput?.(t);
    });
    p.stderr.on('data', (d) => {
      const t = d.toString();
      out += t;
      opts.onOutput?.(t);
    });
    p.on('error', (e) => {
      process.off('SIGINT', onInt);
      currentChild = null;
      rejectP(e);
    });
    p.on('close', (code) => {
      process.off('SIGINT', onInt);
      if (currentChild === p) currentChild = null;
      if (interruptFlag) rejectP(new Interrupted());
      else resolveP({ code, out });
    });
  });
}

export function markInterruptPending() {
  interruptFlag = true;
}
export function clearInterruptPending() {
  interruptFlag = false;
}

export async function tryRun(cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0)
    throw new Error(`${cmd} ${args.join(' ')} → exit ${r.code}\n${tail(r.out, 25)}`);
  return r;
}

export const tail = (s, n) => s.trim().split('\n').slice(-n).join('\n');

export function logFileFor(name) {
  mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(LOG_DIR, `${ts}-${name}.log`);
}
