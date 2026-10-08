import assert from 'node:assert/strict';
import { parseHostTarget } from '../public/js/joinTarget.mjs';

const origin = 'http://localhost:3000';

assert.deepEqual(parseHostTarget('AbC123xyz', origin), { ok: true, hostId: 'abc123xyz' });
assert.equal(
    parseHostTarget('http://localhost:3000/?host=abc123xyz', origin).hostId,
    'abc123xyz',
);
assert.equal(
    parseHostTarget('http://localhost:3000/index.html?host=abc123xyz&x=1', origin).hostId,
    'abc123xyz',
);
assert.equal(parseHostTarget('http://evil.example/?host=abc123xyz', origin).reason, 'origin');
assert.equal(parseHostTarget('not a link', origin).reason, 'invalid');
assert.equal(parseHostTarget('   ', origin).reason, 'empty');
assert.equal(parseHostTarget('http://localhost:3000/?host=ab', origin).reason, 'invalid');
assert.equal(parseHostTarget('abc', origin).reason, 'invalid');

console.log('parseHostTarget ok');
