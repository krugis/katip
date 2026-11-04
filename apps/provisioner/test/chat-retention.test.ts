// SPDX-License-Identifier: AGPL-3.0-only
// Chat retention on real Mongo, with LibreChat's documents as version 0.8.7 writes them, and
// real Postgres as the role it really connects with. The search index and the files on disk
// need the live stack.
import { randomUUID } from 'node:crypto';
import { migrateWithClient, seed } from '@katip/db';
import * as schema from '@katip/db';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import postgres from 'postgres';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chatRetentionDue,
  finishExpiredChats,
  retentionCutoff,
  selectExpiredChats,
  type ChatRetentionDeps,
} from '../src/chat-retention.js';
import { CHAT_BATCH, deleteExpiredChats, findExpiredChats } from '../src/librechat-data.js';
import { DbProvisionerStore } from '../src/store.js';

const NOW = new Date('2026-11-03T12:00:00Z');
const CUTOFF = retentionCutoff(NOW, 12);
const OLD = new Date('2025-01-15T00:00:00Z');
const RECENT = new Date('2026-10-01T00:00:00Z');
const USER = new ObjectId();
const OTHER_USER = new ObjectId();

let mongoContainer: StartedTestContainer;
let pgContainer: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let mongo: MongoClient;
let db: Db;
let admin: postgres.Sql;
let provider: postgres.Sql;
let store: DbProvisionerStore;

/** A chat with one message, and what LibreChat writes alongside them. */
async function chat(
  conversationId: string,
  {
    updatedAt = OLD,
    messageAt = updatedAt ?? OLD,
    user = USER.toHexString(),
    extra = {},
    messageExtra = {},
    into = db,
  }: {
    updatedAt?: Date | null;
    messageAt?: Date;
    user?: string;
    extra?: Record<string, unknown>;
    messageExtra?: Record<string, unknown>;
    into?: Db;
  } = {},
) {
  await into.collection('conversations').insertOne({
    conversationId,
    user,
    title: 'Ayşe Yılmaz maaş görüşmesi',
    createdAt: OLD,
    ...(updatedAt ? { updatedAt } : {}),
    ...extra,
  });
  await into.collection('messages').insertOne({
    messageId: `m-${conversationId}`,
    conversationId,
    user,
    text: 'TC 12345678901',
    createdAt: messageAt,
    updatedAt: messageAt,
    ...messageExtra,
  });
  await into.collection('toolcalls').insertOne({
    conversationId,
    messageId: `m-${conversationId}`,
    toolId: 't',
    user: new ObjectId(user),
  });
  await into.collection('sharedlinks').insertOne({ conversationId, user, shareId: 's' });
  await into
    .collection('transactions')
    .insertOne({ conversationId, user: new ObjectId(user), tokenType: 'prompt' });
}

const file = (fileId: string, change: Record<string, unknown> = {}) =>
  db.collection('files').insertOne({
    file_id: fileId,
    user: USER,
    filename: 'bordro.pdf',
    filepath: `/uploads/${USER.toHexString()}/${fileId}__bordro.pdf`,
    context: 'message_attachment',
    source: 'local',
    createdAt: OLD,
    updatedAt: OLD,
    ...change,
  });
const attaching = (fileId: string) => ({ files: [{ file_id: fileId }] });

const left = (collection: string, conversationId: string) =>
  db.collection(collection).countDocuments({ conversationId });

/** Everything a pass does to Mongo, without the host's part. */
async function pass(into = db, cutoff = CUTOFF) {
  const found = await findExpiredChats(into, cutoff);
  const deleted = await deleteExpiredChats(
    into,
    found.conversationIds,
    found.files.map((f) => f.fileId),
    cutoff,
  );
  return { found, deleted };
}

