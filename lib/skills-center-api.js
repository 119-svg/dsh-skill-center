/**
 * skills-center-api.js — 技能中心的宿主本机 HTTP 接口（3 条精确路径）。
 *
 * 注册面：宿主 `webServer.register({ kind:"exact", path, handler })`；handler 两种
 * 形态都吃：
 *   1. `handler(req) => { status, body }`（测试装置与内置适配器用，返回响应对象）；
 *   2. `handler(req, res)`（宿主 node:http 形态，直接写 res）。
 * 两种形态下业务逻辑完全同一份 —— 校验、取数、写盘都发生在返回 / 写回之前。
 *
 * 四道校验顺序固定（先权限后规则）：
 *   来源 403 → 方法 405 → 媒体类型 415 → 入参 400。
 * 任一非法 ⇒ 零副作用（不写盘、不建备份）。响应外壳统一：
 *   `{ ok:true, value }` / `{ ok:false, error:{ code, message } }`。
 *
 * 三条端点读的都是同一份「当前生效值 + 来源标记」，写只有 save 一条通道，
 * 且目标路径由 store 的 `centerPath()` 唯一决定 —— 本文件不接受客户端传任何路径。
 */

import { MODES, RESERVED_GROUP } from "./skills-center-store.js";

/** 端点路径（精确匹配）。 */
export const ROUTE_LIST = "/api/skills-center/list";
export const ROUTE_CONFIG = "/api/skills-center/config";
export const ROUTE_SAVE = "/api/skills-center/save";
export const ROUTES = [ROUTE_LIST, ROUTE_CONFIG, ROUTE_SAVE];

/** 错误码枚举。 */
export const ERR_FORBIDDEN = "FORBIDDEN_ORIGIN";
export const ERR_METHOD = "METHOD_NOT_ALLOWED";
export const ERR_MEDIA = "UNSUPPORTED_MEDIA_TYPE";
export const ERR_INPUT = "INVALID_INPUT";
export const ERR_WRITE = "WRITE_FAILED";

/** 显示模式三枚举（与 store 同源，避免第二处定义）。 */

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 成功外壳。 */
function ok(value) {
  return { ok: true, value };
}

/** 失败外壳。 */
function fail(code, message) {
  return { ok: false, error: { code, message: String(message ?? "") } };
}

/** 响应对象：状态码 + 外壳。 */
function respond(status, body) {
  return { status, body };
}

/** 「视同没有」：非字符串 / 空串 / 全空白。 */
function blank(value) {
  return typeof value !== "string" || value.trim() === "";
}

/** 取客户端来源地址（测试装置的面 / node:http 的面都认）。 */
function remoteAddressOf(req) {
  if (req && typeof req.remoteAddress === "string" && req.remoteAddress !== "") return req.remoteAddress;
  const socketAddress = req && req.socket && typeof req.socket.remoteAddress === "string"
    ? req.socket.remoteAddress
    : "";
  return socketAddress;
}

function isLoopback(req) {
  return LOOPBACK_ADDRESSES.has(remoteAddressOf(req));
}

