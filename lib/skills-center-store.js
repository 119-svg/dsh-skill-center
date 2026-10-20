/**
 * skills-center-store.js — 数据文件 `~/.dsh/skills-center.json` 的读写 / 校验 / 坏件备份。
 *
 * 本模块是**纯函数面**：所有 fs 操作走入参注入的 `fs` 子集，home 目录显式传参，
 * 不读 `os.homedir()`、不缓存、不产生模块级状态。两个后果：
 *   1. 单测可以注假 home + 假 fs，任何用例都不会碰到真实 `~/.dsh/skills-center.json`；
 *   2. 「写盘只认一个路径」这条成为结构事实 —— 本文件里只有 `centerPath()` 产出的
 *      那一个目标路径，没有第二个可写路径（备份文件与临时文件都由它派生）。
 *
 * 写盘顺序 = 读旧件 → （坏件先备份）→ 序列化往返校验 → 写同目录临时文件 →
 * 原子 rename。任何一步失败都返回 `{ ok:false, error:"WRITE_FAILED" }`，此时目标
 * 文件保持旧内容：rename 未发生 ⇒ 旧件逐字节不变，也不会留下半截 JSON。
 *
 * 坏件备份命名 `skills-center.json.bad-<epoch 毫秒>`：一次保存至多新增 1 份，
 * 旧备份永不删除、永不改名（同名冲突只会发生在一个毫秒内连发两次保存，
 * 此时用递增后缀避让，仍不覆盖已有备份）。
 */

import { dirname, join } from "node:path";

/** 写盘目标文件名（`~/.dsh/` 下）。 */
export const CENTER_FILE_NAME = "skills-center.json";

/** 坏件备份前缀（后接 epoch 毫秒）。 */
export const BAD_BACKUP_PREFIX = `${CENTER_FILE_NAME}.bad-`;

/** 显示模式三枚举（大小写敏感）。 */
export const MODES = ["names-tag", "names", "desc"];

/** 保留组名：由 `group:null` 派生，永不写入 `settings.groups`。 */
export const RESERVED_GROUP = "未分组";

/** 组名码点上限。 */
export const GROUP_NAME_MAX = 20;

/** 入参里出现即拒绝的路径类字段（不接受任意路径）。 */
export const PATH_FIELDS = ["path", "dir", "file", "filePath", "target"];

/** 写盘失败错误码。 */
export const WRITE_FAILED = "WRITE_FAILED";

/** 数据文件路径：`join(homeDir, ".dsh", "skills-center.json")`。 */
export function centerPath(homeDir) {
  return join(String(homeDir ?? ""), ".dsh", CENTER_FILE_NAME);
}

/** 「视同没有」：非字符串 / 空串 / 全空白。 */
function blank(value) {
  return typeof value !== "string" || value.trim() === "";
}

/** 码点数（不是 UTF-16 长度）。 */
function codepointLength(value) {
  return [...String(value ?? "")].length;
}

/**
 * 文本 → 数据对象。成功且根为对象才 ok；空串 / 非法 JSON / 根非对象一律 bad。
 * @param {string} text
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
export function parseCenterText(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: "数据文件损坏：内容为空，无法读取。" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "数据文件损坏：内容不是合法 JSON，无法读取。" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "数据文件损坏：根不是对象，无法读取。" };
  }
  return { ok: true, data: parsed };
}

/**
 * 读数据文件。status = "ok" | "missing" | "bad"；bad 时给中文人话摘要。
 * 这里的 bad 只做**读侧形状**判定；`skills` 非对象也算坏件（形状归一不了）。
 * @param {{homeDir: string, fs: object}} input
 * @returns {{status: string, data?: object, error?: string}}
 */
export function readCenterFile(input = {}) {
  const { homeDir, fs } = input;
  const file = centerPath(homeDir);
  if (!fs || typeof fs.existsSync !== "function") {
    return { status: "bad", error: "数据文件无法读取：缺少文件系统访问面。" };
  }
  let exists = false;
  try {
    exists = fs.existsSync(file) === true;
  } catch {
    return { status: "bad", error: "数据文件无法读取：读取文件状态失败。" };
  }
  if (!exists) return { status: "missing" };

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { status: "bad", error: `数据文件无法读取：${String((error && error.message) || error)}` };
  }
  const parsed = parseCenterText(typeof text === "string" ? text : String(text));
  if (!parsed.ok) return { status: "bad", error: parsed.error };

  const skills = parsed.data.skills;
  if (skills !== undefined && (!skills || typeof skills !== "object" || Array.isArray(skills))) {
    return { status: "bad", error: "数据文件损坏：技能表不是对象，无法读取。" };
  }
  return { status: "ok", data: parsed.data };
}

