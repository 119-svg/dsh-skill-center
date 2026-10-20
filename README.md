# dsh-skill-folder（本机裁剪版）

把模型每轮看到的技能目录压短：目录行从「名字 + 全量描述」变成「名字 + 一句短标签」，
再配一个只读检索工具 `skill_search`，模型选不准时用一句话意图换回真实技能名，
再用宿主的 `skill` 工具按名加载正文。技能文件一个不动，`skill` 工具与 `/name`
注入仍归宿主。

## Fork 基线

- 上游包：`dsh-skill-folder`，版本 **0.3.4**（模块划分 `lib/{index,render,select,catalog,skill-search,semantic,bm25,pattern,frontmatter,storage}.js`）。
- 适配目标宿主：DSH `0.2.1-rc.2`（`agent/pre-step` 瀑布 + `prepend:true` 最外层；
  catalog 消息 `source.kind="skill-catalog"`；服务名 `skills` / `tools` / `workingDirectory`）。
- 基线源码留档：`_diag/pkgcheck/dsh-skill-folder/package/`（只读参考，不在本包内）。

## 本期裁剪与改动

- **删 autoRoute 整条链**：消息尾部 `<skill-route>` 提示、`locateRoute` /
  `appendRouteHint` / `routeSkillName` / `appendRouteHintText`、路由统计持久化
  （`lib/storage.js`）与 `autoRoute` / `maxFoldMs` 两个配置键全部移除；渲染因此
  只依赖技能集合，不再有「按 query 尾插提示」的动态面。
- **去会话回扫依赖**：上游靠宿主会话历史事件回扫找回 catalog（0.2.1 上该事件
  通道已不存在）。本包**整段删除**回扫，只改当轮 decision 里的 catalog 消息。
- **删 deny / topK / footer 兜底 / `catalogEnabled`**：行集合只由「快照 − `hidden:true`」
  决定，一条不少；`lib/pattern.js` 随之不再需要（无消费者）。
- **删 frontmatter 富化**：检索索引收窄为 `name + description + aliases` 三个字段，
  不再读技能文件的 frontmatter（少一层 fs 读取面）；`lib/frontmatter.js` 不随包。
- **目录行换 C+ 档**：默认 `catalogMode: names-tag`，行格式 ``- `<name>`: <短标签>``；
  短标签三级回退（`~/.dsh/skills-center.json` 的用户覆盖 → 包内种子 `lib/taglines.json`
  → 只留名字、不留 `: ` 空尾巴），超过 **40 码点**截成前 37 + `...`；另两档
  `names`（只名字）/ `desc`（旧描述档，仅该档适用 `maxDescLength`，默认 120，
  有效域 `[4,500]` 越界夹取）。
- **`hidden:true` 双剔除**：既不进目录、也不进 `skill_search` 结果池。
- **新增 `skill_search` 引导行**：与工具同生同灭（`toolSearchEnabled=false`
  ⇒ 工具不注册、引导行也不出现），措辞固定且位于文本末行。
- **语义腿默认关且不落盘**：`semanticEnabled: false`；开启时若 Ollama 不可达，
  单次调用内降级纯 BM25（上限 3000ms，不重试）；embedding 只在进程内缓存，
  不写任何文件（本包工具是只读面）。
- **宿主依赖惰性取得**：`lib/index.js` 不在模块顶层静态 import 宿主包。
  `Config` 用纯 JS 归一（默认值 / 夹取 / 只留契约 9 键），`defineTool` 在装载时
  动态 import 取真件、取不到则退回 identity —— 纯函数模块因此零宿主依赖，
  可被 `node --test` 直接加载。
- 包内不携带上游的 `test/`（本仓测试在 `test/packages/FEAT-001/`）与 `docs/`
  （上游 `system_design.md` 是 0.2.0 口径，已过期）。

## 配置项

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` ⇒ 零改写、零注册 |
| `catalogMode` | `names-tag` | `names-tag` / `names` / `desc` |
| `core` | `["verification-before-completion","systematic-debugging","using-superpowers"]` | 配置序 = 渲染序；名单里快照没有的名字静默跳过 |
| `maxDescLength` | `120` | **仅 `desc` 档生效**；越界夹取到 `[4,500]`，非整数向零取整 |
| `toolSearchEnabled` | `true` | `false` ⇒ 不注册工具、不出现引导行 |
| `semanticEnabled` | `false` | 语义腿（本地 Ollama） |
| `aliases` | 见 `lib/index.js` 的 `ALIASES_DEFAULT` | 意图词 → 技能名 |
| `ollamaBase` | `http://127.0.0.1:11434` | 仅语义腿使用 |
| `embedModel` | `bge-m3` | 仅语义腿使用 |

