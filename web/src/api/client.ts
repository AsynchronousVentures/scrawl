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
export type DocumentSummary = JsonResponse<'listDocuments', 200>['items'][number];
export type RevisionSummary = JsonResponse<'listDocumentRevisions', 200>['items'][number];
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
function loaded(data: WireDocument, response: Response): LoadedDocument {
  const etag = response.headers.get('etag');
  if (!etag || !/^"doc-[0-9a-f-]+-bn1-v[1-9][0-9]*"$/i.test(etag)) throw new ApiError(502);
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
  async me() { return (await checked(client.GET('/api/v1/me'))).data; },
  async login(email: string, password: string) { await auth('sign-in/email', { email, password }); return this.me(); },
  logout() { return auth('sign-out', {}); },
  async spaces(cursor?: string) { return (await checked(client.GET('/api/v1/spaces', {
    params: { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
  }))).data; },
  async space(id: string) { return (await checked(client.GET('/api/v1/spaces/{id}', { params: { path: { id } } }))).data; },
  async documents(id: string, includeArchived: boolean, cursor?: string) {
    return (await checked(client.GET('/api/v1/spaces/{id}/documents', {
      params: { path: { id }, query: { limit: 100, includeArchived, ...(cursor ? { cursor } : {}) } },
    }))).data;
  },
  async document(id: string) {
    const { data, response } = await checked(client.GET('/api/v1/documents/{id}', { params: { path: { id } } }));
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
};
