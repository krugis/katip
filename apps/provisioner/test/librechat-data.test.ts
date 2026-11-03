// SPDX-License-Identifier: AGPL-3.0-only
import { ObjectId, type Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { findLibreChatFiles } from '../src/librechat-data.js';

const ID = 'a'.repeat(24);

describe('findLibreChatFiles', () => {
  it('finds the files under either form of their id, in the files collection', async () => {
    const seen: unknown[] = [];
    const db = {
      collection: (name: string) => {
        seen.push(name);
        return {
          find: (filter: unknown) => {
            seen.push(filter);
            return { toArray: async () => [{ file_id: 'f-1' }, { file_id: 'f-2' }, {}] };
          },
        };
      },
    } as unknown as Db;
    expect(await findLibreChatFiles(db, ID)).toEqual(['f-1', 'f-2']);
    expect(seen).toEqual(['files', { user: { $in: [new ObjectId(ID), ID] } }]);
  });
});