只读外部文件 `~/.dsh/skills-center.json`：渲染只认 `skills.<name>.tagline`、
`skills.<name>.hidden` 与 `settings.mode` 三个键（档位 `settings.mode` 有效时优先于
配置 `catalogMode`）；文件缺失 / 空文件 / 解析失败 / `skills` 不是对象 ⇒ 渲染静默
回落到包内种子（不抛错、不阻塞目录发布）。文件只在用户点面板「保存」时由本包的
保存接口写入 —— 渲染路径永不写它。

## 本期新增：技能中心面板（FEAT-002）

宿主半区新增本机 HTTP 接口，客户端半区新增整页面板；数据文件从 v1 升到 v2
（`{version:2, settings:{mode,groups}, skills:{<name>:{tagline,group,hidden}}}`），
v1 文件读侧照旧（不据 `version` 分支，只看 `settings` 是否存在且有效）。

- **数据文件读写** `lib/skills-center-store.js`（纯函数面，fs 与 home 都由入参注入）：
  唯一目标路径 `centerPath(home)`；坏文件保存前先备份为
  `skills-center.json.bad-<epoch 毫秒>`（一次保存至多 1 份，旧备份永不删改）；
  写盘 = 序列化往返校验 → 同目录临时文件 → 原子 rename，任一步失败返回
  `WRITE_FAILED` 且目标文件保持旧内容。
- **本机接口** `lib/skills-center-api.js`：`POST /api/skills-center/{list,config,save}`
  三条精确路径；四道校验顺序固定（来源 403 → 方法 405 → 媒体类型 415 → 入参 400），
  响应外壳统一 `{ok, value}` / `{ok:false, error:{code, message}}`；不接受任何客户端
  传入路径（入参出现 `path`/`dir`/`file`/`filePath`/`target` 即 400）。
- **分组草案** `lib/skill-groups.json` + `lib/draft-groups.js`：8 组 / 58 条技能归组，
  只作面板回退初值与组序；**分组不进渲染**（`group` 与 `settings.groups` 对模型目录
  零消费，目录字节在任意分组管理后逐字节不变）。
- **客户端半区** `client/client.js`（`window.__ModuleLoader__.load({id, factory})`）：
  侧边栏入口槽 `sidebar.panellist` 注册恰 1 项（key `skills-center`），主面板槽 `main`
  注册 1 个 keyed 整页面板（同 key，不占写作工作台的面板 key）；`fetch` 调上面三条
  端点；颜色只绑宿主主题 token（`--dsw-alias-*` 13 个 + 侧边栏底色，取不到时退回
  规格给出的默认层字面值），**不 import** 本机没有的官方组件包。
- **`inject` 由三项改四项**：新增 `webServer`（面板取数 / 保存的唯一通道）。路由只在
  宿主提供 `webServer` 时注册，`skills-center` 能力缺失不影响目录改写与 `skill_search`。
- **面板职责边界**：只看 / 改短标签、分组、隐藏、显示模式；打开、切换、筛选、编辑都
  不落盘，只有「保存」才写文件（含隐藏二次确认与删组二次确认）。

## 安装与回退（由人执行）

1. 装前检查：`node --check lib/index.js`；本包无 `peerDependencies`（装不上时先看是不是
   别的包的 peer 解析问题）。
2. 安装：`plugin_manager install_bundle` 指本地目录 `_plugin-fix/dsh-skill-folder`。
3. **完全退出 DSH Desktop（含托盘）再重启**才生效；未重启前任何「没效果」的结论不成立。
4. 回退：从 profile 移除 `skill-folder` 行（或移除该 bundle）→ 重启 ⇒ 目录回到宿主原样；
   临时停用可设 `enabled: false`。

## 许可

- 上游 `package.json` 声明 **MIT**；本包同样声明 `MIT`，且不抹掉上游的许可声明。
- 上游包内**未附 LICENSE 文件**，许可原文**待核**（本机自用不分发，不构成障碍；
  对外分发前必须补齐核对）。
