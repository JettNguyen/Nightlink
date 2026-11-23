import { test } from 'node:test';
import assert from 'node:assert/strict';
import billing from '../api/_lib/billing.js';

// Who the comp list gives Pro to.

const SAM = { id: '6B0F8F8E-2D4C-4B8A-9F43-1C2D3E4F5A61', email: 'sam@example.com' };
const DANA = { id: 'f2a9c4d1-7e3b-4c55-8a10-9b8c7d6e5f42', email: 'dana@example.com' };

test('account ids on the list get Pro, matched without regard to case', () => {
  const ids = ` ${SAM.id.toLowerCase()} , other-id`;
  assert.equal(billing.isComped(SAM, { ids, emails: '' }), true);
  assert.equal(billing.isComped(DANA, { ids, emails: '' }), false);
});

test('once account ids are set, a listed email no longer counts', () => {
  assert.equal(billing.isComped(DANA, { ids: SAM.id, emails: 'dana@example.com' }), false);
});

test('with no account ids set, the email list still works as it did', () => {
  assert.equal(billing.isComped(DANA, { ids: '', emails: 'Dana@Example.com, sam@example.com' }), true);
  assert.equal(billing.isComped({ id: 'x', email: '' }, { ids: '', emails: 'dana@example.com' }), false);
  assert.equal(billing.isComped(null, { ids: '', emails: 'dana@example.com' }), false);
});
