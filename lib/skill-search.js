/**
 * skill-search.js — `skill_search` 的检索核（纯函数 + 可选语义腿叠加）。
 *
 * 用途：目录里每条技能只剩「名字 + 短标签」，模型靠短标签选不准时，用一句自然
 * 语言意图换回**真实技能名**，再用宿主的 `skill` 工具按名加载正文。
 *
 * 索引字段只有三个：name + description + aliases。别名表是中文意图命中英文技能
 * 名的最低成本通道（BM25 的 CJK bigram 能处理中文，但「排查」不在
 * `systematic-debugging` 的描述里时就只能靠别名）。别名命中给一个**固定的绝对
 * 加成**，保证别名项整体排在纯 BM25 项之前；BM25 之内再按分数降序、同分按名字
 * 码点升序 —— 全程无随机源、无时间源，同一输入连跑结果全等。
 *
 * 失败面一律收敛成「空结果 + 固定措辞」，绝不抛错：工具坏掉不该让整轮失败。
 */

import { buildIndex, score as bm25Score, tokenize } from "./bm25.js";
import { EMBED_TIMEOUT_MS, semanticBonus, semanticRank } from "./semantic.js";
import { compareCodepoints } from "./select.js";

/** 意图的码点上限；超出部分不参与检索（截断不报错）。 */
export const INTENT_MAX = 2000;

/** 返回条数上限的合法域（闭区间，越界夹取、非整数向零取整）。 */
export const K_MIN = 1;
export const K_MAX = 20;
export const K_DEFAULT = 5;

/** 别名命中的固定加成：必须严格大于任何纯 BM25 命中项。 */
const ALIAS_BONUS = 1000;

/** 空结果的固定措辞（不编造任何技能名）。 */
export const EMPTY_SEARCH_TEXT = "No matching skill. See the skill catalog in this session for the full list.";

/** k 归一：非有限值给默认值，再向零取整、夹取到 [1, 20]。 */
export function normalizeK(k) {
  const n = Number(k);
  const base = Number.isFinite(n) ? Math.trunc(n) : K_DEFAULT;
  if (base < K_MIN) return K_MIN;
  if (base > K_MAX) return K_MAX;
  return base;
}

/** 意图按码点截断到上限。 */
export function truncateIntent(intent) {
  const text = typeof intent === "string" ? intent : "";
  const chars = [...text];
  if (chars.length <= INTENT_MAX) return { text, truncated: false };
  return { text: chars.slice(0, INTENT_MAX).join(""), truncated: true };
}

/** 收成 `{name, description}` 表；畸形项丢弃（不抛错）。 */
function readablePool(skills) {
  if (!Array.isArray(skills)) return [];
  const out = [];
  for (const skill of skills) {
    if (!skill || typeof skill !== "object") continue;
    if (typeof skill.name !== "string" || skill.name === "") continue;
    out.push({ name: skill.name, description: typeof skill.description === "string" ? skill.description : "" });
  }
  return out;
}

/** BM25 文档语料：name + description + 该技能的别名词。 */
function buildDocs(pool, aliases) {
  return pool.map((skill) => {
    const words = aliases && Array.isArray(aliases[skill.name]) ? aliases[skill.name] : [];
    const aliasText = words.map((word) => String(word)).filter(Boolean).join(" ");
    return { id: skill.name, text: `${skill.name} ${skill.description} ${aliasText}` };
  });
}

/** 别名命中：意图里出现了该技能的任一别名词。 */
function aliasHit(aliases, name, intentLower) {
  const words = aliases && Array.isArray(aliases[name]) ? aliases[name] : [];
  for (const word of words) {
    const needle = String(word ?? "").toLowerCase();
    if (needle && intentLower.includes(needle)) return true;
  }
  return false;
}

