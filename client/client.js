/**
 * 技能中心 · 客户端半区
 *
 * 入口：侧边栏「技能中心」（点一下把主面板切到本面板）
 * 面板：整页 = 页头（标题 / 计数 / 保存）+ 工具栏（搜索 / 显示模式）+ 分组视图 + 技能行
 *
 * 数据面：只走宿主本机接口 `/api/skills-center/{list,config,save}`（同机 fetch）。
 * 打开 / 切换档位 / 筛选 / 编辑都不落盘 —— 只有点保存才发 save 请求（草案 ≠ 数据）。
 *
 * 边界：只改数据文件里的短标签 / 分组 / 隐藏 / 显示模式，不碰技能文件本体。
 * 视觉：颜色全部绑定宿主主题 token（取不到时退回规格给出的默认层字面值），
 * 因此换皮肤 / 切深浅色不会撞色；不得引入本机没有的官方组件包。
 *
 * 面板 key 用独立常量 `skills-center`，与写作工作台的面板 key 互不占用；
 * 两者靠宿主不同的 keyed 面板并存，互不覆盖。
 */
window.__ModuleLoader__.load({
  id: "dsh-skill-folder",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");

    /* ------------------------------------------------------------ 常量 */
    const PANEL = "skills-center";
    const API = "/api/skills-center";
    const GROUP_NAME_MAX = 20;
    const TAGLINE_MAX = 40;
    const RESERVED_GROUP = "未分组";
    const NONE_KEY = "\u0000none";
    const MODES = [
      { value: "names-tag", label: "名字＋短标签" },
      { value: "names", label: "只显示名字" },
      { value: "desc", label: "名字＋描述" },
    ];

    /** 用户可见文案（逐字定稿；`{...}` 为运行时替换槽）。 */
    const T = {
      entry: "技能中心",
      title: "技能中心",
      intro: "管理技能的短标签、分组与显示模式；保存后对模型的下一轮目录生效。",
      count: (n) => `共 ${n} 个技能`,
      search: "搜索技能名或短标签",
      searchEmpty: (kw) => `没有匹配「${kw}」的技能`,
      all: "全部",
      ungrouped: RESERVED_GROUP,
      modeLabel: "显示模式",
      modeHint: "保存后对模型下一轮生效，无需重启。",
      colName: "技能名",
      colTagline: "短标签",
      colGroup: "分组",
      colHidden: "隐藏",
      save: "保存",
      saving: "保存中…",
      saveOk: "已保存。模型下一轮对话生效，无需重启。",
      saveFail: (message) => `保存失败：${message}`,
      saveFailFallback: "保存失败，请重试。",
      hideTitle: "确认隐藏技能？",
      hideBody: (names) =>
        `隐藏后，模型将看不到该技能（目录与检索都不出现）。技能：${names}。确定要隐藏吗？`,
      hideConfirm: "确认隐藏",
      cancel: "取消",
      badFile:
        "数据文件损坏，无法读取。已改用内置默认标签显示，模型目录不受影响；保存后将自动备份损坏文件并写入新文件。",
      noUngrouped: "没有未分组的技能。日后新安装且未归组的技能会出现在这里。",
      taglineWarn: (n) => `当前 ${n} 码点：目录将截断为前 37 码点＋…`,
      hiddenMark: "已隐藏",
      loading: "正在加载技能清单…",
      loadFail: "无法连接技能中心服务，请确认插件已安装并重启后重试。",
      retry: "重试",
      newGroup: "新建分组",
      groupPlaceholder: "输入分组名",
      rename: "重命名",
      remove: "删除",
      moveUp: "上移",
      moveDown: "下移",
      confirmRename: "确定",
      nameEmpty: "分组名不能为空",
      nameTooLong: `分组名不能超过 ${GROUP_NAME_MAX} 个字`,
      nameDup: (name) => `已存在同名分组「${name}」，请换一个名字`,
      nameReserved: "「未分组」是保留名称，不能用作分组名",
      delTitle: "确认删除分组？",
      delBody: (name, n) => `删除分组「${name}」后，组内 ${n} 个技能将移到「未分组」，不会删除任何技能。确定要删除吗？`,
      delConfirm: "确认删除",
      emptyGroup: "该分组暂无技能。",
      groupCount: (n) => `${n} 个`,
    };

    /* ------------------------------------------------------------ 样式 */
    const CSS = `
.skc-root{
  --skc-bg:var(--dsw-alias-bg-base,#0d1117);
  --skc-layer1:var(--dsw-alias-bg-layer-1,#161b22);
  --skc-layer2:var(--dsw-alias-bg-layer-2,#1c2129);
  --skc-overlay:var(--dsw-alias-bg-overlay,#22272e);
  --skc-border1:var(--dsw-alias-border-l1,rgba(255,255,255,.08));
  --skc-border2:var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  --skc-brand:var(--dsw-alias-brand-primary,#1f6feb);
  --skc-brand-text:var(--dsw-alias-brand-primary,#79c0ff);
  --skc-brand-fg:#ffffff;
  --skc-text:var(--dsw-alias-label-primary,#e6edf3);
  --skc-muted:var(--dsw-alias-label-secondary,#9ba7b4);
  --skc-danger:var(--dsw-alias-state-error-primary,#ff7b72);
  --skc-danger-fill:var(--dsw-alias-state-error-primary,#f85149);
  --skc-success:var(--dsw-alias-state-success-primary,#7ee787);
  --skc-warn:var(--dsw-alias-state-warn-primary,#e3b341);
  --skc-idle:var(--dsw-alias-state-idle-primary,#9ba7b4);
  --skc-mask:rgba(0,0,0,.5);
  --skc-skeleton:rgba(255,255,255,.07);
  --skc-ui:"Microsoft YaHei UI","Microsoft YaHei",system-ui,-apple-system,"PingFang SC",sans-serif;
  position:relative;height:100%;min-height:0;display:flex;flex-direction:column;
  width:100%;min-width:720px;overflow:auto;
  background:var(--skc-bg);color:var(--skc-text);
  font:14px/1.6 var(--skc-ui);-webkit-font-smoothing:antialiased;
}
.skc-root *{box-sizing:border-box}
.skc-root :focus-visible{outline:2px solid var(--skc-brand-text);outline-offset:2px}
.skc-root button{font:inherit;color:inherit}
.skc-root [disabled]{opacity:.4;cursor:not-allowed}

/* 吸顶页头不透光：三层「面类」token 堆叠（bg-base 叠 bg-overlay 叠 bg-layer-1），
   每一层都是宿主主题色 —— 任一层不透明就不会透出滚动内容，浅色 / 深色主题都跟随；
   本规则不出现任何颜色字面量。 */
.skc-head{position:sticky;top:0;z-index:10;
  background-color:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));
  background-image:linear-gradient(var(--dsw-alias-bg-base),var(--dsw-alias-bg-base)),linear-gradient(var(--dsw-alias-bg-overlay),var(--dsw-alias-bg-overlay));
  border-bottom:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 16px -12px var(--dsw-alias-border-l2);
  padding:24px 40px 16px}
.skc-head1{display:flex;align-items:center;gap:16px}
.skc-title{font-size:24px;line-height:1.3;letter-spacing:.022em;font-weight:600;color:var(--skc-text)}
.skc-count{font-size:14px;letter-spacing:.045em;color:var(--skc-muted)}
.skc-intro{font-size:14px;letter-spacing:.045em;color:var(--skc-muted);margin-top:4px}
.skc-grow{flex:1}
.skc-save{min-width:96px;height:44px;padding:0 20px;border:1px solid transparent;border-radius:12px;
  background:var(--skc-brand);color:var(--skc-brand-fg);font-size:15px;letter-spacing:.04em;font-weight:600;cursor:pointer}
.skc-save:hover:not([disabled]){filter:brightness(1.08)}
.skc-head2{display:flex;align-items:center;gap:16px;margin-top:16px;flex-wrap:wrap}
.skc-search{width:280px;height:36px;padding:0 12px;border:1px solid var(--skc-border1);border-radius:12px;
  background:var(--skc-layer1);color:var(--skc-text);font:inherit;font-size:14px;letter-spacing:.045em}
.skc-search::placeholder{color:var(--skc-muted)}
.skc-modes{display:flex;align-items:center;gap:8px;margin-left:auto}
.skc-modes-label{font-size:14px;color:var(--skc-muted)}
.skc-seg{display:flex;gap:2px;padding:2px;height:32px;border:1px solid var(--skc-border1);border-radius:9999px;background:var(--skc-layer1)}
.skc-seg button{height:28px;padding:0 14px;border:0;border-radius:9999px;background:transparent;color:var(--skc-muted);
  font-size:14px;letter-spacing:.045em;cursor:pointer;white-space:nowrap}
.skc-seg button[aria-pressed="true"]{background:var(--skc-brand);color:var(--skc-brand-fg);font-weight:600}
.skc-hint{font-size:14px;color:var(--skc-muted);margin-left:16px}

.skc-banner{margin:16px 40px 0;padding:8px 16px;border-radius:12px;font-size:12px;letter-spacing:.08em;display:flex;align-items:center;gap:12px}
.skc-banner-ok{color:var(--skc-success);background-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.skc-banner-err{color:var(--skc-danger);background-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}
.skc-banner-bad{color:var(--skc-danger);background-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent);font-size:14px;letter-spacing:.045em}
.skc-banner-x{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px}

.skc-body{flex:1;min-height:0;display:flex;gap:24px;padding:24px 40px 40px}
.skc-nav{flex:0 0 220px;display:flex;flex-direction:column;gap:2px;align-self:flex-start;position:sticky;top:180px}
.skc-nav button{height:40px;padding:0 16px;border:1px solid transparent;border-radius:8px;background:transparent;
  color:var(--skc-muted);font-size:14px;letter-spacing:.045em;text-align:left;cursor:pointer}
.skc-nav button:hover{background:var(--skc-layer1);color:var(--skc-text)}
.skc-nav button[aria-pressed="true"]{background:var(--skc-layer1);color:var(--skc-brand-text);font-weight:600;border-color:var(--skc-border1)}
.skc-main{flex:1;min-width:0;overflow-x:auto}
.skc-caps{display:none;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.skc-cap{height:32px;padding:0 14px;border:1px solid var(--skc-border2);border-radius:9999px;background:transparent;
  color:var(--skc-muted);font-size:14px;cursor:pointer;white-space:nowrap}
.skc-cap[aria-pressed="true"]{background:var(--skc-layer1);border-color:var(--skc-border1);color:var(--skc-brand-text);font-weight:600}
.skc-newbar{display:flex;justify-content:flex-end;margin-bottom:16px}
.skc-new{height:32px;padding:0 14px;border:1px solid var(--skc-border2);border-radius:12px;background:transparent;
  color:var(--skc-text);font-size:14px;cursor:pointer}
.skc-new:hover{background:var(--skc-layer1)}
.skc-gblock{margin-bottom:32px;padding:24px;border:1px solid var(--skc-border1);border-radius:12px;background:var(--skc-layer1)}
.skc-ghead{display:flex;align-items:center;gap:8px;height:32px;margin-bottom:16px}
.skc-gname{font-size:17px;letter-spacing:.03em;font-weight:600;color:var(--skc-text)}
.skc-gcount{font-size:14px;color:var(--skc-muted)}
.skc-gtools{margin-left:auto;display:flex;gap:8px}
.skc-gtool{width:24px;height:24px;padding:0;border:1px solid var(--skc-border1);border-radius:6px;background:transparent;
  color:var(--skc-muted);font-size:12px;line-height:1;cursor:pointer}
.skc-gtool:hover:not([disabled]){color:var(--skc-text);border-color:var(--skc-border2)}
.skc-cols,.skc-row{display:grid;grid-template-columns:240px minmax(160px,1fr) 160px 88px;column-gap:16px;align-items:center;min-width:728px}
.skc-cols{height:32px;padding:0 16px;border-bottom:1px solid var(--skc-border1);font-size:14px;color:var(--skc-muted)}
.skc-row{min-height:52px;padding:0 16px;border-bottom:1px solid var(--skc-border1)}
.skc-row:last-child{border-bottom:0}
.skc-row-name{font-size:14px;letter-spacing:.045em;color:var(--skc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skc-row.is-hidden .skc-row-name{color:var(--skc-muted)}
.skc-tag{width:100%;height:32px;padding:0 10px;border:1px solid var(--skc-border1);border-radius:12px;
  background:var(--skc-layer1);color:var(--skc-text);font:inherit;font-size:14px;letter-spacing:.045em}
.skc-tagwarn{font-size:12px;letter-spacing:.08em;color:var(--skc-warn);margin-top:2px}
.skc-sel{width:100%;height:32px;padding:0 8px;border:1px solid var(--skc-border1);border-radius:12px;
  background:var(--skc-overlay);color:var(--skc-text);font:inherit;font-size:14px}
.skc-hide{display:flex;align-items:center;justify-content:center;gap:6px;position:relative}
.skc-switch{position:relative;width:36px;height:20px;padding:0;border:0;border-radius:9999px;background:var(--skc-border2);cursor:pointer}
.skc-switch[aria-pressed="true"]{background:var(--skc-danger-fill)}
.skc-switch span{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:9999px;background:var(--skc-idle);transition:left .12s}
.skc-switch[aria-pressed="true"] span{left:18px;background:var(--skc-brand-fg)}
.skc-switch::after{content:"";position:absolute;left:50%;top:50%;width:44px;height:44px;transform:translate(-50%,-50%)}
.skc-hidmark{font-size:12px;letter-spacing:.08em;color:var(--skc-danger)}
.skc-empty{padding:16px 0;font-size:14px;letter-spacing:.045em;color:var(--skc-muted)}
.skc-skel{margin-bottom:32px;padding:24px;border:1px solid var(--skc-border1);border-radius:12px;background:var(--skc-layer1)}
.skc-skel-block{height:52px;border-radius:8px;background:var(--skc-skeleton)}
.skc-loading{font-size:14px;color:var(--skc-muted);padding:8px 0}
.skc-fail{display:flex;align-items:center;gap:12px;padding:16px 0;font-size:14px;color:var(--skc-danger)}
.skc-retry{height:32px;padding:0 14px;border:1px solid var(--skc-border2);border-radius:12px;background:transparent;
  color:var(--skc-text);font-size:14px;cursor:pointer}
.skc-gedit{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.skc-ginput{height:32px;min-width:200px;padding:0 10px;border:1px solid var(--skc-border1);border-radius:12px;
  background:var(--skc-layer1);color:var(--skc-text);font:inherit;font-size:14px}
.skc-gbtn{height:32px;padding:0 12px;border:1px solid var(--skc-border2);border-radius:12px;background:transparent;
  color:var(--skc-text);font-size:14px;cursor:pointer}
.skc-gbtn.primary{background:var(--skc-brand);border-color:transparent;color:var(--skc-brand-fg);font-weight:600}
.skc-gerr{flex-basis:100%;font-size:12px;letter-spacing:.08em;color:var(--skc-danger)}
.skc-mask{position:absolute;inset:0;z-index:20;background:var(--skc-mask);display:flex;align-items:center;justify-content:center}
.skc-modal{width:480px;max-width:calc(100% - 80px);padding:24px;border-radius:16px;background:var(--skc-layer2);
  border:1px solid var(--skc-border1)}
.skc-modal h3{margin:0 0 12px;font-size:17px;letter-spacing:.03em;color:var(--skc-text)}
.skc-modal p{margin:0;font-size:14px;line-height:22px;letter-spacing:.045em;color:var(--skc-text)}
.skc-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}
.skc-btn{height:36px;padding:0 16px;border:1px solid var(--skc-border2);border-radius:12px;background:transparent;
  color:var(--skc-text);font-size:15px;letter-spacing:.04em;cursor:pointer}
.skc-btn.danger{background-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent);border-color:transparent;color:var(--skc-danger);font-weight:600}
.skc-launch{display:inline-flex;align-items:center;justify-content:flex-start;width:100%;height:24px;padding:0;border:0;border-radius:6px;
  background:transparent;color:inherit;font:inherit;cursor:pointer}
.skc-launch:hover .skc-launch-icon{filter:brightness(1.15)}
.skc-launch-icon{display:grid;place-items:center;width:20px;height:20px;border-radius:6px;
  background:var(--dsw-alias-brand-primary,#1f6feb);color:var(--skc-brand-fg);font-size:11px;font-weight:700}
@media (max-width:1279px){
  .skc-nav{display:none}
  .skc-caps{display:flex}
  .skc-head,.skc-body{padding-left:24px;padding-right:24px}
  .skc-banner{margin-left:24px;margin-right:24px}
}
`;

    /** 样式只注入一次（同一页面反复进出面板不重复堆 <style>）。 */
    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.getElementById("skc-style")) return;
      const style = document.createElement("style");
      style.id = "skc-style";
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ------------------------------------------------------------ 工具 */
    /** 码点数（不是 UTF-16 长度）。 */
    function codepoints(value) {
      return [...String(value ?? "")].length;
    }

    /** 调本机接口：统一外壳解包，失败抛「人话」错误（含接口错误码）。 */
    async function callApi(action, payload) {
      let res;
      try {
        res = await fetch(`${API}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload || {}),
        });
      } catch (error) {
        throw Object.assign(new Error(T.saveFailFallback), { code: "NETWORK" });
      }
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!body || body.ok !== true) {
        const message =
          body && body.error && typeof body.error.message === "string" && body.error.message !== ""
            ? body.error.message
            : T.saveFailFallback;
        throw Object.assign(new Error(message), {
          code: body && body.error ? String(body.error.code || "") : "",
        });
      }
      return body.value;
    }

    /** 组名本地校验（与服务端同一口径，纯前端先挡一道）。 */
    function checkGroupName(name, groups, self) {
      const value = String(name ?? "").trim();
      if (codepoints(value) === 0) return { ok: false, error: T.nameEmpty };
      if (codepoints(value) > GROUP_NAME_MAX) return { ok: false, error: T.nameTooLong };
      if (value === RESERVED_GROUP) return { ok: false, error: T.nameReserved };
      const clash = (groups || []).some((item) => item === value && item !== self);
      if (clash) return { ok: false, error: T.nameDup(value) };
      return { ok: true, value };
    }

    /** 该行的「生效分组」：指向已不存在的组 ⇒ 归未分组（值本身原样保留）。 */
    function effectiveGroup(row, groups) {
      if (typeof row.group !== "string" || row.group === "") return null;
      return groups.includes(row.group) ? row.group : null;
    }

    /* ------------------------------------------------------------ 小组件 */
    function Modal(title, body, confirmLabel, onConfirm, onCancel, danger) {
      return react.createElement(
        "div",
        { className: "skc-mask", role: "dialog", "aria-modal": "true", "aria-label": title },
        react.createElement(
          "div",
          { className: "skc-modal" },
          react.createElement("h3", null, title),
          react.createElement("p", null, body),
          react.createElement(
            "div",
            { className: "skc-modal-actions" },
            react.createElement("button", { type: "button", className: "skc-btn", onClick: onCancel }, T.cancel),
            react.createElement(
              "button",
              { type: "button", className: danger ? "skc-btn danger" : "skc-btn", onClick: onConfirm },
              confirmLabel,
            ),
          ),
        ),
      );
    }

    function Skeleton() {
      const blocks = [];
      for (let i = 0; i < 10; i += 1) blocks.push(react.createElement("div", { key: i, className: "skc-skel-block" }));
      return react.createElement(
        "div",
        null,
        react.createElement("div", { className: "skc-loading" }, T.loading),
        react.createElement("div", { className: "skc-skel" }, blocks),
      );
    }

    function GroupEditor(state, onChange, onCommit, onCancel) {
      const message = state.error ? react.createElement("div", { className: "skc-gerr", role: "alert" }, state.error) : null;
      return react.createElement(
        "div",
        { className: "skc-gedit" },
        react.createElement("input", {
          className: "skc-ginput",
          value: state.value,
          placeholder: T.groupPlaceholder,
          autoFocus: true,
          onChange: (event) => onChange(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") onCommit();
            if (event.key === "Escape") onCancel();
          },
          "aria-label": state.kind === "rename" ? T.rename : T.newGroup,
        }),
        react.createElement("button", { type: "button", className: "skc-gbtn primary", onClick: onCommit }, T.confirmRename),
        react.createElement("button", { type: "button", className: "skc-gbtn", onClick: onCancel }, T.cancel),
        message,
      );
    }

    /* ------------------------------------------------------------ 主面板 */
    function Panel(props) {
      ensureCss();

      const [status, setStatus] = react.useState("loading");
      const [loadError, setLoadError] = react.useState("");
      const [fileStatus, setFileStatus] = react.useState("missing");
      const [fileError, setFileError] = react.useState("");
      const [mode, setMode] = react.useState("names-tag");
      const [groups, setGroups] = react.useState([]);
      const [rows, setRows] = react.useState([]);
      const [baselineHidden, setBaselineHidden] = react.useState({});
      const [keyword, setKeyword] = react.useState("");
      const [activeGroup, setActiveGroup] = react.useState("__all__");
      const [saving, setSaving] = react.useState(false);
      const [toast, setToast] = react.useState(null);
      const [confirm, setConfirm] = react.useState(null);
      const [edit, setEdit] = react.useState(null);

      const applyValue = react.useCallback((listValue, configValue) => {
        const source = listValue || configValue || {};
        const config = configValue || {};
        const nextRows = Array.isArray(source.skills) ? source.skills : [];
        const hiddenBaseline = {};
        for (const row of nextRows) hiddenBaseline[row.name] = row.hidden === true;
        setFileStatus(String(source.fileStatus || config.fileStatus || "missing"));
        setFileError(String(source.fileError || config.fileError || ""));
        setMode(String(source.mode || config.mode || "names-tag"));
        setGroups(Array.isArray(source.groups) ? source.groups.slice() : Array.isArray(config.groups) ? config.groups.slice() : []);
        setRows(
          nextRows.map((row) => ({
            name: row.name,
            tagline: typeof row.tagline === "string" ? row.tagline : "",
            group: typeof row.group === "string" && row.group !== "" ? row.group : null,
            hidden: row.hidden === true,
          })),
        );
        setBaselineHidden(hiddenBaseline);
        setActiveGroup("__all__");
      }, []);

      const load = react.useCallback(async () => {
        setStatus("loading");
        setLoadError("");
        try {
          const results = await Promise.all([callApi("list", {}), callApi("config", {})]);
          applyValue(results[0], results[1]);
          setStatus("ready");
        } catch (error) {
          setLoadError(String((error && error.message) || error));
          setStatus("error");
        }
      }, [applyValue]);

      react.useEffect(() => {
        load();
      }, [load]);

      react.useEffect(() => {
        if (!toast || toast.kind !== "ok") return undefined;
        const timer = window.setTimeout(() => setToast(null), 5000);
        return () => window.clearTimeout(timer);
      }, [toast]);

      const groupsForSelect = groups;

      const visibleRows = react.useMemo(() => {
        const kw = keyword.trim();
        return rows.filter((row) => {
          if (kw !== "" && !row.name.includes(kw) && !row.tagline.includes(kw)) return false;
          if (activeGroup === "__all__") return true;
          const group = effectiveGroup(row, groups);
          if (activeGroup === NONE_KEY) return group === null;
          return group === activeGroup;
        });
      }, [rows, keyword, activeGroup, groups]);

      const blocks = react.useMemo(() => {
        const inGroup = (row, name) => effectiveGroup(row, groups) === name;
        const out = [];
        // 选中某组 ⇒ 只渲染那一组；「全部」⇒ 渲染全部自定义组（空组也要在，才能改名 / 调序 / 删除）
        const custom =
          activeGroup === "__all__" ? groups : groups.filter((group) => group === activeGroup);
        for (const group of custom) {
          out.push({ key: group, name: group, rows: visibleRows.filter((row) => inGroup(row, group)) });
        }
        const ungrouped = visibleRows.filter((row) => effectiveGroup(row, groups) === null);
        // 未分组：只在「选中未分组」或「全部且确实有未分组技能」时出现，空区不出空卡片
        if (activeGroup === NONE_KEY || (activeGroup === "__all__" && ungrouped.length > 0)) {
          out.push({ key: NONE_KEY, name: RESERVED_GROUP, rows: ungrouped });
        }
        return out;
      }, [groups, visibleRows, activeGroup]);

      const filters = react.useMemo(
        () => [
          { key: "__all__", label: T.all },
          ...groups.map((group) => ({ key: group, label: group })),
          { key: NONE_KEY, label: RESERVED_GROUP },
        ],
        [groups],
      );

      function patchRow(name, patch) {
        setRows((prev) => prev.map((row) => (row.name === name ? { ...row, ...patch } : row)));
      }

      function pendingHiddenNames() {
        return rows.filter((row) => row.hidden === true && baselineHidden[row.name] !== true).map((row) => row.name);
      }

      async function submitSave() {
        setSaving(true);
        setConfirm(null);
        try {
          await callApi("save", {
            mode,
            groups: groups.slice(),
            skills: rows.map((row) => ({
              name: row.name,
              tagline: row.tagline,
              group: typeof row.group === "string" ? row.group : null,
              hidden: row.hidden === true,
            })),
          });
          setToast({ kind: "ok", text: T.saveOk });
          await load();
        } catch (error) {
          setToast({ kind: "err", text: T.saveFail(String((error && error.message) || T.saveFailFallback)) });
        } finally {
          setSaving(false);
        }
      }

      function requestSave() {
        const names = pendingHiddenNames();
        if (names.length > 0) {
          setConfirm({ kind: "hide", names });
          return;
        }
        submitSave();
      }

      function startNewGroup() {
        setEdit({ kind: "new", value: "", error: "" });
      }

      function startRename(group) {
        setEdit({ kind: "rename", target: group, value: group, error: "" });
      }

      function commitEdit() {
        if (!edit) return;
        const self = edit.kind === "rename" ? edit.target : undefined;
        const checked = checkGroupName(edit.value, groups, self);
        if (!checked.ok) {
          setEdit({ ...edit, error: checked.error });
          return;
        }
        if (edit.kind === "new") {
          setGroups((prev) => [...prev, checked.value]);
        } else {
          const from = edit.target;
          const to = checked.value;
          setGroups((prev) => prev.map((group) => (group === from ? to : group)));
          setRows((prev) => prev.map((row) => (row.group === from ? { ...row, group: to } : row)));
          setActiveGroup((prev) => (prev === from ? to : prev));
        }
        setEdit(null);
      }

      function moveGroup(index, delta) {
        setGroups((prev) => {
          const next = prev.slice();
          const to = index + delta;
          if (to < 0 || to >= next.length) return prev;
          const [item] = next.splice(index, 1);
          next.splice(to, 0, item);
          return next;
        });
      }

      function requestDeleteGroup(group) {
        const count = rows.filter((row) => effectiveGroup(row, groups) === group).length;
        if (count === 0) {
          dropGroup(group);
          return;
        }
        setConfirm({ kind: "delete-group", group, count });
      }

      function dropGroup(group) {
        setGroups((prev) => prev.filter((item) => item !== group));
        setRows((prev) => prev.map((row) => (row.group === group ? { ...row, group: null } : row)));
        setActiveGroup((prev) => (prev === group ? "__all__" : prev));
        setConfirm(null);
      }

      const busy = status !== "ready" || saving;

      const banners = [];
      if (status === "ready" && fileStatus === "bad") {
        banners.push(react.createElement("div", { key: "bad", className: "skc-banner skc-banner-bad", role: "alert" }, fileError ? `${T.badFile}（${fileError}）` : T.badFile));
      }
      if (toast) {
        banners.push(
          react.createElement(
            "div",
            { key: "toast", className: toast.kind === "ok" ? "skc-banner skc-banner-ok" : "skc-banner skc-banner-err", role: toast.kind === "ok" ? "status" : "alert" },
            react.createElement("span", null, toast.text),
            toast.kind === "err"
              ? react.createElement("button", { type: "button", className: "skc-banner-x", onClick: () => setToast(null) }, "关闭")
              : null,
          ),
        );
      }

      const header = react.createElement(
        "div",
        { className: "skc-head" },
        react.createElement(
          "div",
          { className: "skc-head1" },
          react.createElement("span", { className: "skc-title" }, T.title),
          react.createElement("span", { className: "skc-count" }, T.count(rows.length)),
          react.createElement("span", { className: "skc-grow" }),
          react.createElement(
            "button",
            { type: "button", className: "skc-save", onClick: requestSave, disabled: busy },
            saving ? T.saving : T.save,
          ),
        ),
        react.createElement("div", { className: "skc-intro" }, T.intro),
        react.createElement(
          "div",
          { className: "skc-head2" },
          react.createElement("input", {
            className: "skc-search",
            value: keyword,
            placeholder: T.search,
            disabled: busy,
            onChange: (event) => setKeyword(event.target.value),
            "aria-label": T.search,
          }),
          react.createElement(
            "div",
            { className: "skc-modes" },
            react.createElement("span", { className: "skc-modes-label" }, T.modeLabel),
            react.createElement(
              "div",
              { className: "skc-seg", role: "group", "aria-label": T.modeLabel },
              MODES.map((item) =>
                react.createElement(
                  "button",
                  {
                    key: item.value,
                    type: "button",
                    "aria-pressed": mode === item.value ? "true" : "false",
                    disabled: busy,
                    onClick: () => setMode(item.value),
                  },
                  item.label,
                ),
              ),
            ),
            react.createElement("span", { className: "skc-hint" }, T.modeHint),
          ),
        ),
      );

      const caps = react.createElement(
        "div",
        { className: "skc-caps" },
        filters.map((item) =>
          react.createElement(
            "button",
            {
              key: item.key,
              type: "button",
              className: "skc-cap",
              "aria-pressed": activeGroup === item.key ? "true" : "false",
              disabled: busy,
              onClick: () => setActiveGroup(item.key),
            },
            item.label,
          ),
        ),
      );

      const nav = react.createElement(
        "div",
        { className: "skc-nav" },
        filters.map((item) =>
          react.createElement(
            "button",
            {
              key: item.key,
              type: "button",
              "aria-pressed": activeGroup === item.key ? "true" : "false",
              disabled: busy,
              onClick: () => setActiveGroup(item.key),
            },
            item.label,
          ),
        ),
      );

      function renderRow(row) {
        const over = codepoints(row.tagline) > TAGLINE_MAX;
        const group = effectiveGroup(row, groups);
        return react.createElement(
          "div",
          { key: row.name, className: row.hidden ? "skc-row is-hidden" : "skc-row" },
          react.createElement("span", { className: "skc-row-name", title: row.name }, row.name),
          react.createElement(
            "div",
            null,
            react.createElement("input", {
              className: "skc-tag",
              value: row.tagline,
              disabled: busy,
              "aria-label": `${row.name} 的短标签`,
              onChange: (event) => patchRow(row.name, { tagline: event.target.value }),
            }),
            over ? react.createElement("div", { className: "skc-tagwarn" }, T.taglineWarn(codepoints(row.tagline))) : null,
          ),
          react.createElement(
            "select",
            {
              className: "skc-sel",
              value: group === null ? "" : group,
              disabled: busy,
              "aria-label": `${row.name} 的分组`,
              onChange: (event) => patchRow(row.name, { group: event.target.value === "" ? null : event.target.value }),
            },
            react.createElement("option", { value: "" }, RESERVED_GROUP),
            groupsForSelect.map((item) => react.createElement("option", { key: item, value: item }, item)),
          ),
          react.createElement(
            "div",
            { className: "skc-hide" },
            react.createElement(
              "button",
              {
                type: "button",
                className: "skc-switch",
                "aria-pressed": row.hidden ? "true" : "false",
                "aria-label": `${row.name} 隐藏`,
                disabled: busy,
                onClick: () => patchRow(row.name, { hidden: !row.hidden }),
              },
              react.createElement("span", null),
            ),
            row.hidden ? react.createElement("span", { className: "skc-hidmark" }, T.hiddenMark) : null,
          ),
        );
      }

      const listArea =
        status === "loading"
          ? Skeleton()
          : status === "error"
            ? react.createElement(
                "div",
                { className: "skc-fail" },
                react.createElement("span", null, T.loadFail),
                react.createElement("button", { type: "button", className: "skc-retry", onClick: load }, T.retry),
                loadError ? react.createElement("span", null, loadError) : null,
              )
            : react.createElement(
                "div",
                null,
                react.createElement(
                  "div",
                  { className: "skc-newbar" },
                  edit && edit.kind === "new"
                    ? null
                    : react.createElement("button", { type: "button", className: "skc-new", onClick: startNewGroup, disabled: busy }, T.newGroup),
                ),
                edit && edit.kind === "new"
                  ? react.createElement(
                      "div",
                      { className: "skc-gblock" },
                      GroupEditor(edit, (value) => setEdit({ ...edit, value, error: "" }), commitEdit, () => setEdit(null)),
                    )
                  : null,
                keyword.trim() !== "" && visibleRows.length === 0
                  ? react.createElement("div", { className: "skc-empty" }, T.searchEmpty(keyword.trim()))
                  : blocks.map((block) => {
                      const custom = block.key !== NONE_KEY;
                      const index = custom ? groups.indexOf(block.name) : -1;
                      const editing = edit && edit.kind === "rename" && edit.target === block.name;
                      const head = react.createElement(
                        "div",
                        { className: "skc-ghead" },
                        editing
                          ? GroupEditor(edit, (value) => setEdit({ ...edit, value, error: "" }), commitEdit, () => setEdit(null))
                          : react.createElement("span", { className: "skc-gname" }, block.name),
                        react.createElement("span", { className: "skc-gcount" }, T.groupCount(block.rows.length)),
                        custom && !editing
                          ? react.createElement(
                              "div",
                              { className: "skc-gtools" },
                              react.createElement(
                                "button",
                                {
                                  type: "button",
                                  className: "skc-gtool",
                                  title: T.moveUp,
                                  "aria-label": `${T.moveUp}：${block.name}`,
                                  disabled: busy || index <= 0,
                                  onClick: () => moveGroup(index, -1),
                                },
                                "↑",
                              ),
                              react.createElement(
                                "button",
                                {
                                  type: "button",
                                  className: "skc-gtool",
                                  title: T.moveDown,
                                  "aria-label": `${T.moveDown}：${block.name}`,
                                  disabled: busy || index >= groups.length - 1,
                                  onClick: () => moveGroup(index, 1),
                                },
                                "↓",
                              ),
                              react.createElement(
                                "button",
                                {
                                  type: "button",
                                  className: "skc-gtool",
                                  title: T.rename,
                                  "aria-label": `${T.rename}：${block.name}`,
                                  disabled: busy,
                                  onClick: () => startRename(block.name),
                                },
                                "✎",
                              ),
                              react.createElement(
                                "button",
                                {
                                  type: "button",
                                  className: "skc-gtool",
                                  title: T.remove,
                                  "aria-label": `${T.remove}：${block.name}`,
                                  disabled: busy,
                                  onClick: () => requestDeleteGroup(block.name),
                                },
                                "✕",
                              ),
                            )
                          : null,
                      );
                      const body =
                        block.rows.length === 0
                          ? react.createElement(
                              "div",
                              { className: "skc-empty" },
                              custom ? T.emptyGroup : T.noUngrouped,
                            )
                          : react.createElement(
                              "div",
                              null,
                              react.createElement(
                                "div",
                                { className: "skc-cols" },
                                react.createElement("span", null, T.colName),
                                react.createElement("span", null, T.colTagline),
                                react.createElement("span", null, T.colGroup),
                                react.createElement("span", null, T.colHidden),
                              ),
                              block.rows.map(renderRow),
                            );
                      return react.createElement("div", { key: block.key, className: "skc-gblock" }, head, body);
                    }),
              );

      return react.createElement(
        "div",
        { className: "skc-root" },
        header,
        banners,
        react.createElement(
          "div",
          { className: "skc-body" },
          nav,
          react.createElement(
            "div",
            { className: "skc-main" },
            caps,
            listArea,
          ),
        ),
        confirm && confirm.kind === "hide"
          ? Modal(
              T.hideTitle,
              T.hideBody(confirm.names.join("、")),
              T.hideConfirm,
              submitSave,
              () => setConfirm(null),
              true,
            )
          : null,
        confirm && confirm.kind === "delete-group"
          ? Modal(
              T.delTitle,
              T.delBody(confirm.group, confirm.count),
              T.delConfirm,
              () => dropGroup(confirm.group),
              () => setConfirm(null),
              true,
            )
          : null,
      );
    }

    /* ------------------------------------------------------------ 入口 */
    function LaunchButton(props) {
      ensureCss();
      const ctx = props && props.__ctx;
      return react.createElement(
        "button",
        {
          type: "button",
          className: "skc-launch",
          title: T.entry,
          "aria-label": T.entry,
          onClick: () => {
            try {
              if (ctx && ctx.layout && typeof ctx.layout.selectPanel === "function") ctx.layout.selectPanel(PANEL);
            } catch {
              /* 宿主不受理该面板时无操作 */
            }
          },
        },
        react.createElement("span", { className: "skc-launch-icon", "aria-hidden": "true" }, "技"),
      );
    }

    const inject = ["slots", "layout"];

    function apply(ctx) {
      ensureCss();
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL,
            order: 46,
            label: () => T.entry,
          },
          (props) => LaunchButton({ ...props, __ctx: ctx }),
        ),
      );
      ctx.slots.inject("main", () =>
        ctx.slots.register(
          {
            name: "main",
            key: PANEL,
          },
          (props) => react.createElement(Panel, props),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = "dsh-skill-folder";
    return module.exports;
  },
});
