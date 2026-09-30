# Scrawl domain terms

A **document** is the stable identity and space membership of a page. Its **current revision** is its selected immutable title and native BlockNote content snapshot. A **revision** is a numbered, authored snapshot; restore appends another revision.

A **local draft** is unsaved title and body held only in one browser tab. A **baseline** is the snapshot that draft was loaded from or last saved against. **Discard changes** resets that local draft to its baseline, without writing a revision.

A **live document** is the future shared editing state, distinct from revision history. A **checkpoint** captures that state as an immutable revision. **Synced** will describe shared-state persistence; **saved revision** will describe a checkpoint.

A **publication** exposes an explicitly selected immutable revision. It never follows a local draft, the current private head, or a live document automatically.
