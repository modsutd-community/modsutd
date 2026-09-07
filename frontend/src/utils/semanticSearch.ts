// Tier-2 semantic search. Stubbed today.
//
// Tier-1 (live, in `search.ts`) handles "10.013", "modelling", "calc" → calculus
// via MiniSearch + a small synonym map. It misses semantic queries like
// "courses about climate change" or "machine learning related stuff".
//
// Tier-2 plan:
// 1. At build time, embed every mod's description with a small text-embedding
//    model (~384 dims). Bundle the embeddings as a typed-array shipped with
//    the data manifest.
// 2. At query time, embed the query and cosine-rank against the bundled
//    vectors. Return the top-K, then merge with Tier-1 results.
//
// Two viable embedding models for browser-shipped use:
//   - `Xenova/all-MiniLM-L6-v2` via @xenova/transformers (ONNX in browser,
//     ~25 MB one-time download, runs entirely client-side, free).
//   - HuggingFace Inference API with `BAAI/bge-small-en-v1.5` (free tier,
//     ~10 ms / query when cached, requires HF_TOKEN env var).
//
// For ~1k mods, naive cosine over 1k × 384 floats is ~3 ms in the main
// thread. No need for FAISS, no need for a worker.
//
// What's NOT done yet:
//   - The build step that generates `/data/embeddings.f32.bin`. Owner: scraper.
//   - The browser-side query embedding (needs the chosen path above wired up).
//   - The merge-with-Tier-1 ranking heuristic.

import type { Mod } from '@/types';

// TODO(user): wire one of:
//   - VITE_EMBEDDINGS_MODE=local   → bundle @xenova/transformers
//   - VITE_EMBEDDINGS_MODE=hf      → require VITE_HF_TOKEN
// And run `tools/scraper/agents/embed.py` (also TODO) to produce
// /data/embeddings.f32.bin.

const ENABLED = false;

export interface SemanticHit {
  code: string;
  similarity: number;
}

export async function semanticSearch(_query: string, _mods: Mod[]): Promise<SemanticHit[]> {
  if (!ENABLED) return [];
  // Plug-and-play target shape:
  //   const queryVec = await embed(_query);
  //   const corpus   = await loadCorpusVectors();
  //   return topK(cosine(queryVec, corpus), 8);
  return [];
}

export function isSemanticSearchEnabled(): boolean { return ENABLED; }
