// Única puerta pública del módulo knowledge (SPEC §26).
export const MODULE_ID = 'knowledge' as const;
// Leer markdown como fuente (#714): escribir donde sea y traerlo.
//
// `enlacesDe` NO se exporta: la usa `fuenteDesdeMarkdown` acá adentro y nadie
// más. La publiqué por costumbre y el trinquete de #664 la cazó en el CI del
// mismo PR —segunda vez en dos días—. Un contrato que expone lo que nadie abre
// deja de ser una decisión.
export { fuenteDesdeMarkdown } from './domain/markdown';
export type { ArchivoMarkdown, FuenteDesdeMarkdown } from './domain/markdown';
export {
  addSource,
  processSource,
  listSources,
  deleteSource,
  expireSources,
  tenantsWithExpirable,
  reindexarPendientes,
  hayQueReindexar,
  parseCatalog,
} from './application/sources';
export type {
  Source,
  SourceKind,
  SourceLink,
  AddSourceInput,
  ProcessPorts,
  Reindexacion,
} from './application/sources';
// `marcarFuentesUsadas` NO se exporta (#714): la llama `searchKnowledge` acá
// adentro y nadie más debe poder llamarla. Si el copiloto pudiera marcar uso por
// su cuenta, el contador diría «esta fuente respaldó una respuesta» sin que
// ninguna respuesta se haya apoyado en ella.
export { searchKnowledge, getProduct, knowledgeContext, fuentesCitadas } from './application/search';
export type { KnowledgeHit, KnowledgeResult, ProductHit } from './application/search';
export {
  googleEmbedPort,
  nvidiaEmbedPort,
  DIMENSIONES,
  geminiPdfTextPort,
  embeddingsAvailable,
} from './application/embeddings';
export type { EmbedPort, PdfTextPort, UrlTextPort, RolDelTexto } from './application/embeddings';
export { splitIntoChunks, stripHtml, hashQuery } from './domain/chunking';
