import { randomUUID } from 'node:crypto';

import { record } from './activity.js';
import { insertContact, listContacts as readContacts } from './db.js';

export function listContacts(dataDir) {
  return readContacts(dataDir);
}

/** 先只记下对方的 yoyo 地址。以后用这个地址去联系对方的 yoyo。 */
export function addContact(dataDir, input, now = new Date()) {
  const name = String(input.name ?? '').trim();
  const yoyo = String(input.yoyo ?? '').trim();
  if (!name) throw new Error('联系人要有名字');
  if (!yoyo) throw new Error('联系人要有 yoyo 地址');
  const contact = {
    id: `c_${randomUUID().slice(0, 8)}`,
    name,
    yoyo,
    note: String(input.note ?? '').trim(),
    createdAt: now.toISOString(),
  };
  insertContact(dataDir, contact);
  record(dataDir, { type: 'contact-add', id: contact.id, name, yoyo });
  return contact;
}
