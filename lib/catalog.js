/**
 * catalog.js — 识别宿主的技能目录消息并就地改写它的 `content[0].text`。
 *
 * 红线（三条都在这一个文件里落地）：
 *   1. `source.entries` 原样不动 —— 它是宿主重发判据 digest 的输入。改了它 ⇒
 *      宿主每轮都判「集合变了」⇒ 目录无限重发、缓存前缀持续失效。本文件只换
 *      `content[0].text`，`source` 对象原引用透传。
 *   2. 不按 query 动态改渲染 —— 渲染函数只吃 entries + 配置 + 只读覆盖文件。
 *   3. fail-through —— 任何异常（形状不符、条目畸形、宿主对象 getter 抛错）都
 *      **原样放行**、返回输入 decision 的**同一引用**，绝不抛错、绝不阻断本轮。
 *      理由：目录改写是优化，不是功能；它失败时最坏结果是目录长一点，而抛错会
 *      让整轮对话起不来。
 *
 * 改写方式是**原地替换技能行块**，不是重新拼整段文本：宿主在技能行之前之后都有
 * 自己的措辞（`<system-reminder>` / `<available_skills>` / 加载指引 / update 表单
 * 的「整体替换」说明）。那些措辞逐字保留，插件只换中间那一段行；引导行追加到整段
 * 文本最后（保证它是末行，同时不动任何宿主措辞）。
 *
 * 全部改写都用 spread 造新对象：宿主的消息是冻结的，任何写入都会抛 TypeError。
 */

import { GUIDE_LINE, renderCatalogText } from "./render.js";

/** 技能行的行前缀（与宿主 renderCatalogMessage 的行格式一致：短横 + 空格 + 反引号）。 */
const SKILL_LINE_PREFIX = "- `";

/**
 * 与宿主同款的可读性校验：entries 必须是数组，且每项都是 `{name, description}`
 * 且 name 非空字符串、description 是字符串；否则整体判为「读不懂」。
 * @param {object|undefined} source
 * @returns {Array<{name: string, description: string}>|undefined}
 */
export function readCatalogEntries(source) {
  const entries = source && typeof source === "object" ? source.entries : undefined;
  if (!Array.isArray(entries)) return undefined;
  const readable = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return undefined;
    const { name, description } = entry;
    if (typeof name !== "string" || name === "") return undefined;
    if (typeof description !== "string") return undefined;
    readable.push({ name, description });
  }
  return readable;
}

/** 是否是本插件要改的那类消息。 */
export function isCatalogMessage(message) {
  if (!message || typeof message !== "object") return false;
  const source = message.source;
  if (!source || typeof source !== "object") return false;
  if (source.kind !== "skill-catalog") return false;
  return readCatalogEntries(source) !== undefined;
}

/**
 * 消息批次里的第一条技能目录消息（没有则 undefined）。
 * @param {Array} messages
 * @returns {object|undefined} 消息本身
 */
export function findCatalogMessage(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (isCatalogMessage(message)) return message;
  }
  return undefined;
}

/**
 * 造一条新消息：身份字段（id / role / source …）全部原样继承，只换正文块。
 * `source` 是同一个引用 ⇒ `entries` 不受影响、digest 恒定。
 * @param {object} message
 * @param {string} text
 * @returns {object}
 */
export function rewriteContent(message, text) {
  const content = Object.freeze([Object.freeze({ ...message.content[0], text })]);
  return Object.freeze({ ...message, content });
}

/**
 * 把渲染结果拼回宿主原文：
 *   - 渲染结果的技能行**替换**原文里第一段连续的技能行；
 *   - 渲染结果的引导行（若末行是它）追加到整段文本**最后**；
 *   - 宿主其余措辞逐字保留、位置不变。
 * @param {string} original 宿主原文
 * @param {string} rendered renderCatalogText 的输出
 * @returns {string}
 */
function spliceCatalogText(original, rendered) {
  const renderedLines = String(rendered).split("\n");
  let guide = null;
  if (renderedLines.length > 0 && renderedLines[renderedLines.length - 1] === GUIDE_LINE) {
    guide = renderedLines.pop();
  }

  const source = String(original).split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i].startsWith(SKILL_LINE_PREFIX)) {
      if (start < 0) start = i;
      end = i;
    } else if (start >= 0) {
      break; // 只换第一段连续区间：宿主的一批技能行是连续的
    }
  }

  let lines;
  if (start >= 0) {
    lines = [...source.slice(0, start), ...renderedLines, ...source.slice(end + 1)];
  } else {
    // 原文里没有技能行（宿主骨架异常）：插到 <available_skills> 之后，找不到就追加
    const anchor = source.findIndex((line) => line.includes("<available_skills>"));
    const at = anchor >= 0 ? anchor + 1 : source.length;
    lines = [...source.slice(0, at), ...renderedLines, ...source.slice(at)];
  }

  if (guide !== null) lines.push(guide);
  return lines.join("\n");
}

/** 正文块是否是可以改写的「单个 text block」。 */
function textBlockOf(message) {
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const first = content[0];
  if (!first || typeof first !== "object" || first.type !== "text") return undefined;
  return typeof first.text === "string" ? first : undefined;
}

/**
 * 改写 decision 里的**每一条**技能目录消息。
 * @param {object} decision pre-step 的最终 decision（`{kind, messages}`）
 * @param {{config?: object, taglines?: object, overrides?: object}} [options]
 * @returns {object} 无可改写内容时返回**输入同一引用**，否则返回新 decision
 */
export function trimDecision(decision, options = {}) {
  try {
    if (!decision || typeof decision !== "object") return decision;
    if (decision.kind !== "enter") return decision;
    if (!Array.isArray(decision.messages)) return decision;
    if (!decision.messages.some((message) => isCatalogMessage(message))) return decision;

    const { config, taglines, overrides } = options || {};
    let changed = false;

    const messages = decision.messages.map((message) => {
      if (!isCatalogMessage(message)) return message; // 非目录消息：引用原样

      const entries = readCatalogEntries(message.source);
      if (!entries || entries.length === 0) return message; // 空目录：宿主说「没有技能」的原话不动

      const first = textBlockOf(message);
      if (!first) return message; // 不是单 text block：不动

      const originalText = first.text;
      const rendered = renderCatalogText({ entries, config, taglines, overrides });
      if (!rendered) return message;

      const text = spliceCatalogText(originalText, rendered);
      if (text === originalText) return message;

      changed = true;
      return rewriteContent(message, text);
    });

    if (!changed) return decision;
    return { ...decision, messages };
  } catch {
    // 任何异常路径（含宿主对象 getter 抛错）都原样放行：绝不抛错出 pre-step
    return decision;
  }
}
