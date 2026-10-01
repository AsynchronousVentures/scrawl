# Same-space document organization

Documents can parent other documents within their space, while the space remains the permission boundary and readable URLs stay independent of position. Parent changes update the document lock version without creating a content revision or altering live state, attachments or selected publication grants. Existing documents remain roots.

Archive is explicit and affects one document: active children block archiving their parent, and an archived parent blocks creating or reactivating a child. This avoids cascading revisions/publications or making active children unreachable. A hierarchy has at most 32 levels; core operations serialize structural changes under the existing exclusive space lock and reject cycles and cross-space parents.

The connected client builds its selected-space tree from the complete authorized metadata index, fetched through the existing 100-item cursor pages. It downloads no document bodies for navigation and commits the index only after all pages succeed. Request generations prevent responses from another space replacing the current navigation. Archived metadata supplies breadcrumb context while the visible archive filter remains explicit. Very large spaces still require performance measurement; this implementation does not introduce a separate tree API or virtualized navigation.

Navigation uses native nested lists, links and disclosure buttons, rather than an ARIA tree with partially implemented arrow-key behavior. Indentation stops growing after six levels so deeper documents cannot force horizontal overflow. Structural responses update metadata without reinitializing BlockNote or discarding peer edits. Local unsaved work disables moves; stale or uncertain writes require deliberate comparison.
