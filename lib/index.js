/**
 * dsh-skill-folder（fork 自 dsh-skill-folder@0.3.4，裁剪适配 DSH 0.2.1）
 *
 * 做的事：把宿主发布的技能目录（catalog 消息）**只改渲染**——每行从「名字 + 全量
 * 描述」压成「名字 + 短标签」，并在末尾加一行 `skill_search` 引导；再注册一个
 * 只读检索工具，让模型在标签不够判别时按一句话意图换回真实技能名。
 *
 * 不做的事（三条红线）：
 *   1. 不禁用 `@deepseek-ai/dsh-tool-skill` —— `skill` 工具与 `/name` 注入仍归宿主；
 *   2. 不改 `source.entries` —— 它是宿主重发判据的输入，改了会引发目录无限重发；
 *   3. 不按用户 query 动态改渲染 —— 渲染只吃 entries + 配置 + 只读覆盖文件。
 *
 * 挂载：`agent/pre-step` 瀑布的**最外层**（`prepend:true`），`await next()` 拿到
 * 最终 decision 之后再改写；从不否决、从不抛错（失败即原样放行）。
 *
 * 宿主依赖：**零**。本文件不静态 import、也不动态 import 任何宿主包：
 *   - 配置归一（默认值 / 夹取 / 丢未知键）是纯 JS，`Config` 外层再挂 Standard
 *     Schema 的 `~standard.validate`（cordis `resolveConfig()` 要它）；
 *   - 工具定义直接产出**标准 JSON Schema** 交 `ctx.tools.register()`，不经
 *     `defineTool` —— 宿主会把 `parameters` 原样发给模型 API，写成扁平 spec
 *     （缺 `type:"object"`）会被服务端判 400，一次坏定义就能打挂整轮请求。
 */

import { homedir } from "node:os";
import * as nodeFs from "node:fs";

import { trimDecision } from "./catalog.js";
import { readDraftGroups } from "./draft-groups.js";
import { readCenterSkills, readSeedTaglines } from "./render.js";
import { isHidden } from "./select.js";
import * as centerStore from "./skills-center-store.js";
import { registerSkillsCenterRoutes } from "./skills-center-api.js";
import { EMPTY_SEARCH_TEXT, searchSkills } from "./skill-search.js";

/** host 端插件名（patch 里的 `id: skill-folder` 与之对应）。 */
export const name = "skill-folder";

/**
 * 恰好四项：读技能快照、注册工具、取工具执行期的 cwd、挂技能中心的本机接口。
 * `webServer` 是技能中心面板取数 / 保存的唯一通道（宿主能力缺失时不注册路由）。
 */
export const inject = ["skills", "tools", "workingDirectory", "webServer"];

/** 检索工具的固定描述。 */
export const TOOL_DESCRIPTION =
  "Search the session skill catalog by intent. Returns matching skill names to load with the skill tool. Read-only.";

/** core 默认名单：三名都是本机真名，按此顺序排在目录最前且不参与截断。 */
export const CORE_DEFAULT = ["verification-before-completion", "systematic-debugging", "using-superpowers"];

/** 别名种子表：键是技能真名，值是意图词（中文意图命中英文技能名的通道）。 */
export const ALIASES_DEFAULT = {
  "systematic-debugging": ["排查", "诊断", "报错", "bug", "debug", "异常", "崩溃"],
  "verification-before-completion": ["验证", "检查完成", "防假完成", "verify", "审查", "评审"],
  "using-superpowers": ["技能目录", "怎么用技能", "superpowers"],
  brainstorming: ["头脑风暴", "想点子", "发散", "创意"],
  "writing-plans": ["写计划", "排计划", "实施计划", "plan"],
  "test-driven-development": ["测试先行", "TDD", "红绿"],
  "dispatching-parallel-agents": ["并行", "派活", "subagent", "委派"],
  "openviking-memory": ["记忆", "回忆", "记住", "memory", "remember"],
};

/** 合法配置键（其余键一律丢弃：残留的旧配置项不该出现在生效面上）。 */
const CONFIG_KEYS = [
  "enabled",
  "catalogMode",
  "core",
  "maxDescLength",
  "toolSearchEnabled",
  "semanticEnabled",
  "aliases",
  "ollamaBase",
  "embedModel",
];

function boolOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function coreOr(value) {
  if (!Array.isArray(value)) return [...CORE_DEFAULT];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function aliasesOr(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...ALIASES_DEFAULT };
  const out = {};
  for (const [key, words] of Object.entries(value)) {
    if (Array.isArray(words)) out[key] = words.map((word) => String(word)).filter(Boolean);
  }
  return out;
}

function modeOr(value) {
  return value === "names" || value === "desc" || value === "names-tag" ? value : "names-tag";
}

