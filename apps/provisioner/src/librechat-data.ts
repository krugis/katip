// SPDX-License-Identifier: AGPL-3.0-only
// One person's data in a company's LibreChat database. Fields rather than a list of
// collections, so one added by a LibreChat upgrade is covered if it follows the same names.
// `pnpm test:console` then scans every collection for anything left.
import { ObjectId, type Db, type Document, type Filter } from 'mongodb';

/** A document with one of these pointing at the person is theirs. */
const OWNER_FIELDS = ['user', 'userId', 'author', 'owner', 'principalId'];
/** These record that they touched something of someone else's, which stays without the link. */
const LINK_FIELDS = ['grantedBy', 'createdBy', 'updatedBy', 'lastUpdatedBy'];

export async function findLibreChatUser(
  db: Db,
  email: string,
  keycloakId: string,
): Promise<string | null> {
  const user = await db
    .collection('users')
    .findOne({ $or: [{ openidId: keycloakId }, { email: email.toLowerCase() }, { email }] });
  return user ? user._id.toHexString() : null;
}

export async function forgetLibreChatUser(db: Db, lcUserId: string, email: string): Promise<void> {
  const oid = new ObjectId(lcUserId);
  const ids = [oid, lcUserId];
  const emails = [email, email.toLowerCase()];
  const collections = await db.listCollections({ type: 'collection' }).toArray();
  for (const { name } of collections) {
    if (name === 'users' || name.startsWith('system.')) continue;
    const collection = db.collection(name);
    await collection.deleteMany({
      $or: [
        ...OWNER_FIELDS.map((field) => ({ [field]: { $in: ids } })),
        { email: { $in: emails } },
      ],
    });
    for (const field of LINK_FIELDS) {
      await collection.updateMany({ [field]: { $in: ids } }, { $unset: { [field]: '' } });
    }
    await collection.updateMany({ memberIds: { $in: ids } }, {
      $pull: { memberIds: { $in: ids } },
    } as never);
  }
  await db.collection('users').deleteOne({ _id: oid });
}

/** What one pass may take, so a huge backlog goes over many passes and days. */
export const CHAT_BATCH = { conversations: 200, messages: 20_000, files: 2_000, scan: 20_000 };
const SCAN_PAGE = 500;

/** Files made for one chat. Anything else, such as an agent's, was put there to outlive it. */
const CHAT_FILE_CONTEXTS = ['message_attachment', 'image_generation', 'execute_code'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_FILE = /^\/(uploads|images)\/([0-9a-f]{24})\/([^/]+)$/;

export interface ExpiredFile {
  fileId: string;
  /** Where the host finds it: `<folder>/<user>/<fileId>*`. None if it's only in the database. */
  disk: { folder: 'uploads' | 'images'; user: string } | null;
}

export interface ExpiredChats {
  conversationIds: string[];
  messageIds: string[];
  files: ExpiredFile[];
  /** Attached to these chats and not safe to delete with them. */
  filesKept: number;
  /** There may be more than this pass took. */
  more: boolean;
}

export interface DeletedChats {
  conversations: number;
  messages: number;
  files: number;
}

/**
 * Of these conversations, the ones with activity since the cutoff. A title change or a new
 * message moves `updatedAt`, but a message is the real evidence, so it's checked as well.
 * A date that's missing or not a date never matches `$lt`, so that chat is left alone.
 */
async function stillActive(db: Db, ids: string[], cutoff: Date): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const recent = { $or: [{ updatedAt: { $gte: cutoff } }, { createdAt: { $gte: cutoff } }] };
  const query = { conversationId: { $in: ids }, ...recent };
  const [conversations, messages] = await Promise.all([
    db.collection('conversations').distinct('conversationId', query),
    db.collection('messages').distinct('conversationId', query),
  ]);
  return new Set([...conversations, ...messages] as string[]);
}

