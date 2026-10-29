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

/** 删掉一个联系人，记一条 'contact-remove'。没有这个人返回 null。 */
export function removeContact(repos: Pick<Repos, 'contacts' | 'activity'>, id: string): Contact | null {
  const contact = repos.contacts.list().find((item) => item.id === id);
  if (!contact || !repos.contacts.remove(id)) return null;
  repos.activity.record({ type: 'contact-remove', id, name: contact.name });
  return contact;
}
