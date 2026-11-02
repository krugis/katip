// SPDX-License-Identifier: AGPL-3.0-only
// TUI renderer for the Kâtip bootstrap: overall progress bar, step list with
// states (done/running/partial/failed/pending), spinner, status line, elapsed.
import process from 'node:process';

const isTty = process.stdout.isTTY;
export const C =
  process.env.NO_COLOR || !isTty
    ? {
        reset: '',
        dim: '',
        bold: '',
        green: '',
        yellow: '',
        red: '',
        blue: '',
        cyan: '',
        grey: '',
        hide: '',
        show: '',
        clear: '',
      }
    : {
        reset: '\x1b[0m',
        dim: '\x1b[2m',
        bold: '\x1b[1m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        red: '\x1b[31m',
        blue: '\x1b[34m',
        cyan: '\x1b[36m',
        grey: '\x1b[90m',
        hide: '\x1b[?25l',
        show: '\x1b[?25h',
        clear: '\x1b[2J\x1b[H',
      };
export const ok = (s) => C.green + s + C.reset;
export const warn = (s) => C.yellow + s + C.reset;
export const err = (s) => C.red + s + C.reset;
export const dim = (s) => C.dim + s + C.reset;
export const bold = (s) => C.bold + s + C.reset;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Tui {
  constructor(steps) {
    this.steps = steps;
    this.frame = 0;
    this.timer = null;
    this.status = '';
    this.detail = '';
    this.lastLineCount = 0;
    this.t0 = Date.now();
    this.interactive = isTty;
  }

  start() {
    if (!this.interactive) return;
    process.stdout.write(C.hide);
    this.timer = setInterval(() => {
      this.frame++;
      this.render();
    }, 120);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.interactive) process.stdout.write(C.show);
    this.stopped = true;
  }

  setStatus(s) {
    this.status = s;
    if (!this.interactive) process.stdout.write(`\n→ ${s}\n`);
  }

  setDetail(s) {
    this.detail = s;
  }

  render() {
    const done = this.steps.filter((s) => s.state === 'done').length;
    const total = this.steps.length;
    const pct = Math.round((done / total) * 100);
    const w = 30;
    const filled = Math.round((done / total) * w);
    const bar = '█'.repeat(filled) + '░'.repeat(w - filled);
    const spin = SPINNER[this.frame % SPINNER.length];
    const running = this.steps.find((s) => s.state === 'running');
    const stepNo = running ? this.steps.indexOf(running) + 1 : Math.min(done + 1, total);
    const elapsed = Math.round((Date.now() - this.t0) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');

    const lines = [];
    lines.push(
      `${bold('Kâtip dev bootstrap')}   ${dim(`step ${stepNo}/${total}`)}   ${pct}% ${dim('[' + bar + ']')}   ${dim(mm + ':' + ss)}`,
    );
    lines.push(dim('─'.repeat(78)));
    for (const s of this.steps) {
      let icon;
      switch (s.state) {
        case 'done':
          icon = ok('✔');
          break;
        case 'running':
          icon = C.cyan + spin + C.reset;
          break;
        case 'partial':
          icon = warn('◐');
          break;
        case 'failed':
          icon = err('✖');
          break;
        default:
          icon = dim('○');
      }
      const label = s.state === 'running' ? bold(s.title) : s.title;
      const note = s.note ? dim('  · ' + s.note) : '';
      lines.push(`  ${icon} ${label}${note}`);
    }
    lines.push(dim('─'.repeat(78)));
    if (this.status) lines.push(`  ${dim('now')}  ${this.status}`);
    if (this.detail) lines.push(`        ${dim(this.detail)}`);
    if (running) {
      const next = this.steps[this.steps.indexOf(running) + 1];
      if (next) lines.push(`  ${dim('next')}  ${next.title}`);
    }

    if (this.interactive) {
      // move cursor up to overwrite previous frame
      if (this.lastLineCount > 0) process.stdout.write(`\x1b[${this.lastLineCount}F`);
      process.stdout.write(lines.map((l) => `\r\x1b[K${l}`).join('\n') + '\n');
      this.lastLineCount = lines.length;
    }
  }
}

/** Simple prompt for the interrupt decision (keep/rollback). */
export async function promptKeepOrRollback() {
  process.stdout.write('\n');
  process.stdout.write(bold('Interrupt received.\n'));
  process.stdout.write(
    `  ${bold('[K]')} keep current state — finished layers stay up; re-run resumes\n`,
  );
  process.stdout.write(
    `  ${bold('[R]')} rollback — stop and remove everything the bootstrap created\n`,
  );
  process.stdout.write(`  ${bold('[Q]')} quit without further action (same as keep, exits now)\n`);
  process.stdout.write('\n  choose [K/r/q]: ');
  return await readLine();
}

import { createInterface } from 'node:readline';
function readLine() {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on('line', (l) => {
      rl.close();
      res(l.trim().toLowerCase());
    });
  });
}