/** 浏览器请求带 Origin；只接受本机来源（脚本 / 本机 fetch 不带 Origin 时放行）。 */
function originAllowed(req) {
  const headers = (req && req.headers) || {};
  const origin = headers.origin;
  if (origin === undefined || origin === null || String(origin) === "") return true;
  try {
    const host = new URL(String(origin)).hostname;
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

/** Content-Type 必须是 application/json（text/plain 是 CORS 简单请求，必须自己挡）。 */
function mediaAllowed(req) {
  const headers = (req && req.headers) || {};
  const type = String(headers["content-type"] ?? "").toLowerCase();
  return type.includes("application/json");
}

/** 读请求体：优先用已解析的 `body`，其次从可迭代的 node 请求流里读 JSON。 */
async function readBody(req) {
  if (req && Object.prototype.hasOwnProperty.call(req, "body")) return req.body;
  if (!req || typeof req[Symbol.asyncIterator] !== "function") return null;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 显示模式归一到三枚举：非法值回落 profile 配置，profile 再非法回落默认档。 */
function resolveMode(fileMode, profileMode) {
  if (MODES.includes(fileMode)) return { mode: fileMode, modeSource: "file" };
  const fallback = MODES.includes(profileMode) ? profileMode : "names-tag";
  return { mode: fallback, modeSource: "profile" };
}

/** 组序列：文件有效则用文件序，否则用分组草案（含序）。 */
function resolveGroups(fileGroups, draftGroups) {
  if (Array.isArray(fileGroups) && fileGroups.length > 0) {
    const cleaned = [];
    let valid = true;
    for (const item of fileGroups) {
      if (typeof item !== "string" || item.trim() === "" || item.trim() === RESERVED_GROUP) {
        valid = false;
        break;
      }
      cleaned.push(item.trim());
    }
    if (valid && cleaned.length > 0) return { groups: cleaned, groupsSource: "file" };
  }
  const draft = Array.isArray(draftGroups) ? draftGroups.map((item) => String(item)) : [];
  return { groups: draft, groupsSource: "draft" };
}

/**
 * 取宿主技能快照（统一成 [{name, description}]）。
 * 同步 / 异步两种 `snapshot` 都接：宿主面是 async 的，测试装置给的是同步函数。
 */
async function resolveEntries(deps) {
  if (typeof deps.snapshot !== "function") return [];
  let raw;
  try {
    raw = await deps.snapshot();
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry) => entry && typeof entry.name === "string" && entry.name !== "");
}

/**
 * 组装「当前生效值 + 来源标记」（list / config 共用）。
 * 文件坏 / 不存在 ⇒ 各字段按来源链兜底，清单仍全量（值走 tagline 种子 / group 草案 / hidden 默认）。
 */
async function buildSnapshotView(deps) {
  const store = deps.store;
  const file = store.readCenterFile({ homeDir: deps.homeDir, fs: deps.fs });
  const fileStatus = file.status;
  const fileError = fileStatus === "bad" ? String(file.error ?? "数据文件损坏，无法读取。") : null;
  const data = fileStatus === "ok" ? file.data : undefined;
  const fileSettings = data && typeof data.settings === "object" && data.settings ? data.settings : {};
  const fileSkills = data && typeof data.skills === "object" && data.skills ? data.skills : {};

  const { mode, modeSource } = resolveMode(fileSettings.mode, deps.profileMode);
  const { groups, groupsSource } = resolveGroups(fileSettings.groups, deps.draftGroups);

  const entries = await resolveEntries(deps);
  const seedTaglines = deps.seedTaglines && typeof deps.seedTaglines === "object" ? deps.seedTaglines : {};
  const draftSkillGroups =
    deps.draftSkillGroups && typeof deps.draftSkillGroups === "object" ? deps.draftSkillGroups : {};

  const skills = [];
  for (const entry of entries) {
    const name = entry.name;
    const row = Object.prototype.hasOwnProperty.call(fileSkills, name) ? fileSkills[name] : undefined;
    const rowOk = Boolean(row && typeof row === "object" && !Array.isArray(row));

    // tagline：文件（非空）→ 包内种子 → 无
    let tagline = "";
    let taglineSource = "none";
    if (rowOk && !blank(row.tagline)) {
      tagline = row.tagline;
      taglineSource = "file";
    } else if (!blank(seedTaglines[name])) {
      tagline = seedTaglines[name];
      taglineSource = "seed";
    }

    // group：文件（含显式 null）→ 分组草案 → 无
    let group = null;
    let groupSource = "none";
    if (rowOk && Object.prototype.hasOwnProperty.call(row, "group")) {
      group = typeof row.group === "string" ? row.group : null;
      groupSource = "file";
    } else if (typeof draftSkillGroups[name] === "string" && draftSkillGroups[name] !== "") {
      group = draftSkillGroups[name];
      groupSource = "draft";
    }

    // hidden：文件（严格布尔）→ 默认 false
    let hidden = false;
    let hiddenSource = "default";
    if (rowOk && typeof row.hidden === "boolean") {
      hidden = row.hidden;
      hiddenSource = "file";
    }

    skills.push({ name, tagline, taglineSource, group, groupSource, hidden, hiddenSource });
  }

  return { fileStatus, fileError, mode, modeSource, groups, groupsSource, skills };
}

/** 组装 v2 写盘形状：快照内的技能按入参覆盖，快照外的幽灵键原样保留。 */
function buildSaveData(deps, payload, previous) {
  const skills = {};
  for (const row of payload.skills) {
    skills[row.name] = {
      tagline: typeof row.tagline === "string" ? row.tagline : "",
      group: typeof row.group === "string" ? row.group : null,
      hidden: row.hidden === true,
    };
  }
  // 幽灵键（手编残留）不猜意图、不静默删除：原样保留值
  const known = new Set(payload.skills.map((row) => row.name));
  const previousSkills =
    previous && previous.status === "ok" && previous.data && typeof previous.data.skills === "object" && previous.data.skills
      ? previous.data.skills
      : {};
  for (const [name, row] of Object.entries(previousSkills)) {
    if (known.has(name)) continue;
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    skills[name] = {
      tagline: typeof row.tagline === "string" ? row.tagline : "",
      group: typeof row.group === "string" ? row.group : null,
      hidden: row.hidden === true,
    };
  }
  return {
    version: 2,
    settings: {
      mode: payload.mode,
      groups: payload.groups.map((name) => String(name).trim()),
    },
    skills,
  };
}

/** 读端点 handler（list / config）。 */
async function readHandler(kind, req, deps) {
  if (!isLoopback(req) || !originAllowed(req)) {
    return respond(403, fail(ERR_FORBIDDEN, "仅允许本机来源访问。"));
  }
  if (String((req && req.method) || "").toUpperCase() !== "POST") {
    return respond(405, fail(ERR_METHOD, "仅支持 POST。"));
  }
  if (!mediaAllowed(req)) {
    return respond(415, fail(ERR_MEDIA, "仅接受 application/json。"));
  }
  const body = await readBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return respond(400, fail(ERR_INPUT, "请求体必须是 JSON 对象。"));
  }

  const view = await buildSnapshotView(deps);
  if (kind === "list") {
    return respond(200, ok({
      fileStatus: view.fileStatus,
      fileError: view.fileError,
      mode: view.mode,
      modeSource: view.modeSource,
      groups: view.groups,
      groupsSource: view.groupsSource,
      count: view.skills.length,
      skills: view.skills,
    }));
  }
  return respond(200, ok({
    fileStatus: view.fileStatus,
    fileError: view.fileError,
    mode: view.mode,
    modeSource: view.modeSource,
    groups: view.groups,
    groupsSource: view.groupsSource,
  }));
}

/** 保存 handler：唯一写盘通道。 */
async function saveHandler(req, deps) {
  if (!isLoopback(req) || !originAllowed(req)) {
    return respond(403, fail(ERR_FORBIDDEN, "仅允许本机来源访问。"));
  }
  if (String((req && req.method) || "").toUpperCase() !== "POST") {
    return respond(405, fail(ERR_METHOD, "仅支持 POST。"));
  }
  if (!mediaAllowed(req)) {
    return respond(415, fail(ERR_MEDIA, "仅接受 application/json。"));
  }
  const body = await readBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return respond(400, fail(ERR_INPUT, "请求体必须是 JSON 对象。"));
  }

  const store = deps.store;
  const snapshotNames = (await resolveEntries(deps)).map((entry) => entry.name);

  const checked = store.validateSavePayload(body, snapshotNames);
  if (!checked.ok) {
    return respond(400, fail(ERR_INPUT, checked.error));
  }

  const previous = store.readCenterFile({ homeDir: deps.homeDir, fs: deps.fs });
  const data = buildSaveData(deps, body, previous);
  const written = store.saveCenterFile({
    homeDir: deps.homeDir,
    fs: deps.fs,
    data,
    now: deps.now,
  });
  if (!written.ok) {
    return respond(500, fail(ERR_WRITE, "保存失败：写入数据文件出错。"));
  }

  // 回读 version（写盘成功后文件的 version 值）
  const after = store.readCenterFile({ homeDir: deps.homeDir, fs: deps.fs });
  const version = after.status === "ok" && after.data && typeof after.data.version === "number"
    ? after.data.version
    : 2;
  return respond(200, ok({ version }));
}

