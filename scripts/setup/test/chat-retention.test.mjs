// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  CHAT_BATCHES_PER_RUN,
  expireChats,
  filePatterns,
  searchableIds,
  searchChunks,
} from '../chat-retention.mjs';

const USER = 'a'.repeat(24);
const FILE = '0190d8f4-0000-7000-8000-000000000001';
const batch = (more = false) => ({
  conversationIds: ['c1'],
  messageIds: ['m1'],
  files: [],
  filesKept: 1,
  more,
});
const empty = {
  conversationIds: [],
  messageIds: [],
  files: [],
  filesKept: 0,
  more: false,
};

/** Records the order of things, and runs out of chats after `batches`. */
function fake({
  slugs = ['acme'],
  batches = 1,
  failOn = null,
  more = false,
  waiting = 0,
  notified = 0,
  unsent = [],
} = {}) {
  const steps = [];
  const left = new Map();
  const step = (name) => async (slug) => {
    steps.push(`${name} ${slug}`);
    if (failOn === `${name} ${slug}`) throw new Error(`first line\n${name} broke`);
  };
  return {
    steps,
    due: async () => ({ slugs, waiting, notified, unsent }),
    select: async (slug) => {
      steps.push(`select ${slug}`);
      const remaining = left.get(slug) ?? batches;
      left.set(slug, remaining - 1);
      return remaining > 0 ? batch(more) : empty;
    },
    removeFromSearch: step('search'),
    removeFiles: step('files'),
    finish: async (slug) => {
      await step('finish')(slug);
      return { conversations: 1, messages: 2, files: 3 };
    },
  };
}

describe('taking old chats from each company', () => {
  it('does the search index and files first, while Mongo still says what they are', async () => {
    const io = fake();
    await expireChats(io);
    expect(io.steps).toEqual([
      'select acme',
      'search acme',
      'files acme',
      'finish acme',
      'select acme',
    ]);
  });

  it('adds up counts, with nothing else in them', async () => {
    const result = await expireChats(fake({ batches: 2 }));
    expect(result).toEqual({
      conversations: 2,
      messages: 4,
      files: 6,
      filesKept: 2,
      backlog: [],
      failed: [],
      waiting: 0,
      notified: 0,
    });
  });

  it('touches only the companies the provisioner says may go', async () => {
    const io = fake({ slugs: ['ready'] });
    await expireChats(io);
    expect(io.steps.every((s) => s.endsWith(' ready'))).toBe(true);
  });

  it('passes on the counts of companies waiting and told', async () => {
    const result = await expireChats(fake({ slugs: [], waiting: 3, notified: 2 }));
    expect(result).toMatchObject({ waiting: 3, notified: 2, conversations: 0 });
  });

  it("fails for a notice that hasn't gone out, and still does the others", async () => {
    const io = fake({ slugs: ['ready'], unsent: ['nomail'] });
    const result = await expireChats(io);
    expect(result.failed).toEqual(['nomail chats: its notice has not gone out']);
    expect(io.steps.some((s) => s.includes('nomail'))).toBe(false);
    expect(io.steps).toContain('finish ready');
  });

  it("leaves Mongo alone if the search index couldn't be cleared", async () => {
    const io = fake({ failOn: 'search acme' });
    const result = await expireChats(io);
    expect(io.steps).not.toContain('finish acme');
    expect(result.failed).toEqual(['acme chats: search broke']);
  });

  it("leaves Mongo alone if the files couldn't be removed", async () => {
    const io = fake({ failOn: 'files acme' });
    await expireChats(io);
    expect(io.steps).not.toContain('finish acme');
  });

  it("doesn't let one company stop the rest", async () => {
    const io = fake({ slugs: ['bad', 'good'], failOn: 'search bad' });
    const result = await expireChats(io);
    expect(result.failed).toEqual(['bad chats: search broke']);
    expect(io.steps).toContain('finish good');
    expect(result.conversations).toBe(1);
  });

  it('stops after its limit, and names who has more waiting', async () => {
    const io = fake({ batches: 1000, more: true });
    const result = await expireChats(io);
    expect(io.steps.filter((s) => s === 'finish acme')).toHaveLength(CHAT_BATCHES_PER_RUN);
    expect(result.backlog).toEqual(['acme']);
  });

  it("doesn't go round again if nothing could be deleted", async () => {
    const io = fake({ batches: 1000 });
    io.finish = async () => ({ conversations: 0, messages: 0, files: 0 });
    await expireChats(io);
    expect(io.steps.filter((s) => s === 'select acme')).toHaveLength(1);
  });
});

describe('ids going into a shell command', () => {
  it('passes only what the search index could hold', () => {
    const hostile = ["x'; rm -rf /; '", 'a b', '../x', '', 'x'.repeat(65), 'ş'];
    expect(searchableIds(['abc-DEF_1', ...hostile])).toEqual(['abc-DEF_1']);
  });

  it('splits long lists', () => {
    const chunks = searchChunks(Array.from({ length: 2500 }, (_, i) => `id${i}`));
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
    // A single argument can't be over 128 KiB on Linux.
    expect(JSON.stringify(chunks[0]).length).toBeLessThan(128 * 1024);
  });

  it('builds a pattern per file on disk, by id, in its own folder', () => {
    expect(
      filePatterns([
        { fileId: FILE, disk: { folder: 'uploads', user: USER } },
        { fileId: FILE, disk: { folder: 'images', user: USER } },
        { fileId: FILE, disk: null },
      ]),
    ).toEqual([[`/app/uploads/${USER}/${FILE}*`, `/app/client/public/images/${USER}/${FILE}*`]]);
  });

  it('refuses anything else, rather than let it reach the shell', () => {
    const bad = [
      { fileId: FILE, disk: { folder: 'etc', user: USER } },
      { fileId: FILE, disk: { folder: 'uploads', user: '../..' } },
      { fileId: '*', disk: { folder: 'uploads', user: USER } },
      { fileId: `$(reboot)${'a'.repeat(27)}`, disk: { folder: 'uploads', user: USER } },
    ];
    for (const file of bad) expect(() => filePatterns([file])).toThrow('unexpected file');
  });
});
