// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createExtension } from '@blocknote/core';
import { AllSelection } from 'prosemirror-state';

// BlockNote disables Tiptap's core keymap. Bind Select All to the native
// document selection so keyboard input replaces every selected block.
export const SelectAll = createExtension({
  key: 'scrawlSelectAll',
  keyboardShortcuts: {
    'Mod-a': ({ editor }) => {
      if (!editor.isEditable) return false;
      editor.transact(transaction => {
        transaction.setSelection(new AllSelection(transaction.doc));
      });
      return true;
    },
  },
});