/** The oldest conversations past the cutoff with nothing recent in them, up to the limits. */
async function pickConversations(db: Db, cutoff: Date, limits: typeof CHAT_BATCH) {
  const picked: string[] = [];
  const seen = new Set<string>();
  let messages = 0;
  for (let scanned = 0; scanned < limits.scan;) {
    const page = await db
      .collection('conversations')
      .find({ updatedAt: { $lt: cutoff } }, { projection: { conversationId: 1 } })
      .sort({ updatedAt: 1, _id: 1 })
      .skip(scanned)
      .limit(SCAN_PAGE)
      .toArray();
    if (page.length === 0) return { picked, more: false };
    scanned += page.length;
    const ids = page
      .map((c) => c['conversationId'] as unknown)
      .filter((id): id is string => typeof id === 'string' && !seen.has(id));
    ids.forEach((id) => seen.add(id));
    const active = await stillActive(db, ids, cutoff);
    const counts = await db
      .collection('messages')
      .aggregate<{ _id: string; n: number }>([
        { $match: { conversationId: { $in: ids } } },
        { $group: { _id: '$conversationId', n: { $sum: 1 } } },
      ])
      .toArray();
    const sizes = new Map(counts.map((c) => [c._id, c.n]));
    for (const id of ids) {
      if (active.has(id)) continue;
      const size = sizes.get(id) ?? 0;
      const full = picked.length > 0 && messages + size > limits.messages;
      if (full || picked.length >= limits.conversations) return { picked, more: true };
      picked.push(id);
      messages += size;
    }
  }
  return { picked, more: true };
}

const fileIdsIn = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.flatMap((f: unknown) => {
        const id = typeof f === 'string' ? f : (f as { file_id?: unknown } | null)?.file_id;
        return typeof id === 'string' ? [id] : [];
      })
    : [];

/** Of these files, the ones something outside these conversations still points at. */
async function usedElsewhere(db: Db, fileIds: string[], ids: string[]): Promise<Set<string>> {
  const used = new Set<string>();
  if (fileIds.length === 0) return used;
  const outside = { conversationId: { $nin: ids } };
  const anyOf = { $in: fileIds };
  const places: [string, Filter<Document>, Document][] = [
    [
      'messages',
      { ...outside, $or: [{ 'files.file_id': anyOf }, { 'attachments.file_id': anyOf }] },
      { 'files.file_id': 1, 'attachments.file_id': 1 },
    ],
    [
      'conversations',
      { ...outside, $or: [{ files: anyOf }, { file_ids: anyOf }] },
      { files: 1, file_ids: 1 },
    ],
    ['sharedlinks', { ...outside, 'fileSnapshots.file_id': anyOf }, { 'fileSnapshots.file_id': 1 }],
    ['presets', { file_ids: anyOf }, { file_ids: 1 }],
    ['assistants', { file_ids: anyOf }, { file_ids: 1 }],
    // Free-form, and past versions can be restored, so these are searched as text.
    ['agents', {}, { tool_resources: 1, 'versions.tool_resources': 1 }],
  ];
  for (const [collection, query, projection] of places) {
    for await (const doc of db.collection(collection).find(query, { projection })) {
      const text = JSON.stringify(doc);
      for (const id of fileIds) if (text.includes(id)) used.add(id);
    }
  }
  return used;
}

/** How to remove it, or null if it isn't safe to. */
function removableFile(
  file: Document,
  ids: Set<string>,
  cutoff: Date,
  used: Set<string>,
): ExpiredFile | null {
  const fileId = file['file_id'] as string;
  const conversationId = file['conversationId'] as string | undefined;
  const fresh = !(file['updatedAt'] instanceof Date) || file['updatedAt'] >= cutoff;
  if (
    fresh ||
    used.has(fileId) ||
    !UUID.test(fileId) ||
    file['embedded'] === true ||
    !CHAT_FILE_CONTEXTS.includes(file['context'] as string) ||
    (conversationId && !ids.has(conversationId))
  ) {
    return null;
  }
  // Its text is kept on the document. The upload it came from isn't kept.
  if (file['source'] === 'text') return { fileId, disk: null };
  if (file['source'] !== 'local') return null;
  const [path] = String(file['filepath']).split('?');
  const match = LOCAL_FILE.exec(path ?? '');
  // A name that doesn't start with the id can be shared with another upload of that name.
  if (!match || match[2] !== String(file['user']) || !match[3]!.startsWith(fileId)) return null;
  return { fileId, disk: { folder: match[1] as 'uploads' | 'images', user: match[2]! } };
}

