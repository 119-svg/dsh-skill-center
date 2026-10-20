/**
 * render.js — 目录文本渲染（纯函数 + 两个只读文件降级读取器）。
 *
 * 渲染输入只有三项（红线三）：entries + 配置 + `~/.dsh/skills-center.json`
 * （只读 `skills.<name>.tagline` 与 `skills.<name>.hidden`）。与用户 query、
 * 时间、随机源、环境变量、当前工作目录全无关 —— 三项不变时同一集合重复渲染
 * 字节相同（缓存前缀稳定）。
 *
 * 行形态三档（`catalogMode`）：
 *   names-tag（默认）  `- \`name\`: <短标签>`，标签三级回退
 *                      ① 用户覆盖 → ② 包内种子 → ③ 只留名字（不留 `: ` 空尾巴）
 *   names              `- \`name\``，标签一律不读（含用户覆盖）
 *   desc               `- \`name\`: <描述>`，回到描述档：非 core 按 maxDescLength
 *                      截断、core 不截断；不渲染标签
 *
 * 短标签阈值 40 码点：≤40 逐字原样（不 trim、不归一化、不转义 —— 用户写什么
 * 就显示什么）；>40 取前 37 码点 + `...`，总长恰 40。判定粒度是**码点**不是
 * UTF-16 长度，否则 emoji / 生僻字会被腰斩。
 *
 * 引导行（`skill_search` 提示）与工具**同生同灭**：`toolSearchEnabled=false`
 * 时工具不注册，引导行也必须消失，否则模型会被指到一个不存在的工具。
 *
 * 本文件不含宿主 framing（`<system-reminder>` / `<available_skills>` / 加载
 * 指引）：那些措辞由宿主给出、由 catalog.js 原地保留，插件只换技能行块。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { selectSkills } from "./select.js";

/** 短标签上限（码点）。 */
export const TAGLINE_MAX = 40;

/** 截断后保留的正文字符数（码点）：40 - "..." 的 3。 */
const TAGLINE_KEEP = TAGLINE_MAX - 3;

/** 引导行措辞（逐字节固定，无动态成分）。 */
export const GUIDE_LINE =
  "Uncertain which skill applies? Call `skill_search` with a short intent, then load the match with `skill`.";

/** 按码点切前 n 个（emoji / 代理对安全）。 */
function takeCodepoints(value, n) {
  const chars = [...String(value ?? "")];
  return chars.length <= n ? chars.join("") : chars.slice(0, n).join("");
}

/** 码点数。 */
export function codepointLength(value) {
  return [...String(value ?? "")].length;
}

