// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hocuspocus, MessageType, type Document } from '@hocuspocus/server';
import { Mutex } from 'async-mutex';
import { createDecoder, readVarString, readVarUint } from 'lib0/decoding';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { messageYjsSyncStep1, messageYjsSyncStep2 } from 'y-protocols/sync';
import type { Core } from '../../core/index.js';
import type { Principal } from '../../core/identity/index.js';
import { LIVE_LIMITS } from '../../core/live/content.js';
import { HttpProblem } from '../../http/problems.js';
import { documentEtag } from '../../core/documents/index.js';
import { privatePresence, PRESENCE_LIMITS } from './presence.js';

type Owner = { assertHeld(): void; lost: Promise<void> };
type Context = {
  socket: WebSocket; headers: Headers; principal: Principal;
  expiresAt: number; allowed: boolean;
  address?: string; room?: { id: string; epoch: string };
  pendingBytes: number; pendingMessages: number; authenticated: boolean;
  release?: () => void; joinRelease?: () => void;
  presenceId?: number; presenceUser?: { id: string; name: string };
};
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const roomPattern = new RegExp(`^(${uuid}):(${uuid})$`);
const documentPattern = new RegExp(`^${uuid}$`);
const addressPattern = new RegExp(`^${uuid}:${uuid}(?:\\0${uuid})?$`);
const unavailable = () => ({ code: 4403, reason: 'Live connection unavailable' });

