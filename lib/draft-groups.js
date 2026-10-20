/**
 * draft-groups.js — 分组草案的读取器（只读）。
 *
 * 草案 = 面板打开时的组序与技能归组**回退初值**（数据文件无效时才用它）。
 * 它**不是**数据：面板任意操作都不改写它，只有保存端点才落盘。
 *
 * 归属：草案本身是产品决策（哪 8 组、58 条技能怎么归组），落在
 * `lib/skill-groups.json`（与 `taglines.json` 同构的只读资源）；本文件只负责把
 * 它读成两个面：组序 `groups` 与 `skills[<name>] = 组名`。
 *
 * 读失败 / 形状不符 ⇒ 返回空面（面板退到「无分组」而不是打不开）——草案缺失只
 * 该少一层回退，不该让整块面板不可用。本模块**不被渲染层引用**：分组对模型
 * 目录零消费，渲染读侧不得出现任何分组输入。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 草案资源路径。 */
const DRAFT_URL = new URL("./skill-groups.json", import.meta.url);

/** 空面（读失败时的唯一回落值）。 */
const EMPTY = { groups: [], skillGroups: {} };

let cache = null;

/**
 * 读分组草案。
 * @returns {{groups: string[], skillGroups: Record<string, string>}}
 */
export function readDraftGroups() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(fileURLToPath(DRAFT_URL), "utf8"));
    const groups = Array.isArray(parsed && parsed.groups)
      ? parsed.groups.filter((name) => typeof name === "string" && name.trim() !== "")
      : [];
    const skillGroups = {};
    const raw = parsed && typeof parsed.skills === "object" && parsed.skills ? parsed.skills : {};
    for (const [name, group] of Object.entries(raw)) {
      if (typeof group === "string" && group.trim() !== "") skillGroups[name] = group;
    }
    cache = { groups, skillGroups };
    return cache;
  } catch {
    cache = EMPTY;
    return cache;
  }
}