/** 宿主同款转义（描述档用；短标签按契约「逐字原样」不转义）。 */
function escapeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** 「视同没有」的判定：非字符串 / 空串 / 全空白。 */
function blank(value) {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * 短标签按码点截断：> 40 ⇒ 前 37 + "..."（总长恰 40）。
 * @param {string} tagline
 * @returns {string}
 */
export function truncateTagline(tagline) {
  const text = String(tagline ?? "");
  if (codepointLength(text) <= TAGLINE_MAX) return text;
  return `${takeCodepoints(text, TAGLINE_KEEP)}...`;
}

/**
 * 描述档截断：超过 max 码点 ⇒ 前 max-3 码点 + "..."（总长恰 max）。
 * @param {string} description
 * @param {number} max 已夹取到 [4, 500] 的码点上限
 * @returns {string}
 */
export function truncateDescription(description, max) {
  const text = String(description ?? "");
  if (codepointLength(text) <= max) return text;
  return `${takeCodepoints(text, max - 3)}...`;
}

/** maxDescLength 归一：非整数向零取整、越界夹取到 [4, 500]、坏值回落 120。 */
export function normalizeMaxDescLength(value) {
  const n = Number(value);
  const base = Number.isFinite(n) ? Math.trunc(n) : 120;
  if (base < 4) return 4;
  if (base > 500) return 500;
  return base;
}

/** 用户覆盖表里的 tagline（无则 undefined）。 */
function overrideTagline(overrides, name) {
  const skills = overrides && typeof overrides === "object" ? overrides.skills : undefined;
  if (!skills || typeof skills !== "object") return undefined;
  const row = skills[name];
  if (!row || typeof row !== "object") return undefined;
  return typeof row.tagline === "string" ? row.tagline : undefined;
}

/** 种子表里的 tagline（无则 undefined）。 */
function seedTagline(taglines, name) {
  if (!taglines || typeof taglines !== "object") return undefined;
  const value = taglines[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * 三级回退取短标签：① 用户覆盖 → ② 包内种子 → ③ undefined（只留名字）。
 * @returns {string|undefined}
 */
export function pickTagline(name, taglines, overrides) {
  const user = overrideTagline(overrides, name);
  if (!blank(user)) return user;
  const seed = seedTagline(taglines, name);
  if (!blank(seed)) return seed;
  return undefined;
}

/** 单条技能行。 */
function renderLine(entry, config, taglines, overrides, coreSet, mode) {
  const name = entry.name;
  if (mode === "names") return `- \`${name}\``;

  if (mode === "desc") {
    const max = normalizeMaxDescLength(config?.maxDescLength);
    const core = coreSet.has(name);
    const body = core ? String(entry.description ?? "") : truncateDescription(entry.description, max);
    return `- \`${name}\`: ${escapeText(body)}`;
  }

  // names-tag（默认档）
  const tagline = pickTagline(name, taglines, overrides);
  if (tagline === undefined) return `- \`${name}\``;
  return `- \`${name}\`: ${truncateTagline(tagline)}`;
}

/**
 * 渲染技能行块（+ 可选引导行）。**不含**宿主 framing。
 * @param {{entries?: Array, config?: object, taglines?: object, overrides?: object}} input
 * @returns {string}
 */
export function renderCatalogText(input = {}) {
  const { entries, config, overrides } = input || {};
  const taglines =
    input && input.taglines && typeof input.taglines === "object" ? input.taglines : readSeedTaglines();

  const mode = resolveCatalogMode(config, overrides);
  const core = config && Array.isArray(config.core) ? config.core : [];
  const coreSet = new Set(core.map((name) => String(name).trim()).filter(Boolean));

  const rows = selectSkills({ entries, config, overrides });
  const lines = rows.map((entry) => renderLine(entry, config, taglines, overrides, coreSet, mode));

  if (config?.toolSearchEnabled !== false) lines.push(GUIDE_LINE);
  return lines.join("\n");
}

/** catalogMode 归一：未知值回落默认档。 */
export function normalizeCatalogMode(mode) {
  if (mode === "names" || mode === "desc") return mode;
  return "names-tag";
}

/** 文件里的档位（`settings.mode`）：仅三枚举有效，其余视同没有。 */
function fileCatalogMode(overrides) {
  const settings = overrides && typeof overrides === "object" ? overrides.settings : undefined;
  if (!settings || typeof settings !== "object") return undefined;
  const mode = settings.mode;
  return mode === "names" || mode === "names-tag" || mode === "desc" ? mode : undefined;
}

/**
 * 档位取值：文件 `settings.mode` 优先于 profile 配置 `catalogMode`。
 * 文件值缺失 / 空 / 非枚举 ⇒ 回落配置（配置再非法 ⇒ 默认档），不报错、无告警。
 * @param {object} [config]  插件配置（装载期已归一）
 * @param {object} [overrides] 数据文件内容（只读 `settings.mode` + `skills.*`）
 * @returns {string} 三枚举之一
 */
export function resolveCatalogMode(config, overrides) {
  const fileMode = fileCatalogMode(overrides);
  if (fileMode !== undefined) return fileMode;
  return normalizeCatalogMode(config?.catalogMode);
}

/** 包内种子短标签表的文件路径。 */
const SEED_URL = new URL("./taglines.json", import.meta.url);

let seedCache = null;

/**
 * 读包内种子短标签表 `lib/taglines.json`。
 * 读不到 / 解析失败 / 形状不符 ⇒ 返回 `{}`（不抛错：种子缺失只该让标签退到
 * 「只留名字」，不该让整个目录发布失败）。
 * @returns {Record<string, string>}
 */
export function readSeedTaglines() {
  if (seedCache) return seedCache;
  const table = {};
  try {
    const parsed = JSON.parse(readFileSync(fileURLToPath(SEED_URL), "utf8"));
    const skills = parsed && typeof parsed === "object" ? (parsed.skills ?? parsed) : null;
    if (skills && typeof skills === "object") {
      for (const [name, value] of Object.entries(skills)) {
        if (typeof value === "string") table[name] = value;
      }
    }
  } catch {
    /* 种子缺失/损坏：静默回落到「只留名字」 */
  }
  seedCache = table;
  return table;
}

/** 默认的 `skills-center.json` 路径（不写死绝对路径）。 */
export function defaultCenterPath() {
  return join(homedir(), ".dsh", "skills-center.json");
}

/**
 * 读用户覆盖文件 `~/.dsh/skills-center.json`。
 * 文件缺失 / 空文件 / JSON 解析失败 / 根不是对象 ⇒ 返回 `undefined`，由调用方
 * 全量回落到包内种子（契约的容错口径：静默回落，不抛错、不阻塞目录发布）。
 * @param {string} [filePath] 可注入（单测用假路径）
 * @returns {object|undefined}
 */
export function readCenterSkills(filePath = defaultCenterPath()) {
  try {
    const text = readFileSync(filePath, "utf8");
    if (String(text).trim() === "") return undefined;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
