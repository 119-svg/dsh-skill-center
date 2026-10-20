/**
 * semantic.js — 可选的语义检索腿（本地 Ollama embedding），零第三方依赖。
 *
 * 默认关（`semanticEnabled: false`）。开启且宿主不可达时**单次调用内**降级回
 * 纯 BM25：不重试、不等到超时预算之外、不抛错 —— 因为检索是辅助，它坏掉时正确
 * 的行为是「少一路召回」，不是让工具调用失败。
 *
 * 刻意**不落磁盘缓存**：本包的工具是只读面（不写文件、不写会话状态）。embedding
 * 在进程内按 (endpoint, model, text) 缓存，重启即失效 —— 换来的是零副作用。
 */

/** embedding 请求超时（毫秒）。契约常量，不暴露成配置项。 */
export const EMBED_TIMEOUT_MS = 3000;

/** RRF 常数（标准值 60）。 */
export const RRF_K = 60;

const cache = new Map();

function cacheKey(base, model, text) {
  return `${base}\u0000${model}\u0000${text}`;
}

/**
 * 取一段文本的 embedding。
 * @param {string} text
 * @param {{base?: string, model?: string, timeoutMs?: number}} [options]
 * @returns {Promise<number[]|null>} 失败/不可达 ⇒ null（调用方降级）
 */
export async function embedText(text, options = {}) {
  const base = String(options.base || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = String(options.model || "bge-m3");
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : EMBED_TIMEOUT_MS;
  const input = String(text ?? "");
  if (!input) return null;

  const key = cacheKey(base, model, input);
  if (cache.has(key)) return cache.get(key);

  try {
    const res = await fetch(`${base}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok) return null;
    const body = await res.json();
    const vector = body && Array.isArray(body.embedding) ? body.embedding.map(Number) : null;
    if (!vector || vector.length === 0 || vector.some((v) => !Number.isFinite(v))) return null;
    cache.set(key, vector);
    return vector;
  } catch {
    return null; // 不可达 / 超时 / 形状不符：静默降级
  }
}

/**
 * 余弦相似度。
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 语义腿：给候选 doc 逐个打语义分并排序。任一环节不可用 ⇒ null（降级）。
 * @param {Array<{id: string, text: string}>} docs
 * @param {string} query
 * @param {{base?: string, model?: string, timeoutMs?: number}} [options]
 * @returns {Promise<Array<{id: string, score: number}>|null>}
 */
export async function semanticRank(docs, query, options = {}) {
  const q = await embedText(query, options);
  if (!q) return null;

  const scored = [];
  for (const doc of Array.isArray(docs) ? docs : []) {
    const vector = await embedText(doc.text, options);
    if (!vector) continue;
    scored.push({ id: doc.id, score: cosine(q, vector) });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored;
}

/**
 * Reciprocal Rank Fusion：把语义排名折成一个小的加成，叠加在 BM25 分之上。
 * 只用它做「多一路召回」，不动 BM25 的量级，所以别名加成仍然绝对优先。
 * @param {string[]} semanticOrder 语义排序（名字，最前最高）
 * @returns {Map<string, number>}
 */
export function semanticBonus(semanticOrder) {
  const bonus = new Map();
  const order = Array.isArray(semanticOrder) ? semanticOrder : [];
  for (let i = 0; i < order.length; i += 1) {
    if (!bonus.has(order[i])) bonus.set(order[i], 1 / (RRF_K + i + 1));
  }
  return bonus;
}
