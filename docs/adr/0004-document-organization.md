# Same-space document organization

Documents can parent other documents within their space, while the space remains the permission boundary and readable URLs stay independent of position. Parent changes update the document lock version without creating a content revision or altering live state, attachments or selected publication grants. Existing documents remain roots.

Archive is explicit and affects one document: active children block archiving their parent, and an archived parent blocks creating or reactivating a child. This avoids cascading revisions/publications or making active children unreachable. A hierarchy has at most 32 levels; core operations serialize structural changes under the existing exclusive space lock and reject cycles and cross-space parents.
