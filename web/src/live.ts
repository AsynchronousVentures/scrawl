// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { createExtension, createUserStore } from '@blocknote/core';
import { CommentsExtension, DefaultThreadStoreAuth } from '@blocknote/core/comments';
import { RESTYjsThreadStore } from '@blocknote/core/yjs';
import { absolutePositionToRelativePosition, defaultDeleteFilter, redoCommand, undoCommand, ySyncPluginKey, yUndoPlugin, yUndoPluginKey } from 'y-prosemirror';
import { simpleDiffString } from 'lib0/diff';
import { api, type LiveMetadata, type User } from './api/client';

export type LiveState = {
  phase: 'connecting' | 'connected' | 'closed'; metadata: LiveMetadata;
  initialized: boolean;
  title: string; pending: number; localChanges: boolean; canUndo: boolean; canRedo: boolean;
};

/** One private in-memory connection. Terminal failures never retry or replay its draft. */
export class LiveSession {
  readonly document = new Y.Doc({ gc: false });
  readonly fragment = this.document.getXmlFragment('document');
  readonly provider: HocuspocusProvider;
  readonly websocket: HocuspocusProviderWebsocket;
  readonly titleOrigin = Symbol('local-title');
  private phase: LiveState['phase'] = 'connecting';
  private metadata: LiveMetadata;
  private disposed = false;
  private localChanges = false;
  private initialized = false;
  private manager?: Y.UndoManager;
  private users?: ReturnType<typeof createUserStore>;