/** BM25 打分：与 bm25.js 的 search 同一公式，但保留分数（排序要用）。 */
function bm25Scores(index, query) {
  const scores = new Map();
  const terms = tokenize(query);
  if (terms.length === 0) return scores;

  const queryIdf = new Map();
  for (const term of terms) {
    const df = index.df.get(term) || 0;
    // BM25+ 式：log 里 +1，未登录词也拿正 IDF
    queryIdf.set(term, Math.log((index.n - df + 0.5) / (df + 0.5) + 1));
  }

  for (let i = 0; i < index.n; i += 1) {
    const value = bm25Score(index.docTokens[i], queryIdf, index.n, index.avgdl);
    if (value > 0) scores.set(i, value);
  }
  return scores;
}

/** 命中项的说明文本。 */
function hitsText(items) {
  return items
    .map((item, idx) => `${idx + 1}. \`${item.name}\` — matchedBy=${item.matchedBy}, score=${item.score}`)
    .join("\n");
}

function emptyResult(intentTruncated) {
  return { items: [], count: 0, intentTruncated, text: EMPTY_SEARCH_TEXT };
}

/**
 * 按意图检索技能。
 * @param {{
 *   skills?: Array<{name: string, description?: string}>,
 *   intent?: string,
 *   k?: number,
 *   aliases?: Record<string, string[]>,
 *   semanticEnabled?: boolean,
 *   ollamaBase?: string,
 *   embedModel?: string
 * }} [input]
 * @returns {Promise<{items: Array<{name: string, score: number, matchedBy: string}>, count: number,
 *   intentTruncated: boolean, text: string}>}
 */
export async function searchSkills(input = {}) {
  const truncatedIntent = truncateIntent(input && input.intent);
  const intentTruncated = truncatedIntent.truncated;
  const raw = truncatedIntent.text;
  const trimmed = raw.trim();

  try {
    if (!trimmed) return emptyResult(intentTruncated);

    const pool = readablePool(input && input.skills);
    if (pool.length === 0) return emptyResult(intentTruncated);

    const aliases = input && input.aliases && typeof input.aliases === "object" ? input.aliases : {};
    const docs = buildDocs(pool, aliases);
    const index = buildIndex(docs);
    const bm25 = bm25Scores(index, raw);

    // 逐技能合并：BM25 分 + 别名加成（别名命中即使 BM25 为 0 也要进候选）
    const intentLower = raw.toLowerCase();
    const merged = new Map();
    for (const [docIndex, value] of bm25) {
      const skill = pool[docIndex];
      merged.set(skill.name, { name: skill.name, score: value, matchedBy: "bm25" });
    }
    for (const skill of pool) {
      if (!aliasHit(aliases, skill.name, intentLower)) continue;
      const current = merged.get(skill.name);
      merged.set(skill.name, {
        name: skill.name,
        score: (current ? current.score : 0) + ALIAS_BONUS,
        matchedBy: "alias",
      });
    }

    // 语义腿（默认关）：只在真的取到 embedding 时叠加，失败即当没开过
    if (input && input.semanticEnabled === true && merged.size > 0) {
      try {
        const ranked = await semanticRank(docs, raw, {
          base: input.ollamaBase,
          model: input.embedModel,
          timeoutMs: EMBED_TIMEOUT_MS,
        });
        if (ranked && ranked.length > 0) {
          const bonus = semanticBonus(ranked.map((row) => row.id));
          for (const [name, value] of bonus) {
            const current = merged.get(name);
            if (current) current.score += value;
          }
        }
      } catch {
        /* 语义腿坏掉：退化成纯 BM25，结果与未开时相同 */
      }
    }

    const k = normalizeK(input && input.k);
    const items = [...merged.values()]
      .sort((a, b) => b.score - a.score || compareCodepoints(a.name, b.name))
      .slice(0, k)
      .map((item) => ({ name: item.name, score: item.score, matchedBy: item.matchedBy }));

    if (items.length === 0) return emptyResult(intentTruncated);
    return { items, count: items.length, intentTruncated, text: hitsText(items) };
  } catch {
    return emptyResult(intentTruncated);
  }
}
