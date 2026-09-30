# Scrawl domain terms

A **document** is the stable identity and space membership of a page. Its **current revision** is its selected immutable title and native BlockNote content snapshot. A **revision** is a numbered, authored snapshot; restore appends another revision.

A **local draft** is unsaved title and body held only in one browser tab. A **baseline** is the snapshot that draft was loaded from or last saved against. **Discard changes** resets that local draft to its baseline, without writing a revision.

A **live document** is the future shared editing state, distinct from revision history. A **checkpoint** captures that state as an immutable revision. **Synced** will describe shared-state persistence; **saved revision** will describe a checkpoint.

A **publication** exposes an explicitly selected immutable revision. It never follows a local draft, the current private head, or a live document automatically.

An **attachment** is an immutable file owned by one document. A **revision attachment reference** records that a saved snapshot uses it; current removal does not erase older references. A **publication attachment** is that same file exposed only through a valid grant whose selected revision references it.

A **lock version** guards a document mutation. A **revision number** counts saved content snapshots. An **availability version** invalidates publication approval after archive. They are separate counters; publishing and lifecycle changes do not create content revisions.

A **search result** describes the current saved, non-archived head visible under current access grants. Search is derived state, never a private draft or historical revision lookup.
