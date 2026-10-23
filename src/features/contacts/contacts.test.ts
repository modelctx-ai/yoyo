import assert from 'node:assert/strict';
import { describe, test } from 'vite-plus/test';

import type { ActivityEvent, Contact } from '../../kernel/types.ts';
import type { Repos } from '../../ports/index.ts';
import { addContact } from './contacts.ts';

/** 内存里的联系人和行为记录。 */
function memoryRepos() {
  const contacts: Contact[] = [];
  const events: ActivityEvent[] = [];
  const repos: Pick<Repos, 'contacts' | 'activity'> = {
    contacts: {
      list: () => [...contacts],
      insert: (contact) => {
        contacts.push(contact);
      },
    },
    activity: {
      record: (event) => {
        events.push(event);
      },
      list: () => events.map((event) => ({ ...event, at: new Date(0).toISOString() })),
    },
  };
  return { repos, contacts, events };
}

describe('contacts', () => {
  test('联系人要有名字和 yoyo 地址', () => {
    const { repos, contacts, events } = memoryRepos();
    assert.throws(() => addContact(repos, { yoyo: 'yoyo://xiaowang@example' }), { message: '联系人要有名字' });
    assert.throws(() => addContact(repos, { name: ' ', yoyo: 'yoyo://xiaowang@example' }), {
      message: '联系人要有名字',
    });
    assert.throws(() => addContact(repos, { name: '小王' }), { message: '联系人要有 yoyo 地址' });
    assert.equal(contacts.length, 0);
    assert.equal(events.length, 0);
  });

  test('联系人写进库，并记一条 contact-add', () => {
    const { repos, events } = memoryRepos();
    const now = new Date('2026-10-23T09:30:00.000Z');
    const contact = addContact(repos, { name: ' 小王 ', yoyo: ' yoyo://xiaowang@example ', note: ' 同事 ' }, now);
    assert.match(contact.id, /^c_[0-9a-f]{8}$/);
    assert.deepEqual(contact, {
      id: contact.id,
      name: '小王',
      yoyo: 'yoyo://xiaowang@example',
      note: '同事',
      createdAt: '2026-10-23T09:30:00.000Z',
    });
    assert.deepEqual(repos.contacts.list(), [contact]);
    assert.deepEqual(events, [{ type: 'contact-add', id: contact.id, name: '小王', yoyo: 'yoyo://xiaowang@example' }]);

    const other = addContact(repos, { name: '小李', yoyo: 'yoyo://xiaoli@example' });
    assert.equal(other.note, '');
    assert.notEqual(other.id, contact.id);
  });
});
