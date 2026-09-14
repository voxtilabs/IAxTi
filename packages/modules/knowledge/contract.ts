// Única puerta pública del módulo knowledge (SPEC §26).
export const MODULE_ID = 'knowledge' as const;
export {
  addSource,
  processSource,
  listSources,
  deleteSource,
  expireSources,
  tenantsWithExpirable,
  parseCatalog,
} from './application/sources';
export type { Source, SourceKind, AddSourceInput, ProcessPorts } from './application/sources';
export { searchKnowledge, getProduct, knowledgeContext } from './application/search';
export type { KnowledgeHit, KnowledgeResult, ProductHit } from './application/search';
export {
  googleEmbedPort,
  geminiPdfTextPort,
  embeddingsAvailable,
} from './application/embeddings';
export type { EmbedPort, PdfTextPort, UrlTextPort } from './application/embeddings';
export { splitIntoChunks, stripHtml, hashQuery } from './domain/chunking';