beforeAll(async () => {
  [mongoContainer, pgContainer] = await Promise.all([
    new GenericContainer('mongo:7.0.16')
      .withExposedPorts(27017)
      .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
      .start(),
    new PostgreSqlContainer('postgres:16.9-alpine').start(),
  ]);
  const port = mongoContainer.getMappedPort(27017);
  mongo = new MongoClient(`mongodb://${mongoContainer.getHost()}:${port}`);
  admin = postgres(pgContainer.getConnectionUri(), { max: 1, onnotice: () => {} });
  await migrateWithClient(admin);
  await seed(drizzle(admin, { schema }), { tenant: null });
  await admin.unsafe(`ALTER ROLE katip_provider PASSWORD 'provider-test-password'`);
  const url = new URL(pgContainer.getConnectionUri());
  url.username = 'katip_provider';
  url.password = 'provider-test-password';
  store = new DbProvisionerStore(url.toString());
  provider = postgres(url.toString(), { max: 1, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  await store?.close();
  await provider?.end();
  await admin?.end();
  await mongo?.close();
  await Promise.all([mongoContainer?.stop(), pgContainer?.stop()]);
});

beforeEach(async () => {
  db = mongo.db(`lc_${randomUUID().slice(0, 8)}`);
});

describe('the cutoff', () => {
  it('goes back calendar months in UTC', () => {
    expect(retentionCutoff(NOW, 12).toISOString()).toBe('2025-11-03T12:00:00.000Z');
    expect(retentionCutoff(NOW, 1).toISOString()).toBe('2026-10-03T12:00:00.000Z');
    expect(retentionCutoff(NOW, 120).toISOString()).toBe('2016-11-03T12:00:00.000Z');
  });

  it("lands on a shorter month's last day, rather than running into the next", () => {
    const end = new Date('2026-03-31T08:00:00Z');
    expect(retentionCutoff(end, 1).toISOString()).toBe('2026-02-28T08:00:00.000Z');
    expect(retentionCutoff(new Date('2028-03-31T08:00:00Z'), 1).getUTCDate()).toBe(29);
    expect(retentionCutoff(new Date('2026-01-15T00:00:00Z'), 1).toISOString()).toBe(
      '2025-12-15T00:00:00.000Z',
    );
  });

  it('refuses a period that would delete the wrong chats', () => {
    for (const months of [0, -1, 1.5, Number.NaN]) {
      expect(() => retentionCutoff(NOW, months)).toThrow('invalid retention period');
    }
  });
});

describe('what counts as old', () => {
  it('takes an old chat with everything belonging to it, and keeps a recent one', async () => {
    await chat('old');
    await chat('recent', { updatedAt: RECENT });

    const { found, deleted } = await pass();

    expect(found.conversationIds).toEqual(['old']);
    expect(found.messageIds).toEqual(['m-old']);
    expect(deleted).toEqual({ conversations: 1, messages: 1, files: 0 });
    for (const collection of [
      'conversations',
      'messages',
      'toolcalls',
      'sharedlinks',
      'transactions',
    ]) {
      expect(await left(collection, 'old')).toBe(0);
      expect(await left(collection, 'recent')).toBe(1);
    }
  });

  it('keeps an old conversation with a recent message, however it came to be', async () => {
    await chat('revived', { updatedAt: OLD, messageAt: RECENT });
    const { found, deleted } = await pass();
    expect(found.conversationIds).toEqual([]);
    expect(deleted.conversations).toBe(0);
    expect(await left('messages', 'revived')).toBe(1);
  });

  it('keeps a chat exactly at the cutoff, and takes one just past it', async () => {
    await chat('at', { updatedAt: CUTOFF });
    await chat('past', { updatedAt: new Date(CUTOFF.getTime() - 1) });
    expect((await findExpiredChats(db, CUTOFF)).conversationIds).toEqual(['past']);
  });

  it("leaves a conversation that doesn't say when it was last used", async () => {
    await chat('undated', { updatedAt: null });
    expect((await findExpiredChats(db, CUTOFF)).conversationIds).toEqual([]);
  });

  it('takes a pinned, archived or bookmarked chat like any other', async () => {
    await chat('kept-by-hand', { extra: { pinned: true, isArchived: true, tags: ['önemli'] } });
    expect((await findExpiredChats(db, CUTOFF)).conversationIds).toEqual(['kept-by-hand']);
  });

  it('keeps a conversation id another person is still using', async () => {
    await chat('same-id');
    await db.collection('conversations').insertOne({
      conversationId: 'same-id',
      user: OTHER_USER.toHexString(),
      createdAt: OLD,
      updatedAt: RECENT,
    });
    expect((await findExpiredChats(db, CUTOFF)).conversationIds).toEqual([]);
  });

  it("doesn't touch another company's database", async () => {
    const other = mongo.db(`lc_${randomUUID().slice(0, 8)}`);
    await chat('mine');
    await chat('theirs', { into: other });
    await pass();
    expect(await left('conversations', 'mine')).toBe(0);
    expect(await other.collection('conversations').countDocuments({})).toBe(1);
    expect(await other.collection('messages').countDocuments({})).toBe(1);
  });
});

describe('repeating it', () => {
  it('finds nothing the second time, and changes nothing', async () => {
    await chat('old');
    await chat('recent', { updatedAt: RECENT });
    await pass();
    const { found, deleted } = await pass();
    expect(found.conversationIds).toEqual([]);
    expect(deleted).toEqual({ conversations: 0, messages: 0, files: 0 });
    expect(await left('conversations', 'recent')).toBe(1);
  });

  it('finishes a run that stopped part-way: the conversation is the last to go', async () => {
    await chat('half-done');
    await db.collection('messages').deleteMany({ conversationId: 'half-done' });
    const { found } = await pass();
    expect(found.conversationIds).toEqual(['half-done']);
    for (const collection of ['conversations', 'toolcalls', 'sharedlinks']) {
      expect(await left(collection, 'half-done')).toBe(0);
    }
  });

  it('leaves a chat that came back to life after it was selected', async () => {
    await chat('old');
    await chat('came-back');
    const found = await findExpiredChats(db, CUTOFF);
    expect(found.conversationIds).toHaveLength(2);
    await db.collection('messages').insertOne({
      messageId: 'new',
      conversationId: 'came-back',
      user: USER.toHexString(),
      createdAt: RECENT,
      updatedAt: RECENT,
    });

    const deleted = await deleteExpiredChats(db, found.conversationIds, [], CUTOFF);

    expect(deleted.conversations).toBe(1);
    expect(await left('conversations', 'came-back')).toBe(1);
    expect(await left('messages', 'came-back')).toBe(2);
  });
});

describe('a backlog', () => {
  const limits = { ...CHAT_BATCH, conversations: 2, messages: 10 };

  it('takes the oldest first, up to the limit, and says more are waiting', async () => {
    await chat('c', { updatedAt: new Date('2025-03-01T00:00:00Z') });
    await chat('a', { updatedAt: new Date('2025-01-01T00:00:00Z') });
    await chat('b', { updatedAt: new Date('2025-02-01T00:00:00Z') });
    const found = await findExpiredChats(db, CUTOFF, limits);
    expect(found.conversationIds).toEqual(['a', 'b']);
    expect(found.more).toBe(true);
  });

  it('says none are waiting when it took the last', async () => {
    await chat('a');
    expect((await findExpiredChats(db, CUTOFF, limits)).more).toBe(false);
  });

  it('stops at the message limit, but always takes at least one chat', async () => {
    await chat('big', { updatedAt: new Date('2025-01-01T00:00:00Z') });
    await chat('next', { updatedAt: new Date('2025-02-01T00:00:00Z') });
    await db.collection('messages').insertMany(
      Array.from({ length: 15 }, (_, i) => ({
        messageId: `x${i}`,
        conversationId: 'big',
        user: USER.toHexString(),
        createdAt: OLD,
        updatedAt: OLD,
      })),
    );
    const found = await findExpiredChats(db, CUTOFF, limits);
    expect(found.conversationIds).toEqual(['big']);
    expect(found.messageIds).toHaveLength(16);
    expect(found.more).toBe(true);
  });

  it("isn't held up by old chats it keeps passing over", async () => {
    for (let i = 0; i < 3; i += 1) {
      await chat(`active-${i}`, { updatedAt: new Date('2025-01-01T00:00:00Z'), messageAt: RECENT });
    }
    await chat('deletable', { updatedAt: new Date('2025-06-01T00:00:00Z') });
    const found = await findExpiredChats(db, CUTOFF, limits);
    expect(found.conversationIds).toEqual(['deletable']);
  });

  it('gives up scanning at its limit, and says more may be waiting', async () => {
    await chat('active', { messageAt: RECENT });
    const found = await findExpiredChats(db, CUTOFF, { ...limits, scan: 1 });
    expect(found.conversationIds).toEqual([]);
    expect(found.more).toBe(true);
  });
});

describe('uploaded files', () => {
  const ID = '0190d8f4-0000-7000-8000-000000000001';
  const disk = { folder: 'uploads', user: USER.toHexString() };

  it('takes one attached only to a deleted chat, and its record', async () => {
    await file(ID);
    await chat('old', { messageExtra: attaching(ID) });
    const { found, deleted } = await pass();
    expect(found.files).toEqual([{ fileId: ID, disk }]);
    expect(found.filesKept).toBe(0);
    expect(deleted.files).toBe(1);
    expect(await db.collection('files').countDocuments({})).toBe(0);
  });

  it('also finds one by its own link to the chat, or the attachments of a tool', async () => {
    const [a, b] = [ID, '0190d8f4-0000-7000-8000-000000000002'];
    await file(a, { conversationId: 'old' });
    await file(b);
    await chat('old', { messageExtra: { attachments: [{ file_id: b, messageId: 'x' }] } });
    const { found } = await pass();
    expect(found.files.map((f) => f.fileId).sort()).toEqual([a, b]);
  });

  it('says where an image is, and needs no disk for extracted text', async () => {
    const [image, text] = [ID, '0190d8f4-0000-7000-8000-000000000002'];
    await file(image, {
      filepath: `/images/${USER.toHexString()}/${image}-chart.webp?v=1`,
      context: 'image_generation',
    });
    await file(text, { source: 'text', filepath: '/tmp/gone' });
    await chat('old', { messageExtra: { files: [{ file_id: image }, { file_id: text }] } });
    const { found } = await pass();
    expect(found.files).toContainEqual({
      fileId: image,
      disk: { folder: 'images', user: USER.toHexString() },
    });
    expect(found.files).toContainEqual({ fileId: text, disk: null });
  });

  const kept = (name: string, set: () => Promise<unknown>, change = {}) =>
    it(`keeps one ${name}`, async () => {
      await file(ID, change);
      await chat('old', { messageExtra: attaching(ID) });
      await set();
      const { found, deleted } = await pass();
      expect(found.conversationIds).toEqual(['old']);
      expect(found.files).toEqual([]);
      expect(found.filesKept).toBe(1);
      expect(deleted.files).toBe(0);
      expect(await db.collection('files').countDocuments({ file_id: ID })).toBe(1);
    });
  const nothing = async () => {};

  kept('also in a chat that stays', () =>
    chat('recent', { updatedAt: RECENT, messageExtra: attaching(ID) }),
  );
  kept('listed on a conversation that stays', () =>
    chat('recent', { updatedAt: RECENT, extra: { files: [ID] } }),
  );
  kept("in another chat's shared link", () =>
    db.collection('sharedlinks').insertOne({
      conversationId: 'recent',
      shareId: 'x',
      fileSnapshots: [{ file_id: ID }],
    }),
  );
  kept("in an agent's resources", () =>
    db.collection('agents').insertOne({ id: 'a', tool_resources: { context: { file_ids: [ID] } } }),
  );
  kept("in an old version of an agent's resources", () =>
    db.collection('agents').insertOne({
      id: 'a',
      versions: [{ tool_resources: { file_search: { file_ids: [ID] } } }],
    }),
  );
  kept('in a preset', () => db.collection('presets').insertOne({ file_ids: [ID] }));
  kept('in an assistant', () => db.collection('assistants').insertOne({ file_ids: [ID] }));
  kept('used recently', nothing, { updatedAt: RECENT });
  kept('uploaded for an agent', nothing, { context: 'agents' });
  kept('with vectors somewhere else', nothing, { embedded: true });
  kept('stored somewhere else', nothing, { source: 's3' });
  kept('belonging to a chat that stays', nothing, { conversationId: 'recent' });
  kept('named without its id, as a same-named upload may share the file', nothing, {
    filepath: `/images/${USER.toHexString()}/bordro.webp`,
  });
  kept("in someone else's folder", nothing, {
    filepath: `/uploads/${OTHER_USER.toHexString()}/${ID}__bordro.pdf`,
  });
  kept('with a path that climbs out of its folder', nothing, {
    filepath: `/uploads/${USER.toHexString()}/../../${ID}__x`,
  });

  it('keeps one in the next batch only until that batch goes', async () => {
    await file(ID);
    await chat('a', {
      updatedAt: new Date('2025-01-01T00:00:00Z'),
      messageExtra: attaching(ID),
    });
    await chat('b', {
      updatedAt: new Date('2025-02-01T00:00:00Z'),
      messageExtra: { ...attaching(ID), messageId: 'm-b' },
    });
    const limits = { ...CHAT_BATCH, conversations: 1 };
    const first = await findExpiredChats(db, CUTOFF, limits);
    expect(first.files).toEqual([]);
    await deleteExpiredChats(db, first.conversationIds, [], CUTOFF);
    const second = await findExpiredChats(db, CUTOFF, limits);
    expect(second.files.map((f) => f.fileId)).toEqual([ID]);
  });

  it('caps a batch, and counts the rest as kept', async () => {
    const ids = [ID, '0190d8f4-0000-7000-8000-000000000002'];
    for (const id of ids) await file(id);
    await chat('old', { messageExtra: { files: ids.map((id) => ({ file_id: id })) } });
    const found = await findExpiredChats(db, CUTOFF, { ...CHAT_BATCH, files: 1 });
    expect(found.files).toHaveLength(1);
    expect(found.filesKept).toBe(1);
  });

  it("doesn't put a file's name in what goes through the output", async () => {
    await file(ID);
    await chat('old', { messageExtra: attaching(ID) });
    const found = JSON.stringify(await findExpiredChats(db, CUTOFF));
    expect(found).not.toContain('bordro');
    expect(found).not.toContain('Ayşe');
    expect(found).not.toContain('12345678901');
  });
});

describe('counts LibreChat keeps', () => {
  it('stays right for bookmarks and projects', async () => {
    const user = USER.toHexString();
    const project = new ObjectId();
    await db.collection('conversationtags').insertOne({ user, tag: 'önemli', count: 2 });
    await db.collection('chatprojects').insertOne({
      _id: project,
      user,
      conversationCount: 2,
      lastConversationId: 'old',
      lastConversationAt: OLD,
    });
    const extra = { tags: ['önemli'], chatProjectId: project.toHexString() };
    await chat('old', { extra });
    await chat('recent', { updatedAt: RECENT, extra });

    await pass();

    const tag = await db.collection('conversationtags').findOne({ user, tag: 'önemli' });
    expect(tag?.['count']).toBe(1);
    const stats = await db.collection('chatprojects').findOne({ _id: project });
    expect(stats).toMatchObject({
      conversationCount: 1,
      lastConversationId: 'recent',
      lastConversationAt: RECENT,
    });
  });
});

describe('each company', () => {
  let serial = 0;
  /** Already past its first notice, unless it's told otherwise. */
  async function company(status = 'active', months?: number, enforced = true) {
    serial += 1;
    const slug = `chats-${serial}`;
    const [tenant] = await admin`insert into tenants (slug, name, status)
      values (${slug}, ${slug}, ${status}) returning id`;
    const tenantId = tenant!['id'] as string;
    if (months) {
      await admin`insert into tenant_policies (tenant_id, policy, chat_retention_months)
        values (${tenantId}, '{}'::jsonb, ${months})`;
    }
    if (enforced) {
      await admin`insert into chat_retention_state (tenant_id, in_force_months)
        values (${tenantId}, ${months ?? 12})`;
    }
    return { slug, tenantId };
  }
  const deps = (now = NOW): ChatRetentionDeps => ({
    store,
    now: () => now,
    findExpiredChats: (database, cutoff) => findExpiredChats(mongo.db(database), cutoff),
    deleteExpiredChats: (database, ids, files, cutoff) =>
      deleteExpiredChats(mongo.db(database), ids, files, cutoff),
  });

  it('runs with its own period, and 12 months if it never set one', async () => {
    const short = await company('active', 1);
    const unset = await company();
    const [atOneMonth, atDefault] = [new Date('2026-08-01T00:00:00Z'), OLD];
    const [shortDb, unsetDb] = [mongo.db(`lc_${short.slug}`), mongo.db(`lc_${unset.slug}`)];
    await chat('two-months', { updatedAt: atOneMonth, into: shortDb });
    await chat('two-months', { updatedAt: atOneMonth, into: unsetDb });
    await chat('two-years', { updatedAt: atDefault, into: unsetDb });

    const fromShort = await selectExpiredChats(deps(), short.slug);
    const fromUnset = await selectExpiredChats(deps(), unset.slug);

    expect(fromShort.conversationIds).toEqual(['two-months']);
    expect(fromUnset.conversationIds).toEqual(['two-years']);
  });

  it('lists only companies that are running', async () => {
    const running = await company();
    const suspended = await company('suspended');
    const deleted = await company('deleted');
    const { slugs: due } = await chatRetentionDue(deps());
    expect(due).toContain(running.slug);
    expect(due).not.toContain(suspended.slug);
    expect(due).not.toContain(deleted.slug);
    await expect(selectExpiredChats(deps(), suspended.slug)).rejects.toThrow(/not a running/);
    await expect(
      finishExpiredChats(deps(), suspended.slug, {
        conversationIds: ['x'],
        fileIds: [],
        filesKept: 0,
      }),
    ).rejects.toThrow(/not a running/);
  });

  it('audits counts, and nothing of what was in the chats', async () => {
    const c = await company('active', 6);
    db = mongo.db(`lc_${c.slug}`);
    await chat('old');
    const batch = await selectExpiredChats(deps(), c.slug);

    const deleted = await finishExpiredChats(deps(), c.slug, {
      conversationIds: batch.conversationIds,
      fileIds: [],
      filesKept: 3,
    });

    expect(deleted).toEqual({ conversations: 1, messages: 1, files: 0 });
    const entries = await admin`select action, actor_type, target_id, details from audit_log
      where tenant_id = ${c.tenantId}`;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'chat.retention',
      actor_type: 'system',
      target_id: c.slug,
    });
    expect(entries[0]!['details']).toEqual({
      conversations: 1,
      messages: 1,
      files: 0,
      filesKept: 3,
      months: 6,
    });
  });

  it('audits nothing when nothing went', async () => {
    const c = await company();
    await finishExpiredChats(deps(), c.slug, { conversationIds: [], fileIds: [], filesKept: 0 });
    const entries = await admin`select id from audit_log where tenant_id = ${c.tenantId}`;
    expect(entries).toHaveLength(0);
  });

  it('re-reads the period at the end, so a longer one set meanwhile still counts', async () => {
    const c = await company('active', 1);
    db = mongo.db(`lc_${c.slug}`);
    await chat('two-months', { updatedAt: new Date('2026-08-01T00:00:00Z') });
    const batch = await selectExpiredChats(deps(), c.slug);
    expect(batch.conversationIds).toEqual(['two-months']);
    await admin`update tenant_policies set chat_retention_months = 12
      where tenant_id = ${c.tenantId}`;

    await finishExpiredChats(deps(), c.slug, {
      conversationIds: batch.conversationIds,
      fileIds: [],
      filesKept: 0,
    });

    expect(await left('conversations', 'two-months')).toBe(1);
  });

  const DAY = 86_400_000;
  const after = (days: number) => new Date(NOW.getTime() + days * DAY);
  const row = async (tenantId: string) => {
    const [found] = await admin`select * from chat_retention_state where tenant_id = ${tenantId}`;
    return found;
  };
  /** What console-api does when everyone has been told. */
  const told = (tenantId: string, at: Date) =>
    admin`update chat_retention_state set notified_at = ${at.toISOString()}::timestamptz
      where tenant_id = ${tenantId}`;
  const actions = async (tenantId: string) =>
    (await admin`select action from audit_log where tenant_id = ${tenantId} order by ts`).map(
      (e) => e['action'],
    );

  describe('before its first notice has run its 30 days', () => {
    it('asks for a notice about its own period, and deletes nothing', async () => {
      const c = await company('active', 6, false);
      db = mongo.db(`lc_${c.slug}`);
      await chat('old');

      const plan = await chatRetentionDue(deps());

      expect(plan.slugs).not.toContain(c.slug);
      expect(await row(c.tenantId)).toMatchObject({
        in_force_months: null,
        notice_months: 6,
        notified_at: null,
      });
      expect(await actions(c.tenantId)).toEqual(['chat_retention.notice_requested']);
      await expect(selectExpiredChats(deps(), c.slug)).rejects.toThrow(/notice period/);
      await expect(
        finishExpiredChats(deps(), c.slug, { conversationIds: ['old'], fileIds: [], filesKept: 0 }),
      ).rejects.toThrow(/notice period/);
      expect(await left('conversations', 'old')).toBe(1);
    });

    it('works for a company with no policy row, on the default period', async () => {
      const c = await company('active', undefined, false);
      await chatRetentionDue(deps());
      expect(await row(c.tenantId)).toMatchObject({ notice_months: 12 });
    });

    it('asks once, however often it runs', async () => {
      const c = await company('active', undefined, false);
      await chatRetentionDue(deps());
      const first = await row(c.tenantId);
      await chatRetentionDue(deps(after(1)));
      expect((await row(c.tenantId))?.['notice_id']).toBe(first?.['notice_id']);
      expect(await actions(c.tenantId)).toEqual(['chat_retention.notice_requested']);
    });

    it('calls an unsent notice a failure only once something should have sent it', async () => {
      const c = await company('active', undefined, false);
      expect((await chatRetentionDue(deps())).unsent).not.toContain(c.slug);
      expect((await chatRetentionDue(deps(new Date(NOW.getTime() + 60_000)))).unsent).not.toContain(
        c.slug,
      );
      const hours = await chatRetentionDue(deps(new Date(NOW.getTime() + 3_600_000)));
      expect(hours.unsent).toContain(c.slug);
    });

    it('with no mail ever going out, keeps waiting and keeps saying so, and deletes nothing', async () => {
      const c = await company('active', 1, false);
      db = mongo.db(`lc_${c.slug}`);
      await chat('old');
      await chatRetentionDue(deps());
      const plan = await chatRetentionDue(deps(after(400)));
      expect(plan.slugs).not.toContain(c.slug);
      expect(plan.unsent).toContain(c.slug);
      await expect(selectExpiredChats(deps(after(400)), c.slug)).rejects.toThrow(/notice period/);
    });

    it('counts 30 days from the send, and then starts, once, and audits it', async () => {
      const c = await company('active', 12, false);
      db = mongo.db(`lc_${c.slug}`);
      await chat('old');
      await chatRetentionDue(deps());
      await told(c.tenantId, after(2));

      const waiting = await chatRetentionDue(deps(after(31)));
      expect(waiting.slugs).not.toContain(c.slug);
      expect(waiting.unsent).not.toContain(c.slug);
      await expect(selectExpiredChats(deps(after(31)), c.slug)).rejects.toThrow(/notice period/);

      const started = await chatRetentionDue(deps(after(32)));
      expect(started.slugs).toContain(c.slug);
      expect(await row(c.tenantId)).toMatchObject({
        in_force_months: 12,
        notice_id: null,
        notified_at: null,
      });
      expect((await selectExpiredChats(deps(after(32)), c.slug)).conversationIds).toEqual(['old']);
      await chatRetentionDue(deps(after(33)));
      const entries = await actions(c.tenantId);
      expect(entries.filter((a) => a === 'chat_retention.started')).toHaveLength(1);
    });
  });

  describe('with a shorter period waiting', () => {
    const SEVEN_MONTHS = new Date('2026-04-01T00:00:00Z');
    const shortened = async () => {
      const c = await company('active', 12);
      db = mongo.db(`lc_${c.slug}`);
      await chat('two-years');
      await chat('seven-months', { updatedAt: SEVEN_MONTHS });
      await admin`update tenant_policies set chat_retention_months = 6 where tenant_id = ${c.tenantId}`;
      await admin`update chat_retention_state set notice_id = ${randomUUID()}, notice_months = 6,
        notice_requested_at = ${NOW.toISOString()}::timestamptz where tenant_id = ${c.tenantId}`;
      return c;
    };

    it('goes on deleting under the old period, and leaves the chats between the two', async () => {
      const c = await shortened();
      await told(c.tenantId, NOW);
      expect((await chatRetentionDue(deps(after(29)))).slugs).toContain(c.slug);
      const batch = await selectExpiredChats(deps(after(29)), c.slug);
      expect(batch.conversationIds).toEqual(['two-years']);
    });

    it('takes them when the 30 days are over', async () => {
      const c = await shortened();
      await told(c.tenantId, NOW);
      await chatRetentionDue(deps(after(30)));
      const batch = await selectExpiredChats(deps(after(30)), c.slug);
      expect(batch.conversationIds).toEqual(['two-years', 'seven-months']);
      expect(await row(c.tenantId)).toMatchObject({ in_force_months: 6, notice_id: null });
    });

    it('leaves them while the notice has not gone, and fails', async () => {
      const c = await shortened();
      const plan = await chatRetentionDue(deps(after(100)));
      expect(plan.slugs).toContain(c.slug);
      expect(plan.unsent).toContain(c.slug);
      const batch = await selectExpiredChats(deps(after(100)), c.slug);
      expect(batch.conversationIds).not.toContain('seven-months');
    });

    it('asks for a notice if someone shortened it by hand, and applies nothing yet', async () => {
      const c = await company('active', 12);
      await admin`update tenant_policies set chat_retention_months = 1 where tenant_id = ${c.tenantId}`;
      await chatRetentionDue(deps());
      expect(await row(c.tenantId)).toMatchObject({ in_force_months: 12, notice_months: 1 });
    });

    it('counts who is waiting and who has been told', async () => {
      const [a, b] = [await shortened(), await shortened()];
      await told(a.tenantId, NOW);
      const plan = await chatRetentionDue(deps());
      const companies = await admin`select count(*)::int as n from chat_retention_state
        where notice_id is not null`;
      const notified = await admin`select count(*)::int as n from chat_retention_state
        where notified_at is not null`;
      expect(plan.waiting).toBe(companies[0]!['n']);
      expect(plan.notified).toBe(notified[0]!['n']);
      expect(plan.unsent).not.toContain(b.slug);
    });
  });
});

