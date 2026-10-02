// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import * as Y from 'yjs';

export const PRESENCE_LIMITS = { maxClients: 64, maxStateBytes: 2048 } as const;
const invalid = () => { throw { code: 4403, reason: 'Live connection unavailable' }; };
function record(input: unknown, fields: readonly string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !fields.includes(key))) return invalid();
  return input as Record<string, unknown>;
}
function relative(input: unknown) {
  const value = record(input, ['type', 'tname', 'item', 'assoc']);
  function id(input: unknown) {
    if (input === undefined || input === null) return null;
    const value = record(input, ['client', 'clock']);
    if (typeof value.client !== 'number' || typeof value.clock !== 'number'
      || !Number.isSafeInteger(value.client) || !Number.isSafeInteger(value.clock)
      || value.client < 0 || value.clock < 0) return invalid();
    return Y.createID(value.client, value.clock);
  }
  const type = id(value.type), item = id(value.item);
  const tname = value.tname === undefined || value.tname === null ? null : value.tname;
  if (tname !== null && tname !== 'document' || !type && !tname
    || value.assoc !== undefined && value.assoc !== -1 && value.assoc !== 0 && value.assoc !== 1) return invalid();
  return new Y.RelativePosition(type, tname, item, value.assoc as number | undefined);
}

/** Ephemeral native presence, stripped to server identity and document cursors. */
export function privatePresence(input: unknown, document: Y.Doc, user: { id: string; name: string }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Buffer.byteLength(JSON.stringify(input)) > PRESENCE_LIMITS.maxStateBytes) return invalid();
  const value = input as Record<string, unknown>;
  const identity = { id: user.id, name: user.name, color: '#91ad95' };
  if (value.cursor === undefined || value.cursor === null) return { user: identity, cursor: null };
  const cursor = record(value.cursor, ['anchor', 'head']);
  const anchor = relative(cursor.anchor), head = relative(cursor.head);
  const fragment = document.getXmlFragment('document');
  for (const position of [anchor, head]) {
    const absolute = Y.createAbsolutePositionFromRelativePosition(position, document);
    // A normal cursor can briefly refer to a just-deleted or not-yet-accepted
    // block. Hide it rather than close a valid editing connection. Metadata and
    // private comment types must never become editor cursor coordinates.
    if (!absolute) return { user: identity, cursor: null };
    let type = absolute.type;
    while (type !== fragment && type.parent) type = type.parent;
    if (type !== fragment) return invalid();
  }
  return { user: identity, cursor: { anchor: Y.relativePositionToJSON(anchor), head: Y.relativePositionToJSON(head) } };
}
