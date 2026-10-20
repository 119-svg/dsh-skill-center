/**
 * select.js — 目录行集合与顺序（纯函数，零宿主依赖）。
 *
 * 本包不再有 deny / topK / footer 那套「选择」机制：行集合 = 宿主快照减去
 * `hidden:true` 的技能，一条不少（那是压缩的反面：模型必须看到全量名字）。
 * 这里只做两件事：
 *
 *   1. 剔除：`~/.dsh/skills-center.json` 里 `skills.<name>.hidden === true`。
 *      hidden 只认严格 true；未声明 / false / 非布尔一律照常出现。没有该文件
 *      ⇒ 差集为空 ⇒ 一行不少（fail-soft，绝不因为读不到配置就少给技能）。
 *   2. 排序：core 名单按**配置顺序**排最前（名单里在快照中不存在的名字静默
 *      跳过、不占行）；其余按 name 的**码点序**升序。禁用 localeCompare —— 它
 *      受 ICU / locale 影响，会让「桌面与真机」渲染出不同顺序，进而让目录文本
 *      在换环境时字节变化（缓存前缀失效）。
 *
 * 顺序只依赖 (entries, config.core, overrides)，与用户 query、时间、随机源、
 * 环境变量、当前工作目录全无关：同一集合重复渲染字节相同。
 */

/** 取 `overrides.skills` 对象；非对象时给空表（容错，不抛错）。 */
function skillsTable(overrides) {
  const skills = overrides && typeof overrides === "object" ? overrides.skills : undefined;
  return skills && typeof skills === "object" ? skills : null;
}

/** 该技能是否被用户显式隐藏（`hidden:true`）。 */
export function isHidden(overrides, name) {
  const table = skillsTable(overrides);
  if (!table) return false;
  const row = table[name];
  return Boolean(row && typeof row === "object" && row.hidden === true);
}

/**
 * 按码点比较两个名字。
 * @param {string} a
 * @param {string} b
 * @returns {number} <0 / 0 / >0
 */
function compareCodepoints(a, b) {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** 把任意输入收成「name/description 都是字符串」的条目表；畸形项丢弃。 */
function readableEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const name = entry.name;
    if (typeof name !== "string" || name === "") continue;
    const description = typeof entry.description === "string" ? entry.description : "";
    out.push({ name, description });
  }
  return out;
}

/** core 名单：去空、去重前的配置顺序（保留重复以便去重时按先到者胜）。 */
function coreOrder(config) {
  const core = config && Array.isArray(config.core) ? config.core : [];
  return core.map((name) => String(name).trim()).filter(Boolean);
}

/**
 * 行集合与顺序。
 * @param {{entries?: Array, config?: object, overrides?: object}} input
 * @returns {Array<{name: string, description: string}>}
 */
export function selectSkills(input = {}) {
  const { entries, config, overrides } = input || {};
  const source = readableEntries(entries).filter((entry) => !isHidden(overrides, entry.name));

  const order = coreOrder(config);
  const picked = new Set();
  const core = [];
  for (const name of order) {
    if (picked.has(name)) continue;
    const hit = source.find((entry) => entry.name === name);
    if (!hit) continue; // 名单里但快照没有：静默跳过、不占行
    core.push(hit);
    picked.add(name);
  }

  const rest = source
    .filter((entry) => !picked.has(entry.name))
    .sort((a, b) => compareCodepoints(a.name, b.name));

  return [...core, ...rest];
}

export { compareCodepoints };