describe('the database', () => {
  it('lets the daily role read the period, and nothing else of the policy', async () => {
    await expect(provider`select policy from tenant_policies`).rejects.toThrow(/permission denied/);
    await expect(provider`update tenant_policies set chat_retention_months = 1`).rejects.toThrow(
      /permission denied/,
    );
    const rows = await provider`select chat_retention_months from tenant_policies limit 1`;
    expect(Array.isArray(rows)).toBe(true);
  });

  it("gives the daily role nothing of who was told, and no way to delete a company's state", async () => {
    await expect(provider`select * from chat_retention_notice_recipients`).rejects.toThrow(
      /permission denied/,
    );
    await expect(provider`delete from chat_retention_state`).rejects.toThrow(/permission denied/);
    await expect(provider`update chat_retention_state set tenant_id = null`).rejects.toThrow(
      /permission denied/,
    );
  });

  it('refuses a notice that is half there', async () => {
    const [tenant] = await admin`insert into tenants (slug, name)
      values ('chat-half', 'H') returning id`;
    await expect(admin`insert into chat_retention_state (tenant_id, notice_months)
      values (${tenant!['id'] as string}, 6)`).rejects.toThrow(/check constraint/);
    await expect(admin`insert into chat_retention_state (tenant_id, notified_at)
      values (${tenant!['id'] as string}, now())`).rejects.toThrow(/check constraint/);
    await expect(admin`insert into chat_retention_state (tenant_id, in_force_months)
      values (${tenant!['id'] as string}, 0)`).rejects.toThrow(/check constraint/);
  });

  it('refuses a period out of range, whoever writes it', async () => {
    const [tenant] = await admin`insert into tenants (slug, name)
      values ('chat-range', 'R') returning id`;
    const tenantId = tenant!['id'] as string;
    for (const months of [0, -1, 121]) {
      await expect(admin`insert into tenant_policies (tenant_id, policy, chat_retention_months)
        values (${tenantId}, '{}'::jsonb, ${months})`).rejects.toThrow(/check constraint/);
    }
  });
});