/**
 * 组名校验：去首尾空白后 1~20 码点、非空、不与 `groups` 重名、非保留名。
 * @param {unknown} name    待校验组名（未剥离空白）
 * @param {string[]} groups 已有组名（调用方决定「已有」的范围）
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function validateGroupName(name, groups) {
  if (typeof name !== "string") {
    return { ok: false, error: "分组名必须是字符串。" };
  }
  const value = name.trim();
  const length = codepointLength(value);
  if (length < 1) return { ok: false, error: "分组名不能为空。" };
  if (length > GROUP_NAME_MAX) return { ok: false, error: `分组名不能超过 ${GROUP_NAME_MAX} 个字。` };
  if (value === RESERVED_GROUP) {
    return { ok: false, error: "「未分组」是保留名称，不能用作分组名。" };
  }
  const existing = Array.isArray(groups) ? groups : [];
  if (existing.some((item) => typeof item === "string" && item.trim() === value)) {
    return { ok: false, error: `已存在同名分组「${value}」，请换一个名字。` };
  }
  return { ok: true, value };
}

/** 入参里是否出现任何非空的路径类字段。 */
function hasPathField(payload) {
  for (const field of PATH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const value = payload[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return true;
  }
  return false;
}

/**
 * 保存入参校验（全量语义）。
 * @param {object} payload        E-SAVE 入参
 * @param {string[]} snapshotNames 宿主快照里的技能名（条数 + 成员判据）
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateSavePayload(payload, snapshotNames) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "请求体必须是 JSON 对象。" };
  }
  if (hasPathField(payload)) {
    return { ok: false, error: "不接受任何路径类字段。" };
  }
  if (typeof payload.mode !== "string" || !MODES.includes(payload.mode)) {
    return { ok: false, error: `显示模式必须是 ${MODES.join(" / ")} 之一。` };
  }
  if (!Array.isArray(payload.groups)) {
    return { ok: false, error: "groups 必须是字符串数组。" };
  }
  const seen = [];
  for (const raw of payload.groups) {
    const checked = validateGroupName(raw, seen);
    if (!checked.ok) return { ok: false, error: checked.error };
    seen.push(checked.value);
  }

  const names = Array.isArray(snapshotNames) ? snapshotNames : [];
  if (!Array.isArray(payload.skills)) {
    return { ok: false, error: "skills 必须是数组。" };
  }
  if (payload.skills.length !== names.length) {
    return { ok: false, error: "skills 条数必须等于技能快照条数。" };
  }
  const allowed = new Set(names.map((name) => String(name)));
  const met = new Set();
  for (const row of payload.skills) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, error: "skills 的每一项必须是对象。" };
    }
    const name = row.name;
    if (typeof name !== "string" || !allowed.has(name)) {
      return { ok: false, error: `技能名不在快照内：${String(name)}` };
    }
    if (met.has(name)) {
      return { ok: false, error: `技能名重复：${name}` };
    }
    met.add(name);
    if (row.tagline !== undefined && row.tagline !== null && typeof row.tagline !== "string") {
      return { ok: false, error: `短标签必须是字符串：${name}` };
    }
    if (row.group !== undefined && row.group !== null && typeof row.group !== "string") {
      return { ok: false, error: `分组必须是字符串或 null：${name}` };
    }
    if (row.hidden !== undefined && typeof row.hidden !== "boolean") {
      return { ok: false, error: `隐藏开关必须是布尔值：${name}` };
    }
    if (row.hidden === undefined) {
      return { ok: false, error: `隐藏开关缺失：${name}` };
    }
  }
  return { ok: true };
}

/** 备份文件名唯一化：同一毫秒内连发保存时用递增后缀避让，绝不覆盖已有备份。 */
function reserveBackupPath(fs, dir, milliseconds) {
  const base = `${BAD_BACKUP_PREFIX}${milliseconds}`;
  let candidate = join(dir, base);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = join(dir, `${base}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

/**
 * 保存数据文件（唯一写盘通道）。
 * @param {{homeDir: string, fs: object, data: object, now?: () => number}} input
 * @returns {{ok: true, backedUp: boolean, backupPath?: string} | {ok: false, error: string}}
 */
export function saveCenterFile(input = {}) {
  const { homeDir, fs, data } = input;
  const clock = typeof input.now === "function" ? input.now : () => Date.now();
  if (!fs || typeof fs.writeFileSync !== "function" || typeof fs.renameSync !== "function") {
    return { ok: false, error: WRITE_FAILED };
  }
  const file = centerPath(homeDir);
  const dir = dirname(file);
  let backedUp = false;
  let backupPath;

  try {
    if (typeof fs.mkdirSync === "function") fs.mkdirSync(dir, { recursive: true });

    // 坏件先备份（一次保存至多 1 份；旧备份不删不改）
    const current = readCenterFile({ homeDir, fs });
    if (current.status === "bad") {
      const raw = fs.readFileSync(file, "utf8");
      const target = reserveBackupPath(fs, dir, Number(clock()));
      fs.writeFileSync(target, raw);
      backedUp = true;
      backupPath = target;
    }

    // 序列化往返校验：写出去的东西必须能被原样解析回来
    const text = `${JSON.stringify(data, null, 2)}\n`;
    const roundtrip = JSON.parse(text);
    if (!roundtrip || typeof roundtrip !== "object" || Array.isArray(roundtrip)) {
      return { ok: false, error: WRITE_FAILED };
    }

    // 同目录临时文件 + 原子 rename：中途失败时目标文件保持旧内容
    const tempPath = `${file}.tmp-${Number(clock())}`;
    fs.writeFileSync(tempPath, text);
    fs.renameSync(tempPath, file);

    const result = { ok: true, backedUp };
    if (backedUp) result.backupPath = backupPath;
    return result;
  } catch {
    return { ok: false, error: WRITE_FAILED };
  }
}
