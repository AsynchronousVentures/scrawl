// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import createClient from 'openapi-fetch';
import { validateContent } from '@scrawl/content';
import type { ContentEnvelope } from '@scrawl/content';
import type { operations, paths } from './schema';

type JsonResponse<T extends keyof operations, S extends keyof operations[T]['responses']> =
  operations[T]['responses'][S] extends { content: { 'application/json': infer R } } ? R : never;
export type User = JsonResponse<'getMe', 200>;
export type Space = JsonResponse<'readSpace', 200>;
export type SpaceMembers = JsonResponse<'listSpaceMembers', 200>;
export type MemberProfile = JsonResponse<'lookupUser', 200>;
export type DocumentSummary = JsonResponse<'listDocuments', 200>['items'][number];
export type RevisionSummary = JsonResponse<'listDocumentRevisions', 200>['items'][number];
export type SearchResult = JsonResponse<'searchDocuments', 200>['items'][number];
export type Attachment = JsonResponse<'uploadDocumentAttachment', 201>;
export type ExportFormat = 'pdf' | 'docx';
export type PublishingAvailability = JsonResponse<'getPublishingAvailability', 200>;
export type PublicationStatus = JsonResponse<'readDocumentPublication', 200>;
export type LiveMetadata = JsonResponse<'readLiveDocument', 200>;
type WirePublicDocument = JsonResponse<'readPublicPublication', 200>;
export type PublicDocument = Omit<WirePublicDocument, 'content'> & { content: ContentEnvelope };
type WireDocument = JsonResponse<'readDocument', 200>;
type WireRevision = JsonResponse<'readDocumentRevision', 200>;
export type Revision = Omit<WireRevision, 'content'> & { content: ContentEnvelope };
export type Document = Omit<WireDocument, 'revision'> & { revision: Revision };
export type LoadedDocument = { document: Document; etag: string };
export type Draft = { title: string; content: ContentEnvelope };

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(status === 0 ? 'Cannot reach Scrawl. Check your connection and try again.'
      : status === 401 ? 'Your session expired. Sign in again.'
      : status === 403 ? 'Your access has changed. This action is unavailable.'
      : status === 404 ? 'This document or space is unavailable.'
      : status === 412 ? 'The document changed since you opened it.'
      : status === 413 ? 'The document is too large to save.'
      : status === 415 ? 'This file type is not supported.'
      : status === 422 ? 'This saved revision contains content that cannot be rendered in this format, such as unsupported media or colors. Export native JSON to preserve its full content.'
      : status === 409 ? 'This action is unavailable for the current document state.'
      : status === 429 ? 'Too many attempts. Wait a moment and try again.'
      : status === 400 ? 'The request was rejected. Check the title and supported content.'
      : 'The request failed. Your unsaved work has not been saved.');
  }
}

const client = createClient<paths>({ baseUrl: location.origin, credentials: 'same-origin', cache: 'no-store' });
async function checked<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>) {
  let result: Awaited<typeof request>;
  try { result = await request; } catch { throw new ApiError(0); }
  if (!result.response.ok) throw new ApiError(result.response.status);
  if (result.data === undefined) throw new ApiError(502);
  return { data: result.data, response: result.response };
}
function spaceEtag(response: Response) {
  const etag = response.headers.get('etag');
  if (!etag || !/^"space-[0-9a-f-]+-v[1-9][0-9]*"$/i.test(etag)) throw new ApiError(502);
  return etag;
}
function documentEtag(response: Response) {
  const etag = response.headers.get('etag');
  if (!etag || !/^"doc-[0-9a-f-]+-bn1-v[1-9][0-9]*"$/i.test(etag)) throw new ApiError(502);
  return etag;
}
function loaded(data: WireDocument, response: Response): LoadedDocument {
  const etag = documentEtag(response);
  return { document: { ...data, revision: { ...data.revision, content: validateContent(data.revision.content).content } }, etag };
}

