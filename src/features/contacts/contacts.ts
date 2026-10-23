import { randomUUID } from 'node:crypto';

import type { Contact, ContactInput } from '../../kernel/types.ts';
import type { Repos } from '../../ports/index.ts';

/** 先只记下对方的 yoyo 地址。以后用这个地址去联系对方的 yoyo。 */
export function addContact(
  repos: Pick<Repos, 'contacts' | 'activity'>,
  input: ContactInput,
  now: Date = new Date(),
): Contact {
  const name = (input.name ?? '').trim();
  const yoyo = (input.yoyo ?? '').trim();
  if (!name) throw new Error('联系人要有名字');
  if (!yoyo) throw new Error('联系人要有 yoyo 地址');
  const contact: Contact = {
    id: `c_${randomUUID().slice(0, 8)}`,
    name,
    yoyo,
    note: (input.note ?? '').trim(),
    createdAt: now.toISOString(),
  };
  repos.contacts.insert(contact);
  repos.activity.record({ type: 'contact-add', id: contact.id, name, yoyo });
  return contact;
}