/** What the next pass would delete. Reads only, so it can be repeated freely. */
export async function findExpiredChats(
  db: Db,
  cutoff: Date,
  limits: typeof CHAT_BATCH = CHAT_BATCH,
): Promise<ExpiredChats> {
  const { picked, more } = await pickConversations(db, cutoff, limits);
  if (picked.length === 0) {
    return { conversationIds: [], messageIds: [], files: [], filesKept: 0, more };
  }
  const inPicked = { conversationId: { $in: picked } };
  const messageIds: string[] = [];
  const attached = new Set<string>();
  const messages = db
    .collection('messages')
    .find(inPicked, { projection: { messageId: 1, 'files.file_id': 1, 'attachments.file_id': 1 } });
  for await (const m of messages) {
    if (typeof m['messageId'] === 'string') messageIds.push(m['messageId']);
    for (const id of [...fileIdsIn(m['files']), ...fileIdsIn(m['attachments'])]) attached.add(id);
  }
  const conversations = db
    .collection('conversations')
    .find(inPicked, { projection: { files: 1, file_ids: 1 } });
  for await (const c of conversations) {
    for (const id of [...fileIdsIn(c['files']), ...fileIdsIn(c['file_ids'])]) attached.add(id);
  }
  const documents = await db
    .collection('files')
    .find({ $or: [{ file_id: { $in: [...attached] } }, inPicked] })
    .project({
      file_id: 1,
      conversationId: 1,
      updatedAt: 1,
      embedded: 1,
      context: 1,
      source: 1,
      filepath: 1,
      user: 1,
    })
    .toArray();
  const used = await usedElsewhere(
    db,
    documents.map((f) => f['file_id'] as string),
    picked,
  );
  const ids = new Set(picked);
  const removable = documents.flatMap((f) => removableFile(f, ids, cutoff, used) ?? []);
  const files = removable.slice(0, limits.files);
  return {
    conversationIds: picked,
    messageIds,
    files,
    filesKept: documents.length - files.length,
    more,
  };
}

/** LibreChat keeps these counts itself, and does the same when someone deletes a chat. */
async function recountAfterDeleting(db: Db, deleted: Document[]): Promise<void> {
  const conversations = db.collection('conversations');
  const tags = new Set(
    deleted.flatMap((c) => ((c['tags'] as string[]) ?? []).map((t) => `${c['user']}\n${t}`)),
  );
  for (const key of tags) {
    const [user, tag] = key.split('\n') as [string, string];
    const count = await conversations.countDocuments({ user, tags: tag });
    await db.collection('conversationtags').updateOne({ user, tag }, { $set: { count } });
  }
  const projects = new Set(
    deleted.filter((c) => c['chatProjectId']).map((c) => `${c['user']}\n${c['chatProjectId']}`),
  );
  for (const key of projects) {
    const [user, id] = key.split('\n') as [string, string];
    if (!ObjectId.isValid(id)) continue;
    const visible = {
      user,
      chatProjectId: id,
      isArchived: { $ne: true },
      isTemporary: { $ne: true },
    };
    const [conversationCount, latest] = await Promise.all([
      conversations.countDocuments(visible),
      conversations.find(visible).sort({ updatedAt: -1, _id: -1 }).limit(1).next(),
    ]);
    await db.collection('chatprojects').updateOne(
      { _id: new ObjectId(id), user },
      {
        $set: {
          conversationCount,
          lastConversationAt: latest?.['updatedAt'] ?? latest?.['createdAt'] ?? null,
          lastConversationId: latest?.['conversationId'] ?? null,
        },
      },
    );
  }
}

/**
 * Deletes them. Fields rather than a list of collections, as in forgetLibreChatUser. Files
 * go first, as only the messages say which are attached, and the conversation last, as a run
 * that stops part-way finds it again and finishes. Checks again in case one came back to life.
 */
export async function deleteExpiredChats(
  db: Db,
  conversationIds: string[],
  fileIds: string[],
  cutoff: Date,
): Promise<DeletedChats> {
  const active = await stillActive(db, conversationIds, cutoff);
  const ids = conversationIds.filter((id) => !active.has(id));
  if (ids.length === 0) return { conversations: 0, messages: 0, files: 0 };
  const inIds = { conversationId: { $in: ids } };
  const conversations = db.collection('conversations');
  const owners = await conversations
    .find(inIds, { projection: { user: 1, tags: 1, chatProjectId: 1 } })
    .toArray();

  const files = await db.collection('files').deleteMany({ file_id: { $in: fileIds } });
  let messages = 0;
  const collections = await db.listCollections({ type: 'collection' }).toArray();
  for (const { name } of collections) {
    // A file that stays keeps its link: it's only ever a pointer, and it says nothing.
    if (['conversations', 'files'].includes(name) || name.startsWith('system.')) continue;
    const { deletedCount } = await db.collection(name).deleteMany(inIds);
    if (name === 'messages') messages = deletedCount;
  }
  const { deletedCount } = await conversations.deleteMany(inIds);
  // Only ever a count on the screen, so it isn't worth failing over, and a retry wouldn't fix it.
  await recountAfterDeleting(db, owners).catch(() => {});
  return { conversations: deletedCount, messages, files: files.deletedCount };
}
