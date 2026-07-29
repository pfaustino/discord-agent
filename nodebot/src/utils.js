import { OWNER_ID } from './config.js';

/** True if userId is the configured bot owner (OWNER_ID env var). ownerId is
 * an injectable override for testing — real call sites never pass it. */
export function isOwner(userId, ownerId = OWNER_ID) {
  return Boolean(ownerId) && String(userId) === String(ownerId);
}