/** Prepared transport, not mounted by application startup until the activation gates pass. */
export function createCollaboration(core: Core, owner: Owner, origin: string) {
  const sockets = new Set<Context>();
  const contexts = new Map<string, Context>();
  const locks = new Map<string, { mutex: Mutex; users: number }>();
  const failedRooms = new Set<string>();
  const processing = new Set<Promise<void>>();
  let stopped = false, pendingUpgrades = 0;
  let auditTask: Promise<void> | undefined;
  async function acquire(name: string) {
    // Restores change epochs. Joins, enrollment and lifecycle mutations still
    // share one document lock with every old-epoch in-flight acceptance.
    const id = name.split(':')[0]!;
    const entry = locks.get(id) ?? { mutex: new Mutex(), users: 0 };
    locks.set(id, entry); entry.users++;
    const unlock = await entry.mutex.acquire();
    return () => { unlock(); if (--entry.users === 0) locks.delete(id); };
  }
  function fail(context: Context) {
    context.allowed = false;
    context.socket.close(4403, 'Live connection unavailable');
  }
  function finishJoin(context: Context) { const release = context.joinRelease; delete context.joinRelease; release?.(); }
  function stop() { stopped = true; for (const context of sockets) fail(context); }
  function abortRoom(document: Document) {
    failedRooms.add(document.name);
    for (const connection of document.getConnections()) {
      const context = contexts.get(connection.socketId); if (context) context.allowed = false;
    }
    for (const connection of document.getConnections()) {
      connection.close(unavailable());
      const context = contexts.get(connection.socketId); if (context) fail(context);
    }
  }
  void owner.lost.then(stop);
  function audience(document: Document) {
    return document.getConnections().map(connection => {
      const context = contexts.get(connection.socketId);
      if (!context) throw unavailable();
      return { connectionId: connection.socketId, principal: context.principal };
    });
  }
  function prune(document: Document, recipients: readonly { connectionId: string; canWrite: boolean }[]) {
    const permissions = new Map(recipients.map(recipient => [recipient.connectionId, recipient.canWrite]));
    const connections = document.getConnections();
    // Disable all rejected sends before closing any connection: awareness removal
    // broadcasts synchronously from the supplied transport's close callback.
    for (const connection of connections) {
      const context = contexts.get(connection.socketId);
      if (context && (!permissions.has(connection.socketId) || context.expiresAt <= Date.now())) context.allowed = false;
    }
    for (const connection of connections) {
      const context = contexts.get(connection.socketId);
      if (!context?.allowed) {
        connection.close(unavailable()); if (context) fail(context);
      } else connection.readOnly = !permissions.get(connection.socketId);
    }
  }
  function sendState(document: Document, state: { epoch: string; sequence: string; documentEtag: string }) {
    for (const connection of document.getConnections()) {
      const context = contexts.get(connection.socketId);
      if (!context?.allowed) continue;
      connection.sendStateless(JSON.stringify({ type: 'live-state', epoch: state.epoch,
        sequence: state.sequence, documentEtag: state.documentEtag, canWrite: !connection.readOnly }));
    }
  }
  async function authorize(document: Document, context: Context) {
    owner.assertHeld();
    if (stopped || !context.allowed || !context.room || context.expiresAt <= Date.now()) throw unavailable();
    const receipt = await core.documents.live.authorizeConnections(context.headers, context.room.id, context.room.epoch, audience(document));
    owner.assertHeld(); prune(document, receipt.recipients);
    if (!context.allowed) throw unavailable();
    context.presenceUser = receipt.user;
    return receipt;
  }
  function finish(context: Context, bytes: number) {
    context.release?.(); delete context.release;
    context.pendingBytes -= bytes; context.pendingMessages--;
  }
  const hocuspocus = new Hocuspocus<{ connection: Context }>({
    quiet: true, flushDelay: false, yDocOptions: { gc: false, gcFilter: () => false }, unloadImmediately: true,
    timeout: 30_000, maxUnauthenticatedQueueSize: 2 * LIVE_LIMITS.maxUpdateBytes,
    maxUnauthenticatedQueueMessages: 64, maxPendingDocuments: 1,
    async onAuthenticate({ context: { connection: context }, documentName, socketId, token, connectionConfig }) {
      try {
        owner.assertHeld();
        const match = roomPattern.exec(documentName);
        if (!match || token || stopped || failedRooms.has(documentName) || context.expiresAt <= Date.now()) throw unavailable();
        const room = { id: match[1]!, epoch: match[2]! };
        const release = await acquire(documentName);
        context.joinRelease = release;
        try {
          if (stopped || !context.allowed) throw unavailable();
          const snapshot = await core.documents.live.read(context.headers, room.id);
          if (stopped || !context.allowed || snapshot.epoch !== room.epoch) throw unavailable();
          // A connection's initial snapshot/awareness cannot bypass the audience check.
          context.room = room; contexts.set(socketId, context);
          const document = hocuspocus.documents.get(documentName);
          if (document) {
            if (document.getConnectionsCount() >= 64) throw unavailable();
            await authorize(document, context);
          }
          const receipt = await core.documents.live.authorizeConnections(context.headers, room.id, room.epoch,
            [{ connectionId: socketId, principal: context.principal }]);
          owner.assertHeld();
          if (stopped || !context.allowed || context.expiresAt <= Date.now()) throw unavailable();
          connectionConfig.readOnly = !receipt.recipients[0]?.canWrite;
        } catch (error) { finishJoin(context); throw error; }
      } catch { finishJoin(context); fail(context); throw unavailable(); }
    },
    async connected({ context: { connection: context }, connection }) {
      try {
        // Keep joining serialized through the supplied connection registration.
        // A recipient snapshot must not accidentally exclude a newly added peer.
        const state = await authorize(connection.document, context);
        sendState(connection.document, state);
      } catch { fail(context); throw unavailable(); }
      finally { finishJoin(context); }
    },
    async onLoadDocument({ context: { connection: context }, document }) {
      try {
        if (!context.room || stopped || !context.allowed) throw unavailable();
        const room = await core.documents.live.read(context.headers, context.room.id);
        owner.assertHeld();
        if (stopped || !context.allowed || room.epoch !== context.room.epoch) throw unavailable();
        return room.state;
      } catch {
        // Hocuspocus has not registered a failed initial load in its document
        // map, so its unload path cannot destroy that document's awareness timer.
        document.destroy(); finishJoin(context); fail(context); throw unavailable();
      }
    },
    async beforeHandleMessage({ context: { connection: context }, document, documentName, update, connection }) {
      context.release = await acquire(documentName);
      // Retain in-flight work even after its socket has left the room. Shutdown
      // must wait for the durable acceptance outcome before releasing the owner.
      const pending = connection.waitForPendingMessages();
      processing.add(pending);
      void pending.then(() => processing.delete(pending), () => { processing.delete(pending); stop(); });
      try { await authorize(document, context); }
      catch { finish(context, update.byteLength); fail(context); throw unavailable(); }
    },
    async afterHandleMessage({ context: { connection: context }, update }) { finish(context, update.byteLength); },
    async beforeSync({ context: { connection: context }, document, connection, type, payload }) {
      try {
        if (type === messageYjsSyncStep1) return;
        if (!context.room) throw unavailable();
        if (connection.readOnly) {
          // Readers may echo an unchanged initial state, but never author updates.
          if (type === messageYjsSyncStep2 && Y.snapshotContainsUpdate(Y.snapshot(document), payload)) return;
          throw new HttpProblem(403, 'ACCESS_DENIED');
        }
        const accepted = await core.documents.live.update(context.headers, context.room.id, context.room.epoch, payload, audience(document));
        owner.assertHeld(); prune(document, accepted.recipients);
        if (!context.allowed) throw unavailable();
        // Apply the complete committed state, not a possibly older cache. The
        // receiver's subsequent apply is idempotent and acknowledges only afterward.
        Y.applyUpdate(document, accepted.state, { source: 'connection', connection });
        sendState(document, accepted);
      } catch (error) {
        // Unknown database/commit failures invalidate the cache for every peer.
        // Never infer rollback or allow a reconnect to read that old cache.
        if (!(error instanceof HttpProblem && [400, 401, 403, 404, 413].includes(error.status))) abortRoom(document);
        fail(context); throw unavailable();
      }
    },
    async beforeHandleAwareness({ context, states, document, socketId }) {
      if (!context?.connection) throw unavailable();
      const connection = context.connection;
      try {
        // The pinned hook's scratch Awareness starts with its own empty state.
        // Empty states advertise nothing and must not acquire a socket identity.
        for (const [clientId, state] of states) if (Object.keys(state).length === 0) states.delete(clientId);
        if (states.size > PRESENCE_LIMITS.maxClients || !connection.allowed || !connection.presenceUser) throw unavailable();
        const owned = [...states.keys()].filter(clientId => !document.getConnections().some(peer => peer.socketId !== socketId
          && document.getClients(peer).has(clientId)));
        if (owned.length > 1) throw unavailable();
        // Native QueryAwareness replies can relay known peers. Ignore those
        // copies; only each peer's own authenticated connection may update it.
        for (const clientId of states.keys()) if (!owned.includes(clientId)) states.delete(clientId);
        for (const [clientId, state] of states) {
          if (!Number.isSafeInteger(clientId) || clientId < 0 || clientId === document.clientID
            || connection.presenceId !== undefined && connection.presenceId !== clientId) throw unavailable();
          // Bind the ID before applying it. An authorized client may advertise its
          // own cursor, never replace another connection or provide its identity.
          const presence = privatePresence(state, document, connection.presenceUser);
          connection.presenceId = clientId;
          states.set(clientId, presence);
        }
      } catch { fail(connection); throw unavailable(); }
    },
    async onStateless({ connection }) { connection.close(unavailable()); },
    async onTokenSync({ context: { connection: context } }) { fail(context); throw unavailable(); },
    async afterUnloadDocument({ documentName }) { failedRooms.delete(documentName); },
  });
  const websocket = new WebSocketServer({ noServer: true, maxPayload: LIVE_LIMITS.maxUpdateBytes + 256,
    perMessageDeflate: false });
  function attach(socket: WebSocket, request: Request, context: Context) {
    sockets.add(context);
    const client = hocuspocus.handleConnection({
      get readyState() { return socket.readyState; },
      close(code, reason) { socket.close(code, reason); },
      send(data) {
        if (!context.allowed || context.expiresAt <= Date.now() || stopped) { fail(context); return; }
        if (socket.bufferedAmount > 2 * LIVE_LIMITS.maxStateBytes) { fail(context); return; }
        socket.send(data);
      },
    }, request, { connection: context });
    socket.on('message', (data, binary) => {
      try {
        if (!binary || !Buffer.isBuffer(data) || stopped || !context.allowed) throw unavailable();
        const decoder = createDecoder(data), address = readVarString(decoder), type = readVarUint(decoder);
        if (type === MessageType.Awareness && data.byteLength > PRESENCE_LIMITS.maxClients * PRESENCE_LIMITS.maxStateBytes + 256) throw unavailable();
        if (!addressPattern.test(address) || context.address && address !== context.address
          || ![MessageType.Auth, MessageType.Sync, MessageType.SyncReply, MessageType.Awareness, MessageType.QueryAwareness, MessageType.CLOSE].includes(type)) throw unavailable();
        context.address = address;
        if (type === MessageType.Auth) {
          if (context.authenticated) throw unavailable();
          context.authenticated = true;
        }
        if (type !== MessageType.Auth) {
          context.pendingBytes += data.byteLength; context.pendingMessages++;
          if (context.pendingBytes > 2 * LIVE_LIMITS.maxUpdateBytes || context.pendingMessages > 64) throw unavailable();
        }
        client.handleMessage(data);
      } catch { fail(context); }
    });
    socket.on('error', () => fail(context));
    socket.on('close', () => {
      context.allowed = false;
      finishJoin(context);
      sockets.delete(context);
      client.handleClose(unavailable());
      for (const [id, value] of contexts) if (value === context) contexts.delete(id);
    });
  }
  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    pendingUpgrades++;
    const timeout = setTimeout(() => socket.destroy(), 5000); timeout.unref();
    try {
      owner.assertHeld();
      if (stopped || request.url !== '/api/v1/live' || request.headers.origin !== origin || sockets.size + pendingUpgrades > 128) throw unavailable();
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      headers.set('origin', origin);
      const principal = await core.identity.resolve(headers);
      const session = await core.identity.connectionSession(principal);
      owner.assertHeld();
      if (stopped || socket.destroyed) throw unavailable();
      const webRequest = new Request(new URL('/api/v1/live', origin), { headers });
      websocket.handleUpgrade(request, socket, head, ws => {
        const context: Context = { socket: ws, headers, principal, ...session, allowed: true, pendingBytes: 0, pendingMessages: 0, authenticated: false };
        attach(ws, webRequest, context);
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
    finally { pendingUpgrades--; clearTimeout(timeout); }
  }
  const audit = setInterval(() => {
    for (const context of sockets) if (context.expiresAt <= Date.now()) fail(context);
    if (auditTask || stopped) return;
    auditTask = (async () => {
      for (const document of hocuspocus.documents.values()) {
        const release = await acquire(document.name);
        try {
          for (const connection of document.getConnections()) {
            const context = contexts.get(connection.socketId);
            if (!context) { connection.close(unavailable()); continue; }
            try { const state = await authorize(document, context); sendState(document, state); break; }
            catch { fail(context); connection.close(unavailable()); }
          }
        } finally { release(); }
      }
    })().catch(stop).finally(() => { auditTask = undefined; });
  }, 1000);
  audit.unref();
  async function serverMutation<T>(name: string, operation: (document: Document | undefined) => Promise<T>) {
    const work = (async () => {
      if (!roomPattern.test(name) && !documentPattern.test(name)) throw new HttpProblem(400, 'INVALID_REQUEST');
      const release = await acquire(name);
      const document = hocuspocus.documents.get(name) ?? (documentPattern.test(name)
        ? [...hocuspocus.documents.values()].find(room => room.name.startsWith(`${name}:`)) : undefined);
      try {
        owner.assertHeld();
        if (stopped || failedRooms.has(name) || document && failedRooms.has(document.name)) throw new HttpProblem(503, 'LIVE_CONNECTION_UNAVAILABLE');
        return await operation(document);
      } catch (error) {
        if (!(error instanceof HttpProblem && error.status < 500)) {
          if (documentPattern.test(name)) {
            for (const room of hocuspocus.documents.values()) if (room.name.startsWith(`${name}:`)) abortRoom(room);
          } else if (document) abortRoom(document);
        }
        throw error;
      } finally { release(); }
    })();
    const pending = work.then(() => {}, () => {});
    processing.add(pending);
    void pending.then(() => processing.delete(pending));
    return work;
  }
  return {
    attach(server: Server) { server.on('upgrade', upgrade); },
    async users(headers: Headers, id: string, userIds: readonly string[]) {
      owner.assertHeld();
      if (stopped) throw new HttpProblem(503, 'LIVE_CONNECTION_UNAVAILABLE');
      const users = await core.documents.live.users(headers, id, userIds);
      owner.assertHeld();
      if (stopped) throw new HttpProblem(503, 'LIVE_CONNECTION_UNAVAILABLE');
      return users;
    },
    async read(headers: Headers, id: string) {
      owner.assertHeld();
      if (stopped) throw new HttpProblem(503, 'LIVE_CONNECTION_UNAVAILABLE');
      const room = await core.documents.live.read(headers, id);
      owner.assertHeld();
      if (stopped) throw new HttpProblem(503, 'LIVE_CONNECTION_UNAVAILABLE');
      const { state: _state, ...metadata } = room;
      return metadata;
    },
    enroll(headers: Headers, id: string, expectedEtag?: string) {
      return serverMutation(id, async () => {
        const room = await core.documents.live.enroll(headers, id, expectedEtag);
        owner.assertHeld();
        if (stopped) throw new HttpProblem(503, 'LIVE_CONNECTION_UNAVAILABLE');
        const { state: _state, ...metadata } = room;
        return metadata;
      });
    },
    lifecycle(headers: Headers, id: string, operation: 'archive' | 'unarchive', expectedEtag?: string) {
      return serverMutation(id, async () => {
        const saved = await core.documents[operation](headers, id, expectedEtag);
        owner.assertHeld();
        if (stopped) throw new HttpProblem(503, 'LIVE_CONNECTION_UNAVAILABLE');
        if (operation === 'archive') {
          for (const room of hocuspocus.documents.values()) if (room.name.startsWith(`${id}:`)) {
            for (const connection of room.getConnections()) {
              const context = contexts.get(connection.socketId); if (context) context.allowed = false;
            }
            for (const connection of room.getConnections()) connection.close(unavailable());
          }
        }
        return saved;
      });
    },
    checkpoint(headers: Headers, id: string, epoch: string, input: unknown, expectedEtag?: string) {
      return serverMutation(`${id}:${epoch}`, async document => {
        const accepted = await core.documents.live.checkpoint(headers, id, input, expectedEtag, document ? audience(document) : []);
        owner.assertHeld();
        if (stopped) throw new HttpProblem(503, 'LIVE_CONNECTION_UNAVAILABLE');
        if (document && !document.isDestroyed) {
          prune(document, accepted.recipients);
          sendState(document, { ...accepted, documentEtag: documentEtag(accepted.document) });
        }
        return accepted.document;
      });
    },
    restore(headers: Headers, id: string, epoch: string, input: unknown, expectedEtag?: string) {
      return serverMutation(`${id}:${epoch}`, async document => {
        const accepted = await core.documents.live.restore(headers, id, input, expectedEtag, document ? audience(document) : []);
        owner.assertHeld();
        if (stopped) throw new HttpProblem(503, 'LIVE_CONNECTION_UNAVAILABLE');
        if (document && !document.isDestroyed) {
          // Old-epoch peers must deliberately reload. Disable sends before close callbacks run.
          for (const connection of document.getConnections()) {
            const context = contexts.get(connection.socketId); if (context) context.allowed = false;
          }
          for (const connection of document.getConnections()) connection.close(unavailable());
        }
        const { state: _state, ...room } = accepted.room;
        return { document: accepted.document, room };
      });
    },
    comment(headers: Headers, id: string, epoch: string, input: unknown) {
      return serverMutation(`${id}:${epoch}`, async document => {
        const accepted = await core.documents.live.comment(headers, id, epoch, input, document ? audience(document) : []);
        owner.assertHeld();
        if (stopped) throw new HttpProblem(503, 'LIVE_CONNECTION_UNAVAILABLE');
        if (document && !document.isDestroyed) {
          prune(document, accepted.recipients);
          Y.applyUpdate(document, accepted.state, 'scrawl-server-comment');
          sendState(document, accepted);
        }
        return accepted.result;
      });
    },
    async close(server?: Server) {
      server?.removeListener('upgrade', upgrade); clearInterval(audit);
      const pending = [...processing];
      stop();
      for (const context of sockets) context.socket.terminate();
      await new Promise<void>(resolve => websocket.close(() => resolve()));
      await Promise.all(pending); await auditTask;
      await Promise.allSettled([...hocuspocus.loadingDocuments.values()]);
      await Promise.all([...hocuspocus.documents.values()].map(document => hocuspocus.unloadDocument(document)));
    },
  };
}

export type Collaboration = ReturnType<typeof createCollaboration>;