/** maxDescLength 归一：非整数向零取整、越界夹取到 [4, 500]、坏值回落 120。 */
function descLengthOr(value) {
  const n = Number(value);
  const base = Number.isFinite(n) ? Math.trunc(n) : 120;
  if (base < 4) return 4;
  if (base > 500) return 500;
  return base;
}

/**
 * 配置归一（装载期发生：补默认值 + 夹取 + 丢弃未知键）。
 * 纯 JS、同步、零宿主依赖 —— 宿主拿到的是同样的结果，测试也能直接调用。
 * @param {object} [raw]
 * @returns {object} 只含契约 9 个键的配置对象
 */
export function normalizeConfig(raw = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const out = {
    enabled: boolOr(input.enabled, true),
    catalogMode: modeOr(input.catalogMode),
    core: coreOr(input.core),
    maxDescLength: descLengthOr(input.maxDescLength),
    toolSearchEnabled: boolOr(input.toolSearchEnabled, true),
    semanticEnabled: boolOr(input.semanticEnabled, false),
    aliases: aliasesOr(input.aliases),
    ollamaBase: stringOr(input.ollamaBase, "http://127.0.0.1:11434"),
    embedModel: stringOr(input.embedModel, "bge-m3"),
  };
  // 只留合法键（显式构造，避免残留键透出）
  const picked = {};
  for (const key of CONFIG_KEYS) picked[key] = out[key];
  return picked;
}

/**
 * 配置校验入口。两种调用形态都要在：
 *   1. **可直调**：`Config(raw)` ⇒ 归一后的配置对象（测试与本包内部用）；
 *   2. **Standard Schema**：宿主 cordis 的 `resolveConfig()` 会走
 *      `runtime.Config["~standard"].validate(config)`，所以必须挂 `~standard`。
 *      校验必须**同步**返回（返回 Promise 会让宿主直接抛
 *      "Async config validation is not supported"）；也**永不返回 `issues`** ——
 *      非法值按契约夹取/回落默认值，不报错。
 * 不依赖 schemastery：夹取与丢未知键都是纯 JS。
 * @param {object} [raw]
 * @returns {object}
 */
export const Config = Object.assign(
  (raw) => normalizeConfig(raw),
  {
    "~standard": {
      version: 1,
      vendor: "dsh-skill-folder",
      validate: (raw) => ({ value: normalizeConfig(raw) }),
    },
  },
);

/** 取日志器：宿主给的是 `ctx.logger(name)`，测试给的是对象，两种都接。 */
function loggerOf(ctx) {
  const raw = ctx ? ctx.logger : undefined;
  if (typeof raw === "function") {
    try {
      return raw.call(ctx, name);
    } catch {
      /* 落到下面的兜底 */
    }
  }
  if (raw && typeof raw === "object") return raw;
  return { info() {}, warn() {}, debug() {}, error() {} };
}

/** 工具返回值的渲染（宿主展示层用；不影响检索逻辑）。 */
function renderToolOutput(_args, value) {
  const items = value && Array.isArray(value.items) ? value.items : [];
  const text = items.length > 0
    ? items.map((item, idx) => `${idx + 1}. \`${item.name}\`（${item.matchedBy}, score=${item.score}）`).join("\n")
    : EMPTY_SEARCH_TEXT;
  return [{ type: "text", text }];
}

/**
 * 造 `skill_search` 工具定义。
 * @param {{config?: object, skills?: Array|Function}} [input]
 *   `skills` 可以是数组（测试/静态池），也可以是 `(exec) => Promise<Array>`（宿主取实时快照）。
 * @returns {object} 工具 spec（`parameters` 是标准 JSON Schema，注册前有自保断言）
 */
export function buildSkillSearchTool(input = {}) {
  const cfg = normalizeConfig(input && input.config);
  const source = input ? input.skills : undefined;

  const spec = {
    name: "skill_search",
    description: TOOL_DESCRIPTION,
    // parameters 必须是**标准 JSON Schema**：宿主把这个定义原样发给模型 API，
    // 扁平 spec（缺 type:"object"）会被服务端判 400 —— 一次坏定义就能打挂整轮请求。
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: "Short description of the capability you need, e.g. 'debug a crash', 'review code'.",
        },
        k: {
          type: "number",
          description: "Max results (default 5, 1..20).",
        },
      },
      required: ["intent"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                score: { type: "number" },
                matchedBy: { type: "string", enum: ["alias", "bm25"] },
              },
              required: ["name", "score", "matchedBy"],
            },
          },
          count: { type: "integer" },
          intentTruncated: { type: "boolean" },
          text: { type: "string" },
        },
        required: ["items", "count", "intentTruncated", "text"],
      },
      render: renderToolOutput,
    },
    async execute(args, exec) {
      const rawPool = typeof source === "function" ? await source(exec) : source;
      const overrides = readCenterSkills();
      const pool = (Array.isArray(rawPool) ? rawPool : [])
        .filter((skill) => skill && typeof skill.name === "string" && !isHidden(overrides, skill.name))
        .map((skill) => ({
          name: skill.name,
          description: typeof skill.description === "string" ? skill.description : "",
        }));

      return searchSkills({
        skills: pool,
        intent: args ? args.intent : undefined,
        k: args ? args.k : undefined,
        aliases: cfg.aliases,
        semanticEnabled: cfg.semanticEnabled,
        ollamaBase: cfg.ollamaBase,
        embedModel: cfg.embedModel,
      });
    },
  };

  // 自保：宁可不注册，也不要把坏 schema 发给模型 API（避免整轮请求 400）
  if (!spec.parameters || spec.parameters.type !== "object") {
    throw new TypeError('skill_search: parameters must be a JSON Schema object (type: "object")');
  }
  return spec;
}

