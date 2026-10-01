// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { createContext, useContext, useState } from 'react';
import { ComponentsContext, FloatingComposerController, FloatingThreadController, ThreadsSidebar, type ComponentProps } from '@blocknote/react';
import { components as supplied } from '@blocknote/shadcn';

const Authority = createContext({ writable: false, failed: () => {}, succeeded: () => {} });

function CommentEditor(props: ComponentProps['Comments']['Editor']) {
  const { writable, failed, succeeded } = useContext(Authority);
  return <div onKeyDownCapture={event => {
    // Catch the supplied async submit command, including keyboard failures.
    // Formatting, content editing and submission remain library operations.
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing
      || event.nativeEvent.keyCode === 229 || props.editor.prosemirrorView?.composing) return;
    event.preventDefault(); event.stopPropagation();
    if (writable && props.editable && !event.repeat) {
      // This pinned factory's optional shortcut conflicts with its generic
      // declaration. Narrow the named public command instead of casting it.
      const command = props.editor.getExtension('commentEditorSubmit');
      if (command && 'submit' in command && typeof command.submit === 'function') {
        const submit = command.submit;
        void Promise.resolve().then(() => submit()).then(succeeded).catch(failed);
      } else failed();
    }
  }}><supplied.Comments.Editor {...props} editable={props.editable && writable} /></div>;
}
function CommentAction(props: ComponentProps['Generic']['Toolbar']['Button']) {
  const { writable, failed, succeeded } = useContext(Authority);
  return <supplied.Generic.Toolbar.Button {...props} isDisabled={props.isDisabled || !writable}
    onClick={async event => { try { await props.onClick?.(event); succeeded(); } catch { failed(); } }} />;
}
// The pinned sidebar exposes a reply composer on thread focus, even for a
// reader. Guard that supplied component; core authorization remains decisive.
const components = { ...supplied, Comments: { ...supplied.Comments, Editor: CommentEditor },
  Generic: { ...supplied.Generic, Toolbar: { ...supplied.Generic.Toolbar, Button: CommentAction } } };

export function PrivateComments({ writable }: { writable: boolean }) {
  const [error, setError] = useState(false);
  return <Authority.Provider value={{ writable, failed: () => setError(true), succeeded: () => setError(false) }}><ComponentsContext.Provider value={components}>
    <FloatingComposerController /><FloatingThreadController />
    {error && <p className="notice" role="alert">The comment action did not finish. Any pending text remains in the composer. Check your connection and access before trying again.</p>}
    <details className="document-comments"><summary>Comments</summary><ThreadsSidebar filter="all" sort="position" /></details>
  </ComponentsContext.Provider></Authority.Provider>;
}
