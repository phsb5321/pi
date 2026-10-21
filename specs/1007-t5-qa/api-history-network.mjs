// Same denial boundary as the existing normalized runtime fixture, without its private SDK roles.
import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { relative, resolve, sep } from 'node:path';

const root = process.env.MP_SOCKET_ROOT;
assert(root, 'Owned socket root required');
globalThis.fetch = async () => { throw new Error('API/history: provider HTTP forbidden'); };
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  const path = typeof options === 'string' ? options : options?.path;
  assert(typeof path === 'string', 'API/history: TCP forbidden');
  const inside = relative(root, resolve(path));
  assert(inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !inside.startsWith(sep), 'Foreign Unix socket');
  return connect.apply(this, args);
};