/** 从宿主技能注册表取当前可被模型调用的技能（工具执行期调用）。 */
async function snapshotSkills(ctx, exec) {
  const lookup = {
    cwd: exec && exec.agent && exec.agent.session && exec.agent.session.header
      ? exec.agent.session.header.cwd
      : undefined,
    scope: exec ? exec.agent : undefined,
    signal: exec ? exec.signal : undefined,
  };
  const snapshot = await ctx.skills.snapshot(lookup);
  const skills = snapshot && Array.isArray(snapshot.skills) ? snapshot.skills : [];
  return skills
    .filter((skill) => skill && typeof skill.name === "string")
    .filter((skill) => !skill.invocation || skill.invocation.modelInvocable === true)
    .map((skill) => ({ name: skill.name, description: skill.description || "" }));
}

/**
 * 技能中心本机接口的注册。
 *
 * 只在宿主提供 `webServer` 时注册（能力缺失 ⇒ 面板取数不可达，但目录改写与检索
 * 工具照常工作）。依赖注入面故意**每次现读**：数据文件与分组草案都在请求期取值，
 * 保存后下一轮即生效，不需要重启也不靠缓存。
 */
function registerCenterRoutes(ctx, cfg, logger) {
  if (!ctx || typeof ctx.inject !== "function") return;
  try {
    ctx.inject(["webServer"], (scope) => {
      const webServer = scope ? scope.webServer : undefined;
      if (!webServer || typeof webServer.register !== "function") return;

      const draft = readDraftGroups();
      const deps = {
        snapshot: () => snapshotSkills(ctx, undefined),
        store: centerStore,
        seedTaglines: readSeedTaglines(),
        draftGroups: draft.groups,
        draftSkillGroups: draft.skillGroups,
        profileMode: cfg.catalogMode,
        homeDir: homedir(),
        fs: nodeFs,
        now: () => Date.now(),
      };

      const register = () => {
        const disposers = [];
        const facade = {
          register(route) {
            const disposer = webServer.register(route);
            disposers.push(disposer);
            return disposer;
          },
        };
        registerSkillsCenterRoutes(facade, deps);
        return () => {
          for (const disposer of disposers) {
            try {
              if (typeof disposer === "function") disposer();
            } catch {
              /* 已释放 */
            }
          }
        };
      };

      if (typeof scope.effect === "function") {
        scope.effect(register, "skill-folder: skills-center local API");
      } else {
        register();
      }
    });
  } catch (error) {
    logger.warn("skill-folder: skills-center routes register failed (%s)", error && error.message);
  }
}

/**
 * 插件装载。
 * @param {object} ctx cordis 上下文
 * @param {object} [config] 原始配置（装载期归一）
 * @returns {Promise<(() => void)|void>} disposer
 */
export async function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) return;

  const logger = loggerOf(ctx);

  // 技能中心面板的取数与保存通道（路由只在宿主有 webServer 时注册）
  registerCenterRoutes(ctx, cfg, logger);

  if (cfg.toolSearchEnabled) {
    try {
      const tool = buildSkillSearchTool({
        config: cfg,
        skills: (exec) => snapshotSkills(ctx, exec),
      });
      ctx.tools.register(tool);
      logger.info("skill-folder: registered skill_search tool");
    } catch (error) {
      // 工具注册失败不该拖垮目录改写
      logger.warn("skill-folder: skill_search register failed (%s)", error && error.message);
    }
  }

  // prepend:true ⇒ 瀑布最外层 ⇒ 在宿主 L1(/name 注入) 与 L2(catalog 发布) 之后
  // 拿到最终 decision，再改写渲染。从不否决、从不抛错。
  const disposer = ctx.on(
    "agent/pre-step",
    async (_payload, next) => {
      const decision = await next();
      try {
        return trimDecision(decision, {
          config: cfg,
          taglines: readSeedTaglines(),
          overrides: readCenterSkills(),
        });
      } catch {
        return decision; // 失败即原样放行
      }
    },
    true,
  );

  return () => {
    try {
      if (typeof disposer === "function") disposer();
    } catch {
      /* 已释放 */
    }
  };
}