  constructor(readonly id: string, metadata: LiveMetadata, readonly user: User, private changed: (state: LiveState) => void) {
    this.metadata = metadata;
    this.document.getMap('metadata'); this.document.getMap('threads');
    this.websocket = new HocuspocusProviderWebsocket({
      url: location.origin.replace(/^http/, 'ws') + '/api/v1/live', autoConnect: false, maxAttempts: 1,
      // The configured callback runs before retry scheduling; a later listener is too late.
      onClose: () => { this.websocket.disconnect(); if (!this.disposed) { this.phase = 'closed'; this.emit(); } },
    });
    this.provider = new HocuspocusProvider({ websocketProvider: this.websocket,
      name: `${id}:${metadata.epoch}`, document: this.document, awareness: null,
      onSynced: ({ state }) => { if (state && this.phase !== 'closed') { this.phase = 'connected'; this.initialized = true; } this.emit(); },
      onUnsyncedChanges: () => this.emit(),
      onStateless: ({ payload }) => {
        try {
          const value: unknown = JSON.parse(payload);
          if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'live-state'
            || !('epoch' in value) || value.epoch !== metadata.epoch
            || !('sequence' in value) || typeof value.sequence !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value.sequence)
            || !('documentEtag' in value) || typeof value.documentEtag !== 'string'
            || !('canWrite' in value) || typeof value.canWrite !== 'boolean') throw new Error('Invalid live metadata');
          this.metadata = { ...metadata, sequence: value.sequence, documentEtag: value.documentEtag, canWrite: value.canWrite };
          // Current grant receipts also refresh the supplied cache. The resolver
          // maps removed authors to a neutral label without a global directory.
          if (this.users) void this.users.refetchUsers([...this.users.store.state.keys()]).catch(() => {});
          this.emit();
        } catch { this.phase = 'closed'; this.websocket.disconnect(); this.emit(); }
      },
    });
    this.provider.attach();
    this.document.on('update', (_update, origin) => {
      if (origin === this.titleOrigin || origin === ySyncPluginKey || origin === this.manager) this.localChanges = true;
      this.emit();
    });
  }
  private title() {
    const value = this.document.getMap('metadata').get('title');
    return value instanceof Y.Text ? value : undefined;
  }
  snapshot(): LiveState {
    return { phase: this.phase, initialized: this.initialized, metadata: this.metadata, title: this.title()?.toString() ?? '',
      pending: this.provider?.unsyncedChanges ?? 0, localChanges: this.localChanges,
      canUndo: Boolean(this.manager?.canUndo()), canRedo: Boolean(this.manager?.canRedo()) };
  }
  private emit() { if (!this.disposed && this.provider) this.changed(this.snapshot()); }
  connect() { return this.websocket.connect().catch(() => { if (!this.disposed) { this.phase = 'closed'; this.emit(); } }); }
  writeTitle(value: string) {
    const title = this.title(); if (!title || this.phase !== 'connected' || !this.metadata.canWrite) return;
    // Supplied diff preserves UTF-16 surrogate boundaries and peers' untouched characters.
    const diff = simpleDiffString(title.toString(), value);
    this.document.transact(() => { if (diff.remove) title.delete(diff.index, diff.remove); if (diff.insert) title.insert(diff.index, diff.insert); }, this.titleOrigin);
  }
  checkpointAccepted(sequence: string) {
    if (this.metadata.sequence === sequence && this.provider.unsyncedChanges === 0) this.localChanges = false;
    this.emit();
  }
  undo() { if (this.phase === 'connected' && this.metadata.canWrite) this.manager?.undo(); }
  redo() { if (this.phase === 'connected' && this.metadata.canWrite) this.manager?.redo(); }
  extensions() {
    const session = this;
    let captureSelection: (() => Parameters<typeof api.anchorLiveComment>[3]) | undefined;
    const undo = createExtension(({ editor }) => {
      captureSelection = () => {
        const binding = ySyncPluginKey.getState(editor.prosemirrorState)?.binding;
        if (!binding) throw new Error('Comment selection is unavailable');
        const selection = editor.prosemirrorState.selection;
        // Native conversion returns its library JSON shape; the generated
        // request and core both enforce the relative-position contract.
        return { head: Y.relativePositionToJSON(absolutePositionToRelativePosition(selection.head, binding.type, binding.mapping)),
          anchor: Y.relativePositionToJSON(absolutePositionToRelativePosition(selection.anchor, binding.type, binding.mapping)) };
      };
      const title = session.title(); if (!title) throw new Error('Connect before mounting the editor');
      const protectedNodes = new Set<string>();
      const manager = new Y.UndoManager([session.fragment, title], { trackedOrigins: new Set([ySyncPluginKey, session.titleOrigin]),
        ignoreRemoteMapChanges: false, deleteFilter: item => {
          if (protectedNodes.size === 0 || !defaultDeleteFilter(item, protectedNodes)) return false;
          // Retained containers also need their native ID for server validation.
          if (item.parentSub === 'id' && item.parent instanceof Y.XmlElement
            && item.parent.nodeName === 'blockContainer' && item.parent.length > 0) return false;
          // A surviving nested group still needs its parent's block content,
          // even after undo removes all locally typed text from that content.
          // Otherwise PM drops the invalid container and its peer-owned child.
          return !(item.content instanceof Y.ContentType && item.content.type instanceof Y.XmlElement
            && item.content.type.nodeName !== 'blockGroup' && item.parent instanceof Y.XmlElement
            && item.parent.nodeName === 'blockContainer' && item.parent.toArray().some(child =>
              child instanceof Y.XmlElement && child.nodeName === 'blockGroup' && child.length > 0));
        },
        captureTransaction: transaction => transaction.meta.get('addToHistory') !== false });
      session.manager = manager;
      let refreshingUndo = false;
      for (const event of ['stack-item-added', 'stack-item-popped', 'stack-cleared'] as const) manager.on(event, () => {
        session.emit();
        // Title transactions don't change PM content. Refresh the supplied
        // plugin's command state after the current transaction completes.
        if (refreshingUndo) return;
        refreshingUndo = true;
        queueMicrotask(() => {
          refreshingUndo = false;
          const view = !session.disposed && editor.prosemirrorView;
          // No document change is made. addToHistory:false would force the
          // supplied binding to stop capturing after every typed character.
          if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(yUndoPluginKey, {}));
        });
      });
      return { key: 'yUndo', dependsOn: ['yCursor', 'ySync'],
        mount: () => { for (const node of Object.keys(editor.pmSchema.nodes)) protectedNodes.add(node); },
        prosemirrorPlugins: [yUndoPlugin({ undoManager: manager })], undoCommand, redoCommand } as const;
    });
    class CurrentAuth extends DefaultThreadStoreAuth {
      private writable() { return session.phase === 'connected' && session.metadata.canWrite; }
      override canCreateThread() { return this.writable() && super.canCreateThread(); }
      override canAddComment(...args: Parameters<DefaultThreadStoreAuth['canAddComment']>) { return this.writable() && super.canAddComment(...args); }
      override canUpdateComment(...args: Parameters<DefaultThreadStoreAuth['canUpdateComment']>) { return this.writable() && super.canUpdateComment(...args); }
      override canDeleteComment(...args: Parameters<DefaultThreadStoreAuth['canDeleteComment']>) { return this.writable() && super.canDeleteComment(...args); }
      override canDeleteThread(...args: Parameters<DefaultThreadStoreAuth['canDeleteThread']>) { return this.writable() && super.canDeleteThread(...args); }
      override canResolveThread(...args: Parameters<DefaultThreadStoreAuth['canResolveThread']>) { return this.writable() && super.canResolveThread(...args); }
      override canUnresolveThread(...args: Parameters<DefaultThreadStoreAuth['canUnresolveThread']>) { return this.writable() && super.canUnresolveThread(...args); }
      override canAddReaction(...args: Parameters<DefaultThreadStoreAuth['canAddReaction']>) { return this.writable() && super.canAddReaction(...args); }
      override canDeleteReaction(...args: Parameters<DefaultThreadStoreAuth['canDeleteReaction']>) { return this.writable() && super.canDeleteReaction(...args); }
    }
    const users = createUserStore(async ids => {
      const resolved = new Map((await api.liveUsers(this.id, ids)).map(user => [user.id, user.name]));
      return ids.map(id => ({ id, username: resolved.get(id) ?? 'Former member', avatarUrl: '' }));
    });
    this.users = users;
    const threads = new RESTYjsThreadStore(`/api/v1/documents/${this.id}/live/${this.metadata.epoch}/threads`, {},
      this.document.getMap('threads'), new CurrentAuth(this.user.id, 'editor'));
    const pendingAnchors = new Map<string, Parameters<typeof api.anchorLiveComment>[3]>();
    const createThread = threads.createThread;
    // The pinned store captures selection after create returns. Preserve native
    // relative positions before that wait, including through concurrent edits.
    threads.createThread = async options => {
      const selection = captureSelection?.(); if (!selection) throw new Error('Comment selection is unavailable');
      const thread = await createThread(options); pendingAnchors.set(thread.id, selection); return thread;
    };
    threads.addThreadToDocument = async options => {
      const selection = pendingAnchors.get(options.threadId);
      if (!selection) throw new Error('Comment selection is unavailable');
      try { await api.anchorLiveComment(this.id, this.metadata.epoch, options.threadId, selection); }
      finally { pendingAnchors.delete(options.threadId); }
    };
    return [undo(), CommentsExtension({ threadStore: threads, resolveUsers: users })];
  }
  destroy() {
    this.disposed = true; this.provider.destroy(); this.websocket.destroy(); this.manager?.destroy(); this.document.destroy();
  }
}
