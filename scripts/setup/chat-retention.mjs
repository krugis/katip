// SPDX-License-Identifier: AGPL-3.0-only
// One company's old chats going, batch by batch (tracker P1-70, LLD-07 §2c). The order is the
// point: the search index and files first, while Mongo still says what they are.

/** At 200 chats a batch, 5000 a day for each company. The rest wait for tomorrow. */
export const CHAT_BATCHES_PER_RUN = 25;
const SEARCH_CHUNK = 1000;
const FILE_CHUNK = 100;

/** What the search index accepts as an id, which also makes it safe in a shell command. */
export const searchableIds = (ids) => ids.filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id));

export const inChunks = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

export const searchChunks = (ids) => inChunks(searchableIds(ids), SEARCH_CHUNK);

const FOLDERS = { uploads: '/app/uploads', images: '/app/client/public/images' };

/**
 * Shell patterns for a batch's files, in groups short enough for one command. By id, so no
 * file's name leaves the database, and the checks stop a stored value reaching the shell.
 */
export function filePatterns(files) {
  const patterns = files
    .filter((f) => f.disk)
    .map(({ fileId, disk }) => {
      const folder = FOLDERS[disk.folder];
      if (
        !folder ||
        !/^[0-9a-f]{24}$/.test(disk.user) ||
        !/^[0-9a-f-]{36}$/i.test(fileId) ||
        fileId.includes('..')
      ) {
        throw new Error('unexpected file reference');
      }
      return `${folder}/${disk.user}/${fileId}*`;
    });
  return inChunks(patterns, FILE_CHUNK);
}

/**
 * Takes old chats from every running company. One failing doesn't stop the rest, and a re-run
 * finishes it, as nothing is left in Mongo until the search index and files have gone.
 */
export async function expireChats(io) {
  const total = { conversations: 0, messages: 0, files: 0, filesKept: 0 };
  const backlog = [];
  const failed = [];
  for (const slug of await io.due()) {
    try {
      let more = false;
      for (let i = 0; i < CHAT_BATCHES_PER_RUN; i += 1) {
        const batch = await io.select(slug);
        more = batch.more;
        if (batch.conversationIds.length === 0) break;
        await io.removeFromSearch(slug, batch);
        await io.removeFiles(slug, batch.files);
        const deleted = await io.finish(slug, batch);
        total.conversations += deleted.conversations;
        total.messages += deleted.messages;
        total.files += deleted.files;
        total.filesKept += batch.filesKept;
        // All of them came back to life between the two steps: nothing more to gain today.
        if (deleted.conversations === 0) break;
      }
      if (more) backlog.push(slug);
    } catch (e) {
      failed.push(`${slug} chats: ${e.message.trim().split('\n').at(-1)}`);
    }
  }
  return { ...total, backlog, failed };
}