/** 把业务响应规整成宿主 node:http 形态（有 res 才写）；否则原样返回。 */
function toHandler(kind, deps) {
  const run = (req) => (kind === "save" ? saveHandler(req, deps) : readHandler(kind, req, deps));
  return async function handler(req, res) {
    const response = await run(req);
    if (res && typeof res.writeHead === "function") {
      const payload = JSON.stringify(response.body);
      res.writeHead(response.status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
      });
      res.end(payload);
      return undefined;
    }
    return response;
  };
}

/**
 * 注册三条精确路径。
 * @param {{register: Function}} webServer 宿主 webServer 面（测试装置给的是收集器）
 * @param {object} deps 见契约 §十一（snapshot / store / seedTaglines / draftGroups /
 *   draftSkillGroups / profileMode / homeDir / fs / now）
 * @returns {void}
 */
export function registerSkillsCenterRoutes(webServer, deps = {}) {
  if (!webServer || typeof webServer.register !== "function") return;
  const routeBody = (kind) => toHandler(kind, deps);
  webServer.register({ kind: "exact", path: ROUTE_LIST, handler: routeBody("list") });
  webServer.register({ kind: "exact", path: ROUTE_CONFIG, handler: routeBody("config") });
  webServer.register({ kind: "exact", path: ROUTE_SAVE, handler: routeBody("save") });
}