// The deliberately restricted auth routes are excluded from product OpenAPI.
async function auth(path: 'sign-in/email' | 'sign-out', body: object) {
  let response: Response;
  try { response = await fetch(`/api/auth/${path}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' }); }
  catch { throw new ApiError(0); }
  if (!response.ok) throw new ApiError(response.status);
}

export const api = {
  async collaboration() { return (await checked(client.GET('/api/v1/collaboration'))).data; },
  async me() { return (await checked(client.GET('/api/v1/me'))).data; },
  async login(email: string, password: string) { await auth('sign-in/email', { email, password }); return this.me(); },
  logout() { return auth('sign-out', {}); },
  async spaces(cursor?: string) { return (await checked(client.GET('/api/v1/spaces', {
    params: { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
  }))).data; },
  async createSpace(name: string) { return (await checked(client.POST('/api/v1/spaces', { body: { name } }))).data; },
  async space(id: string) { return (await checked(client.GET('/api/v1/spaces/{id}', { params: { path: { id } } }))).data; },
  async spaceBySlug(slug: string) { return (await checked(client.GET('/api/v1/spaces/by-slug/{slug}', { params: { path: { slug } } }))).data; },
  async lookupUser(email: string) {
    return (await checked(client.POST('/api/v1/users/lookup', { body: { email } }))).data;
  },
  async members(id: string, cursor?: string) {
    const { data, response } = await checked(client.GET('/api/v1/spaces/{id}/members', {
      params: { path: { id }, query: { limit: 50, ...(cursor ? { cursor } : {}) } },
    }));
    return { members: data, etag: spaceEtag(response) };
  },
  async changeMember(id: string, userId: string, etag: string, role: 'reader' | 'editor' | null) {
    const params = { path: { id, userId }, header: { 'if-match': etag } };
    const { data, response } = await checked(role === null
      ? client.DELETE('/api/v1/spaces/{id}/members/{userId}', { params })
      : client.PUT('/api/v1/spaces/{id}/members/{userId}', { params, body: { role } }));
    return { space: data, etag: spaceEtag(response) };
  },
  async search(q: string, signal: AbortSignal) {
    return (await checked(client.GET('/api/v1/search', { params: { query: { q, limit: 20 } }, signal }))).data;
  },
  async documents(id: string, includeArchived: boolean, cursor?: string) {
    return (await checked(client.GET('/api/v1/spaces/{id}/documents', {
      params: { path: { id }, query: { limit: 100, includeArchived, ...(cursor ? { cursor } : {}) } },
    }))).data;
  },
  async document(id: string) {
    const { data, response } = await checked(client.GET('/api/v1/documents/{id}', { params: { path: { id } } }));
    return loaded(data, response);
  },
  async liveDocument(id: string) {
    return (await checked(client.GET('/api/v1/documents/{id}/live', { params: { path: { id } } }))).data;
  },
  async enrollLive(id: string, etag: string) {
    return (await checked(client.POST('/api/v1/documents/{id}/live', {
      params: { path: { id }, header: { 'if-match': etag } }, body: {},
    }))).data;
  },
  async liveUsers(id: string, userIds: string[]) {
    return (await checked(client.POST('/api/v1/documents/{id}/live/users', {
      params: { path: { id } }, body: { userIds },
    }))).data;
  },
  async anchorLiveComment(id: string, epoch: string, threadId: string,
    selection: operations['anchorLiveCommentThread']['requestBody']['content']['application/json']['selection']['yjs']) {
    return (await checked(client.POST('/api/v1/documents/{id}/live/{epoch}/threads/{threadId}/addToDocument', {
      params: { path: { id, epoch, threadId } }, body: { selection: { yjs: selection } },
    }))).data;
  },
  async checkpointLive(id: string, etag: string, snapshot: Pick<LiveMetadata, 'epoch' | 'sequence'>) {
    const { data, response } = await checked(client.POST('/api/v1/documents/{id}/live/{epoch}/checkpoint', {
      params: { path: { id, epoch: snapshot.epoch }, header: { 'if-match': etag } }, body: { sequence: snapshot.sequence },
    }));
    return loaded(data, response);
  },
  async restoreLive(id: string, etag: string, snapshot: Pick<LiveMetadata, 'epoch' | 'sequence'>, revisionId: string) {
    const { data, response } = await checked(client.POST('/api/v1/documents/{id}/live/{epoch}/restore', {
      params: { path: { id, epoch: snapshot.epoch }, header: { 'if-match': etag } },
      body: { sequence: snapshot.sequence, revisionId },
    }));
    return { ...loaded(data.document, response), room: data.room };
  },
  async documentBySlug(id: string, slug: string) {
    const { data, response } = await checked(client.GET('/api/v1/spaces/{id}/documents/by-slug/{slug}', {
      params: { path: { id, slug } },
    }));
    return loaded(data, response);
  },
  async create(id: string, draft: Draft) {
    const { data, response } = await checked(client.POST('/api/v1/spaces/{id}/documents', {
      params: { path: { id } }, body: draft,
    }));
    return loaded(data, response);
  },
  async save(id: string, etag: string, draft: Draft) {
    const { data, response } = await checked(client.PATCH('/api/v1/documents/{id}', {
      params: { path: { id }, header: { 'if-match': etag } }, body: draft,
    }));
    return loaded(data, response);
  },
  async revisions(id: string, cursor?: number) {
    return (await checked(client.GET('/api/v1/documents/{id}/revisions', {
      params: { path: { id }, query: { limit: 100, ...(cursor ? { cursor } : {}) } },
    }))).data;
  },
  async revision(id: string, revisionId: string): Promise<Revision> {
    const { data } = await checked(client.GET('/api/v1/documents/{id}/revisions/{revisionId}', {
      params: { path: { id, revisionId } },
    }));
    return { ...data, content: validateContent(data.content).content };
  },
  async restore(id: string, etag: string, revisionId: string) {
    const { data, response } = await checked(client.POST('/api/v1/documents/{id}/restore', {
      params: { path: { id }, header: { 'if-match': etag } }, body: { revisionId },
    }));
    return loaded(data, response);
  },
  async archive(id: string, etag: string, archived: boolean) {
    const { data, response } = await checked(client.POST(archived
      ? '/api/v1/documents/{id}/unarchive' : '/api/v1/documents/{id}/archive', {
      params: { path: { id }, header: { 'if-match': etag } }, body: {},
    }));
    return loaded(data, response);
  },
  async export(id: string) {
    const { data } = await checked(client.GET('/api/v1/documents/{id}/export', { params: { path: { id } } }));
    return { ...data, content: validateContent(data.content).content };
  },
  async upload(id: string, file: File): Promise<Attachment> {
    const { data } = await checked(client.POST('/api/v1/documents/{id}/attachments', {
      params: { path: { id }, header: { 'x-file-name': encodeURIComponent(file.name) } },
      headers: { 'content-type': 'application/octet-stream' },
      // OpenAPI models binary request bodies as strings. The serializer sends
      // the actual File bytes without JSON encoding or a boundary type cast.
      body: '', bodySerializer: () => file,
    }));
    if (!/^\/api\/v1\/attachments\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/content$/i.test(data.url)) throw new ApiError(502);
    return data;
  },
  async exportFile(id: string, format: ExportFormat, revisionId?: string) {
    const { data } = await checked(client.GET('/api/v1/documents/{id}/exports/{format}', {
      params: { path: { id, format }, query: revisionId ? { revisionId } : {} }, parseAs: 'blob',
    }));
    const expected = format === 'pdf' ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (data.type !== expected || !data.size) throw new ApiError(502);
    return data;
  },
  async resolveFileUrl(url: string) {
    return url.startsWith('/api/v1/attachments/') ? new URL(url, location.origin).href : url;
  },
  async publishingAvailability() {
    return (await checked(client.GET('/api/v1/publishing'))).data;
  },
  async publication(id: string) {
    return (await checked(client.GET('/api/v1/documents/{id}/publication', { params: { path: { id } } }))).data;
  },
  async publish(id: string, etag: string, revisionId: string) {
    const result = await checked(client.POST('/api/v1/documents/{id}/publication', {
      params: { path: { id }, header: { 'if-match': etag } }, body: { revisionId },
    }));
    return { status: result.data, etag: documentEtag(result.response) };
  },
  async unpublish(id: string, etag: string) {
    const result = await checked(client.DELETE('/api/v1/documents/{id}/publication', {
      params: { path: { id }, header: { 'if-match': etag } },
    }));
    return { status: result.data, etag: documentEtag(result.response) };
  },
  async publicDocument(publicId: string, signal: AbortSignal): Promise<PublicDocument> {
    const { data } = await checked(client.GET('/api/public/publications/{publicId}', {
      params: { path: { publicId } }, credentials: 'omit', signal,
    }));
    return { ...data, content: validateContent(data.content).content };
  },
};
