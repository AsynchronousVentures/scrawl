// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createExtension, type BlockNoteEditor } from '@blocknote/core';
import { Selection, TextSelection } from 'prosemirror-state';

function documentEnd(editor: Pick<BlockNoteEditor, 'isEditable' | 'transact' | 'prosemirrorView'>, extend: boolean) {
  if (!editor.isEditable) return false;
  const view = editor.prosemirrorView;
  const selection = extend ? view.dom.ownerDocument.getSelection() : null;
  // A click can update the DOM anchor before the model's selection observer.
  // Map that current anchor through the supplied view instead of selecting from
  // the previous caret when Shift+End immediately follows a click.
  const anchor = selection?.anchorNode && view.dom.contains(selection.anchorNode)
    ? view.posAtDOM(selection.anchorNode, selection.anchorOffset) : undefined;
  editor.transact(transaction => {
    // A trailing divider/media block has no insertion point. Prefer the last
    // native text position so typing cannot target or replace that block.
    const end = Selection.findFrom(transaction.doc.resolve(transaction.doc.content.size), -1, true)
      ?? Selection.atEnd(transaction.doc);
    transaction.setSelection(extend
      ? TextSelection.between(transaction.doc.resolve(anchor ?? transaction.selection.anchor), end.$head)
      : end).scrollIntoView();
  });
  return true;
}

// BlockNote 0.55's trailing widget is outside its native document. Browser End
// can enter that widget and snap back. Resolve the endpoint in the native model.
export const DocumentEnd = createExtension({
  key: 'scrawlDocumentEnd',
  keyboardShortcuts: {
    'Mod-End': ({ editor }) => documentEnd(editor, false),
    'Mod-Shift-End': ({ editor }) => documentEnd(editor, true),
  },
});
