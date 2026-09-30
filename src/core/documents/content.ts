// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { ServerBlockNoteEditor } from '@blocknote/server-util';
import type { DefaultInlineContentSchema, DefaultStyleSchema } from '@blocknote/core';
import { ContentValidationError, contentSchema, validateContent as validateSharedContent, type NativeBlockSchema } from '../../shared/content.js';

export * from '../../shared/content.js';

let editor: ServerBlockNoteEditor<NativeBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema> | undefined;

/** Native server utilities are kept outside the browser's shared contract. */
export function validateContent(input: unknown) {
  const validated = validateSharedContent(input);
  try {
    editor ??= ServerBlockNoteEditor.create({ schema: contentSchema });
    const native = editor._blocksToProsemirrorNode(validated.content.document);
    native.check();
    const roundTrip: unknown = editor._prosemirrorNodeToBlocks(native);
    const decoded = validateSharedContent({ ...validated.content, document: roundTrip });
    if (JSON.stringify(decoded.content) !== JSON.stringify(validated.content)) {
      throw new ContentValidationError(400, 'INVALID_CONTENT');
    }
    return decoded;
  } catch (error) {
    if (error instanceof ContentValidationError) throw error;
    throw new ContentValidationError(400, 'INVALID_CONTENT');
  }
}
