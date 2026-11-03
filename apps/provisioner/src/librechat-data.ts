// SPDX-License-Identifier: AGPL-3.0-only
// One person's data in a company's LibreChat database. Fields rather than a list of
// collections, so one added by a LibreChat upgrade is covered if it follows the same names.
// `pnpm test:console` then scans every collection for anything left.
import { ObjectId, type Db } from 'mongodb';

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
