/**
 * dsh-device-center — client bundle.
 *
 * 在输入框左下角「完全权限」旁边加一个设备按钮；点开是一个半透明浮窗，
 * 里面是设备层级的树，可以像文件夹一样展开折叠、搜索，选中就把资源 ID 加进对话框。
 *
 * 为什么要这个东西：控制面存在的意义是"Agent 不再需要被告知 IP/密码"，
 * 但前提是**用户能方便地说出是哪台设备**。让人去背 `vm:phyd-top` 是不现实的，
 * 所以给出一个能看、能搜、能点、能复制的入口。
 *
 * 数据来源是同源路由 `/dsh-device-center/tree`（宿主侧转发到控制面），
 * 因此浏览器不做跨源请求，令牌也始终留在服务端。
 *
 * INJECT AUDIT（这个插件的第一个检查项）：
 *   - `slots`    -> ctx.slots.inject("conversation.input.left", …)
 *   - `sessions` -> sessions.scope(sessionId) 拿到 actx，再取 conversation 服务
 *   两者都必须在，否则插件静默不生效（不抛错，避免拖垮整个前端）。
 *
 * 插入文本走公开的输入面：`conversation.input.for(actx)` 返回 SessionInput，
 * 读 `input.state.getSnapshot().draft` 拿当前草稿（**不是 `.get()`**，那个不存在），
 * 再用 scoped 事件 `slash/input-insert-text` 在末尾纯插入。
 * 刻意**不做整段替换**：用户可能已经打了一半的话，追加而不是覆盖。
 */
window.__ModuleLoader__.load({
  id: "dsh-device-center",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    var API = "/dsh-device-center/tree";
    /** 权限读写。与接入点切换同理：浮层里点一下就改，不用翻设置页。 */
    var PERM_API = "/dsh-device-center/perm";

    // ------------------------------------------------------------------
    // 样式
    //
    // 全部使用 DSH 自己定义的设计令牌（--dsw-alias-*），这样自动跟随主题与第三方皮肤。
    // 教训：一开始我写的是 --dsw-alias-bg-elevated / --dsw-alias-brand-primary —— 这两个
    // 令牌**根本不存在**，于是每次取值都落到我随手写的深色兜底上，在浅色主题里
    // 就成了一个突兀的黑框。正确的名字来自在真实页面上读 :root 的 computed style：
    //   bg 用 --dsw-alias-bg-layer-1/2，文字用 --dsw-alias-label-primary/secondary，
    //   边框用 --dsw-alias-border-l2/3，强调色用 --dsw-alias-button-info-fill。
    // 兜底值也刻意选浅色中性值 —— 万一令牌改版，退化结果也不会跟主题打架。
    // ------------------------------------------------------------------
    var CSS_TAG = "dsh-device-center/client";
    var V = {
      bg: "var(--dsw-alias-bg-layer-1,rgba(255,255,255,.88))",
      fg: "var(--dsw-alias-label-primary,#0f1115)",
      dim: "var(--dsw-alias-label-secondary,#61666b)",
      faint: "var(--dsw-alias-label-tertiary,#81858c)",
      line: "var(--dsw-alias-border-l2,rgba(0,0,0,.10))",
      lineHi: "var(--dsw-alias-border-l3,rgba(0,0,0,.12))",
      hover: "var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))",
      active: "var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.10))",
      solid: "var(--dsw-alias-interactive-bg-hover-solid,#f1f3f5)",
      accent: "var(--dsw-alias-button-info-fill,#4176e6)",
      shadow: "var(--dsw-elevation-panel,0 0 0 .5px rgba(0,0,0,.16),0 3px 8px rgba(0,0,0,.03),0 0 16px rgba(0,0,0,.02))",
      warn: "var(--dsw-alias-state-warn-label,#dd8629)",
    };
    var CSS = [
      ".ddc-wrap{position:relative;display:inline-flex}",
      ".ddc-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;",
      "border-radius:8px;border:1px solid " + V.line + ";background:transparent;color:" + V.dim + ";",
      "font-size:12px;line-height:1;cursor:pointer;font-family:inherit;white-space:nowrap;",
      "transition:background .12s ease,border-color .12s ease,color .12s ease}",
      ".ddc-btn:hover{background:" + V.hover + ";border-color:" + V.lineHi + ";color:" + V.fg + "}",
      ".ddc-btn.on{background:" + V.solid + ";border-color:" + V.accent + ";color:" + V.accent + "}",
      ".ddc-dot{width:6px;height:6px;border-radius:50%;background:" + V.accent + ";flex:none}",

      /* 浮窗：取页面层的半透明底色 + 毛玻璃，跟随主题明暗 */
      ".ddc-pop{position:fixed;z-index:60;display:flex;flex-direction:column;overflow:hidden;",
      "border-radius:12px;border:1px solid " + V.line + ";",
      "background:color-mix(in srgb," + V.bg + " 86%,transparent);",
      "-webkit-backdrop-filter:blur(16px) saturate(150%);backdrop-filter:blur(16px) saturate(150%);",
      "box-shadow:" + V.shadow + ";font-size:12.5px;color:" + V.fg + "}",

      ".ddc-head{padding:9px 11px;border-bottom:1px solid " + V.line + ";flex:none}",
      ".ddc-search{width:100%;box-sizing:border-box;background:" + V.solid + ";color:" + V.fg + ";",
      "border:1px solid " + V.line + ";border-radius:8px;padding:6px 9px;font-size:12.5px;",
      "outline:none;font-family:inherit}",
      ".ddc-search:focus{border-color:" + V.accent + "}",
      ".ddc-search::placeholder{color:" + V.faint + "}",
      ".ddc-hint{margin-top:6px;font-size:10.5px;color:" + V.faint + ";display:flex;gap:10px;flex-wrap:wrap}",
      ".ddc-hint kbd{border:1px solid " + V.line + ";border-radius:4px;padding:0 4px;font-size:10px;",
      "font-family:inherit;background:" + V.hover + ";color:" + V.dim + "}",

      ".ddc-list{overflow:auto;padding:5px;flex:1}",
      ".ddc-row{display:flex;align-items:center;gap:7px;border-radius:7px;padding:5px 6px;cursor:pointer;",
      "border:1px solid transparent}",
      ".ddc-row:hover{background:" + V.hover + "}",
      ".ddc-row.cur{background:" + V.active + ";border-color:" + V.accent + "}",
      ".ddc-main{display:flex;align-items:center;gap:7px;flex:1;min-width:0}",
      ".ddc-tw{width:14px;flex:none;text-align:center;color:" + V.faint + ";font-size:9px}",
      /* 左边三角也是真开关（不再是点一下就静默插 ID 的装饰），所以要有"能点"的样子 */
      ".ddc-tw.tap{cursor:pointer;border-radius:4px;width:14px;height:16px;display:inline-flex;",
      "align-items:center;justify-content:center}",
      ".ddc-tw.tap:hover{background:" + V.hover + ";color:" + V.fg + "}",
      ".ddc-led{width:6px;height:6px;border-radius:50%;flex:none;background:#9aa4b2}",
      ".ddc-led.ok{background:#12a05c}.ddc-led.bad{background:#e5484d}.ddc-led.warn{background:" + V.warn + "}",
      ".ddc-nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ddc-id{color:" + V.faint + ";font-size:11px;overflow:hidden;text-overflow:ellipsis;",
      "white-space:nowrap;flex:none;max-width:44%}",
      ".ddc-tag{font-size:9.5px;padding:0 5px;border-radius:5px;flex:none;border:1px solid currentColor;opacity:.9}",
      ".ddc-tag.warn{color:" + V.warn + "}.ddc-tag.ok{color:#12a05c}",
      ".ddc-chev{width:20px;height:20px;flex:none;border-radius:5px;display:flex;align-items:center;",
      "justify-content:center;color:" + V.faint + ";font-size:10px}",
      ".ddc-chev:hover{background:" + V.hover + ";color:" + V.fg + "}",
      ".ddc-chev.ph{visibility:hidden}",
      ".ddc-empty{padding:18px;text-align:center;color:" + V.faint + ";font-size:12px}",
      ".ddc-foot{padding:6px 11px;border-top:1px solid " + V.line + ";font-size:10.5px;",
      "color:" + V.faint + ";flex:none;display:flex;justify-content:space-between;gap:10px}",
      ".ddc-toast{color:" + V.accent + "}",
      ".ddc-ep{color:" + V.faint + ";padding-right:8px}",
      /* 页脚右侧区：接入点 + 权限按钮并列，中间用竖线分开 */
      ".ddc-right{margin-left:auto;display:flex;align-items:center;gap:7px}",
      ".ddc-sep{width:1px;height:11px;background:" + V.line + "}",
      /* 权限按钮：一眼能看出"现在是只读还是完全权限" */
      ".ddc-perm{border:1px solid " + V.line + ";background:transparent;color:" + V.dim + ";",
      "border-radius:6px;padding:1px 7px;font-size:10.5px;cursor:pointer;font-family:inherit;",
      "line-height:1.7;display:flex;align-items:center;gap:4px;white-space:nowrap}",
      ".ddc-perm:hover{border-color:" + V.accent + ";color:" + V.accent + "}",
      ".ddc-perm.root{color:#c26a00;border-color:rgba(194,106,0,.5);background:rgba(194,106,0,.07)}",
      ".ddc-perm.root:hover{border-color:#c26a00;color:#c26a00}",
      ".ddc-perm:disabled{opacity:.55;cursor:default}",
      ".ddc-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}",
      /* 全部接入点都不通时的提示区：必须给出"下一步做什么"，而不是只报错 */
      ".ddc-fail{padding:16px 14px;text-align:center}",
      ".ddc-failmsg{color:#e5484d;font-size:12.5px;margin-bottom:10px}",
      ".ddc-switch{display:flex;flex-direction:column;gap:6px;align-items:center}",
      ".ddc-switchhint{color:" + V.faint + ";font-size:11px;margin-bottom:2px}",
      ".ddc-swbtn{border:1px solid " + V.line + ";background:" + V.solid + ";color:" + V.fg + ";",
      "border-radius:7px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;min-width:120px}",
      ".ddc-swbtn:hover{border-color:" + V.accent + ";color:" + V.accent + "}",
      ".ddc-swbtn:disabled{opacity:.55;cursor:default}",
    ].join("");

    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-ddc="' + CSS_TAG + '"]')) return;
      var s = document.createElement("style");
      s.setAttribute("data-ddc", CSS_TAG);
      s.textContent = CSS;
      document.head.append(s);
    }

    // ------------------------------------------------------------------
    // 状态
    // ------------------------------------------------------------------
    var LED = { healthy: "ok", down: "bad", degraded: "warn" };

    function ledClass(node) {
      if (node.lifecycle === "retired") return "";
      var h = node.health;
      return LED[h] || (node.last_ok === true ? "ok" : node.last_ok === false ? "bad" : "");
    }

    // ------------------------------------------------------------------
    // 树的纯逻辑（不碰 React state，可被 test/tree-logic.test.mjs 直接测）
    //
    // 教训（2026-09-25，用户报"想折叠这一行，结果第一行动了"）：
    // 这里原先把"默认展开第一层"写成了一次性**哨兵** —— `expanded` 为空就临时
    // 展开全部顶层，而且只写进渲染期副本 `exp2`。于是用户点任意一行的折叠三角时，
    // `expanded` 从空变非空 → 哨兵当场失效 → **其它所有顶层行一起折叠**
    // （看起来就是"第一行折叠/展开了"）；把最后一行也折叠掉时哨兵又生效，
    // 全部弹开，折叠不掉。现在默认展开在数据到位时写进 `expanded`（唯一真源），
    // 其余地方只读它。
    // ------------------------------------------------------------------

    /** 把原始树包成 entries：{ node, children:[entry] }，让 flatten/prune 只认一种形状。 */
    function toEntries(nodes) {
      var out = [];
      for (var i = 0; i < (nodes || []).length; i++) {
        var n = nodes[i];
        out.push({ node: n, children: toEntries(n.children) });
      }
      return out;
    }

    /** 扁平化成渲染用的行，带层级与"是不是父节点"。展开状态只读 open。 */
    function flatten(entries, depth, open, out) {
      out = out || [];
      for (var i = 0; i < (entries || []).length; i++) {
        var e = entries[i];
        out.push({ node: e.node, depth: depth, hasKids: e.children.length > 0 });
        if (e.children.length && open.has(e.node.id)) {
          flatten(e.children, depth + 1, open, out);
        }
      }
      return out;
    }

    function matchNode(n, q) {
      if (!q) return true;
      // 自己兜住大小写：调用方已经 lower 过，但让这个函数自洽更省心
      q = String(q).toLowerCase();
      return ((n.id || "") + " " + (n.name || "") + " " + (n.hostname || "") + " " +
        (n.description || "")).toLowerCase().indexOf(q) >= 0;
    }

    /**
     * 搜索时把树剪成"只留命中节点 + 它们的祖先链"。
     *
     * 以前是"整树扁平化后再 filter 单行"，命中的深层节点会以带缩进的样子直接
     * 出现在顶层（父行被 filter 掉了），看着像列表坏了。剪枝顺带解决这件事：
     * 保留下来的父节点必然有命中后代，展开它才有意义。
     */
    function prune(entries, q) {
      if (!q) return entries;
      var out = [];
      for (var i = 0; i < (entries || []).length; i++) {
        var e = entries[i];
        var kids = prune(e.children, q);
        if (kids.length || matchNode(e.node, q)) out.push({ node: e.node, children: kids });
      }
      return out;
    }

    /** 默认展开第一层：只返回 id 集合，由调用方写进 state。 */
    function defaultExpanded(tree) {
      var s = new Set();
      for (var i = 0; i < (tree || []).length; i++) s.add(tree[i].id);
      return s;
    }

    /** 搜索态要展开的行 = 所有"有保留子节点"的父节点（结果很短，全展开最好读）；临时集合，不写回 state。 */
    function openedForSearch(entries, out) {
      out = out || new Set();
      for (var i = 0; i < (entries || []).length; i++) {
        if (entries[i].children.length) {
          out.add(entries[i].node.id);
          openedForSearch(entries[i].children, out);
        }
      }
      return out;
    }

    /**
     * 光标按**节点 id** 记，不按数组下标 —— 下标会随展开/折叠/搜索漂移，
     * 那正是"高亮和实际动作对不上、不知道自己在哪"的来源。
     * 找不到 id（首次打开、刚换了搜索词）才回到第一行。
     */
    function resolveCursor(rows, id) {
      for (var i = 0; i < (rows || []).length; i++) if (rows[i].node.id === id) return i;
      return 0;
    }

    function DeviceButton(props) {
      ensureCss();
      var insert = props.insert;

      var openState = useState(false);
      var open = openState[0], setOpen = openState[1];

      var dataState = useState(null);   // { tree, creds, runners }
      var data = dataState[0], setData = dataState[1];

      var loadedState = useState(false);
      var loaded = loadedState[0], setLoaded = loadedState[1];

      var qState = useState("");
      var q = qState[0], setQ = qState[1];

      var expState = useState(function () { return new Set(); });
      var expanded = expState[0], setExpanded = expState[1];

      // 光标 = **节点 id**（不是数组下标）。折叠/展开会改变行数与顺序，
      // 下标光标会漂到别的行上 —— 那正是"高亮和动作对不上"的来源。
      var curState = useState("");
      var curId = curState[0], setCurId = curState[1];

      var toastState = useState("");
      var toast = toastState[0], setToast = toastState[1];

      var switchingState = useState("");
      var switching = switchingState[0], setSwitching = switchingState[1];

      // Agent 通道权限：null = 还没读到，"read" / "root"。
      // 从控制面读，不从前端配置猜 —— 控制面才是权威，前端只是它的投影。
      var permState = useState(null);
      var perm = permState[0], setPerm = permState[1];
      var permBusyState = useState(false);
      var permBusy = permBusyState[0], setPermBusy = permBusyState[1];

      var wrapRef = useRef(null);
      var inputRef = useRef(null);

      // 每次打开都重读一次权限 —— 它可能在别处（设置页 / Web 控制台）被改过
      useEffect(function () {
        if (!open) return;
        var alive = true;
        fetch(PERM_API, { headers: { accept: "application/json" } })
          .then(function (r) { return r.json(); })
          .then(function (b) { if (alive && b && b.ok) setPerm(b.readOnly ? "read" : "root"); })
          .catch(function () {});
        return function () { alive = false; };
      }, [open, loaded]);

      /** 切换权限：read <-> root。走控制面，因为它只允许"人"改。 */
      function togglePerm() {
        if (permBusy) return;
        var next = perm === "root" ? "read" : "root";
        setPermBusy(true);
        fetch(PERM_API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ level: next }),
        })
          .then(function (r) { return r.json(); })
          .then(function (r) {
            setPermBusy(false);
            if (r && r.ok) {
              setPerm(next);
              setToast(next === "root" ? "已放开：Agent 可执行操作" : "已收紧：Agent 只读");
              setTimeout(function () { setToast(""); }, 2600);
            } else {
              setToast((r && r.error) || "切换失败");
            }
          })
          .catch(function () { setPermBusy(false); setToast("切换失败"); });
      }

      // 运行时测量可用空间，决定面板朝上还是朝下、最高多少。
      // 不这么做就只能靠 CSS 猜，而按钮纵坐标会随窗口高度与 Composer 状态变化。
      var placeState = useState(null);
      var place = placeState[0], setPlace = placeState[1];

      useEffect(function () {
        if (!open) return;
        var measure = function () {
          var el = wrapRef.current;
          if (!el) return;
          var b = el.getBoundingClientRect();
          var GAP = 8, PAD = 10;
          var above = b.top - GAP - PAD;
          var below = (window.innerHeight || 800) - b.bottom - GAP - PAD;
          // 上方能放下 240px 就朝上，否则朝下（哪边更宽裕）
          var up = above >= 240 || above >= below;
          var avail = Math.max(180, Math.min(440, up ? above : below));
          var width = Math.max(260, Math.min(400, (window.innerWidth || 1200) - 24));
          var left = Math.max(PAD, Math.min(b.left, (window.innerWidth || 1200) - width - PAD));
          setPlace({
            up: up, width: width, left: left,
            maxHeight: avail,
            top: up ? (b.top - GAP - avail) : (b.bottom + GAP),
          });
        };
        measure();
        window.addEventListener("resize", measure);
        return function () { window.removeEventListener("resize", measure); };
      }, [open]);

      // 打开时才拉数据：这个面板不该在每次渲染时都打控制面
      useEffect(function () {
        if (!open || loaded) return;
        var alive = true;
        fetch(API, { headers: { accept: "application/json" } })
          .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
          .then(function (x) {
            if (!alive) return;
            var b = x.body || {};
            if (b.ok) {
              setData(b.result);
              // 默认展开第一层 —— 写进 state（唯一真源），不再是渲染期的临时哨兵
              setExpanded(defaultExpanded((b.result && b.result.tree) || []));
            } else {
              // 全部接入点都不通：保留 endpoints 列表，让用户能直接切
              setData({ tree: [], error: b.error || "无法连接控制面", endpoints: b.endpoints || [], mode: b.mode });
            }
            setLoaded(true);
          })
          .catch(function () { if (alive) { setData({ tree: [], error: "无法连接控制面" }); setLoaded(true); } });
        return function () { alive = false; };
      }, [open, loaded]);

      /** 切换接入点：写回设置后重新拉一次。 */
      function switchMode(id) {
        setSwitching(id);
        fetch("/dsh-device-center/mode", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: id }),
        })
          .then(function (r) { return r.json(); })
          .then(function (r) {
            setSwitching("");
            if (r && r.ok) { setLoaded(false); setData(null); setExpanded(new Set()); setCurId(""); }
            else { setToast("切换失败：" + ((r && r.error) || "未知错误")); }
          })
          .catch(function () { setSwitching(""); setToast("切换失败"); });
      }

      // 点外面关掉
      useEffect(function () {
        if (!open) return;
        var onDoc = function (e) {
          if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener("mousedown", onDoc);
        return function () { document.removeEventListener("mousedown", onDoc); };
      }, [open]);

      // 打开后自动聚焦搜索框。
      // 必须等 `place` 有了才行：第一帧浮层还是 visibility:hidden，而隐藏元素
      // **不可聚焦**，focus() 静默失败 —— 于是焦点留在「设备」按钮上，方向键/Enter
      // 全被按钮吃掉（Enter/空格只会把面板再关掉）。用户报的"不知道在哪"里有这一份。
      useEffect(function () {
        if (open && place && inputRef.current) inputRef.current.focus();
      }, [open, place]);

      var tree = (data && data.tree) || [];
      var ql = q.trim().toLowerCase();

      var entries = prune(toEntries(tree), ql);
      // 搜索时展开的是"命中路径"，临时算出来、**不写回 state**；清空搜索即恢复用户自己的展开状态
      var exp2 = ql ? openedForSearch(entries) : expanded;
      var rows = flatten(entries, 0, exp2);
      var curIndex = resolveCursor(rows, curId);

      /** 展开/折叠。**光标跟着被操作的那一行走** —— 动作落在哪，焦点就停在哪。 */
      function toggle(id) {
        var s = new Set(expanded);
        if (s.has(id)) s.delete(id); else s.add(id);
        setExpanded(s);
        setCurId(id);
      }

      /** 光标按 id 移动到某一行（越界不动作）。 */
      function moveTo(i) {
        var r = rows[Math.max(0, Math.min(rows.length - 1, i))];
        if (r) setCurId(r.node.id);
      }

      /** 选中：把资源 ID 追加进对话框（不覆盖用户已经打的内容）。 */
      function pick(node) {
        var id = node.id;
        try {
          insert(id);
          setToast("已加入：" + id);
          setTimeout(function () { setToast(""); }, 1400);
        } catch (e) {
          setToast("插入失败，请手动复制");
        }
      }

      /**
       * 键盘。三条原则，都是这次踩坑换来的：
       *  1. Enter 严格等于提示条上的「加入」，不再对父节点偷偷变成"折叠"
       *     —— 用户就是按提示按的，行为必须和提示一致。
       *  2. 展开/折叠归 空格 / ← / →；所有方向性操作都基于"光标所在的那一行"，
       *     而光标按 id 记，折叠不会把它挪到别人身上。
       *  3. 搜索框优先：空格/←/→ 在框里有字时留给文本框；裸数字一律当输入
       *     （原来那个 "1-9 快速选" 会把数字查询的第一个按键吃掉，已删）。
       */
      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          // 先清搜索词，再关窗：一次 Esc 只做一件事，别把面板一起关掉
          if (q) setQ("");
          else setOpen(false);
          return;
        }
        if (e.key === "ArrowDown") { e.preventDefault(); moveTo(curIndex + 1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); moveTo(curIndex - 1); return; }

        var row = rows[curIndex];
        var kids = !!(row && row.hasKids);
        // 搜索框里有字时，空格/←/→ 属于文本框（要能打空格、要能移动光标）；
        // 空框时它们才是树的快捷键。↑↓/Tab/Enter 一向是浮层的键，保持不变。
        var treeKeys = !q;

        if (treeKeys && (e.key === " " || e.key === "Spacebar")) {
          e.preventDefault();
          if (!row) return;
          if (kids) toggle(row.node.id); else pick(row.node);
          return;
        }
        if (treeKeys && e.key === "ArrowRight") {
          e.preventDefault();
          if (!row || !kids) return;
          if (exp2.has(row.node.id)) moveTo(curIndex + 1);   // 已展开 -> 进入第一个子节点
          else toggle(row.node.id);
          return;
        }
        if (treeKeys && e.key === "ArrowLeft") {
          e.preventDefault();
          if (!row) return;
          if (kids && exp2.has(row.node.id)) { toggle(row.node.id); return; }
          // 否则往上找最近的一个更浅的行（它的父行）
          for (var j = curIndex - 1; j >= 0; j--) {
            if (rows[j].depth < row.depth) { setCurId(rows[j].node.id); return; }
          }
          return;
        }
        if (e.key === "Tab") {
          // Tab = 进入下一层级（对 @ 文件列表那一套交互的直译）
          e.preventDefault();
          if (!row) return;
          if (kids && !exp2.has(row.node.id)) { toggle(row.node.id); return; }
          moveTo(curIndex + (e.shiftKey ? -1 : 1));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          if (row) pick(row.node);
          return;
        }
        // 这里**刻意不再有 "1-9 快速选"**。
        // 搜索框是自动聚焦的，裸数字根本没法区分"搜 100.104"和"选第 1 行"：
        // 用户想打数字查询，第一个按键就被吃掉并插入了一条设备的 ID —— 正是
        // "我什么都没点，却动了一行"那一类。而列表并没有显示行号，这个快捷键
        // 除了制造误解几乎没有收益。（要恢复：在这里按 !q 的条件放回即可。）
      }

      var count = (data && data.count) || 0;

      var button = h("button", {
        className: "ddc-btn" + (open ? " on" : ""),
        title: "设备中心 —— 从资源图里挑一台设备加进对话",
        onClick: function () { setOpen(!open); },
        type: "button",
      }, h("span", { className: "ddc-dot" }), "设备");

      if (!open) return h("div", { className: "ddc-wrap", ref: wrapRef }, button);

      var list = null;
      var eps = (data && data.endpoints) || [];
      if (!loaded) {
        list = h("div", { className: "ddc-empty" }, "载入中…");
      } else if (data && data.error) {
        // 全部接入点都不通 —— 这是最需要给出路的时候：直接把能切的列出来
        var others = eps.filter(function (e) { return !e.active && e.url; });
        list = h("div", { className: "ddc-fail" },
          h("div", { className: "ddc-failmsg" }, data.error),
          others.length
            ? h("div", { className: "ddc-switch" },
                h("div", { className: "ddc-switchhint" }, "换一条路试试："),
                others.map(function (e) {
                  return h("button", {
                    key: e.id,
                    className: "ddc-swbtn",
                    disabled: switching !== "",
                    onClick: function () { switchMode(e.id); },
                  }, switching === e.id ? "切换中…" : e.label);
                })
              )
            : h("div", { className: "ddc-switchhint" }, "没有配置其他接入点 —— 请在设置页 device-center 里填 lan / tailscale / cloudflare")
        );
      } else if (!rows.length) {
        list = h("div", { className: "ddc-empty" }, ql ? "没有匹配的设备" : "资源图为空");
      } else {
        list = rows.map(function (r, i) {
          var n = r.node;
          var kids = r.hasKids;
          var isOpen = exp2.has(n.id);
          var cr = (data.credentials || {})[n.id];
          var run = (data.runners || {})[n.id];

          var tags = [];
          if (cr === "missing") tags.push(h("span", { key: "c", className: "ddc-tag warn" }, "凭据待配"));
          if (run && run.live) tags.push(h("span", { key: "r", className: "ddc-tag ok" }, "RUNNER"));

          // 左右两个三角都是**真开关**，指向同一行、同一语义。
          // 教训：左边那个以前只是 main 里的装饰 span，自己没有 onClick，
          // 于是点击冒泡到 main → 静默把资源 ID 插进对话框（用户以为"点了没用"）。
          var tw = kids
            ? h("span", {
                className: "ddc-tw tap",
                title: isOpen ? "折叠" : "展开",
                "aria-expanded": isOpen,
                onClick: function (e) { e.stopPropagation(); toggle(n.id); },
              }, isOpen ? "▼" : "▶")
            : h("span", { className: "ddc-tw" }, "");

          var main = h("div", {
            className: "ddc-main",
            onClick: function () { pick(n); },
            title: "加入对话框：" + n.id,
          },
            tw,
            h("span", { className: "ddc-led " + ledClass(n) }),
            h("span", { className: "ddc-nm" }, n.name || n.id),
            n.hostname ? h("span", { className: "ddc-id" }, n.hostname) : null,
            tags
          );

          var chev = kids
            ? h("div", {
                className: "ddc-chev",
                title: isOpen ? "折叠" : "展开",
                "aria-expanded": isOpen,
                onClick: function (e) { e.stopPropagation(); toggle(n.id); },
              }, isOpen ? "▾" : "▸")
            : h("div", { className: "ddc-chev ph" }, "·");

          return h("div", {
            key: n.id,
            className: "ddc-row" + (i === curIndex ? " cur" : ""),
            style: { paddingLeft: (6 + r.depth * 14) + "px" },
            onMouseEnter: function () { setCurId(n.id); },
            // 点列表时别把焦点从搜索框拿走 —— 否则弹出层的 onKeyDown 收不到事件，
            // 点一下列表方向键/Enter 就全"死"了
            onMouseDown: function (e) { e.preventDefault(); },
          }, main, chev);
        });
      }

      var pop = h("div", {
        className: "ddc-pop",
        onKeyDown: onKey,
        style: place ? {
          top: place.top + "px",
          left: place.left + "px",
          width: place.width + "px",
          maxHeight: place.maxHeight + "px",
        } : { visibility: "hidden", top: 0, left: 0, width: "392px" },
      },
        h("div", { className: "ddc-head" },
          h("input", {
            ref: inputRef,
            className: "ddc-search",
            placeholder: "搜索设备 / ID / 主机名…",
            value: q,
            onChange: function (e) { setQ(e.target.value); setCurId(""); },
          }),
          h("div", { className: "ddc-hint" },
            h("span", null, h("kbd", null, "Enter"), " 加入"),
            h("span", { title: "搜索框为空时空格 / 左右键负责展开折叠；框里有字时它们留给文本框" },
              h("kbd", null, "空格 ←→"), " 展开/折叠"),
            h("span", null, h("kbd", null, "Tab"), " 进下一层"),
            h("span", null, h("kbd", null, "Esc"), " 关闭")
          )
        ),
        h("div", { className: "ddc-list" }, list),
        h("div", { className: "ddc-foot" },
          h("span", null, count ? count + " 个资源" : ""),
          h("span", { className: "ddc-toast" }, toast),
          h("span", { className: "ddc-right" },
            // 显示这次实际走的是哪条路 —— 排查"为什么慢"时这是第一个要看的信息
            (data && data.endpoint && !data.error)
              ? h("span", { className: "ddc-ep", title: data.endpoint.url }, "经 " + data.endpoint.label)
              : null,
            // 权限开关。放在页脚最后，与"接入方式"并列 —— 两者都是
            // "Agent 现在能做什么"这个问题的答案，摆在一起才讲得通。
            (data && data.endpoint && !data.error) ? h("span", { className: "ddc-sep" }) : null,
            perm
              ? h("button", {
                  className: "ddc-perm" + (perm === "root" ? " root" : ""),
                  onClick: togglePerm,
                  disabled: permBusy,
                  title: perm === "root"
                    ? "Agent 拥有完全权限：可执行命令、重启服务。点击收紧为只读查询。"
                    : "Agent 只能读取资源图。点击放开为完全权限（可执行操作）。",
                },
                  h("span", { className: "ddc-dot" }),
                  permBusy ? "…" : (perm === "root" ? "完全权限" : "只读查询")
                )
              : null
          )
        )
      );

      return h("div", { className: "ddc-wrap", ref: wrapRef }, button, pop);
    }

    // ------------------------------------------------------------------
    // 设置页
    //
    // 挂在 settings.section（root 作用域的 list slot）。
    // 契约（dsh-client-ui-slots）：`SlotComponent<P> = (props) => ReactNode`，
    // 且 register 是**两个参数** register(options, component) ——
    // 有老插件把 component 塞进 options 里，那是遗留写法，别照抄。
    // ------------------------------------------------------------------
    var SET_CSS = [
      ".ddc-set{padding:2px 0 24px;max-width:720px;font-size:13px;color:" + V.fg + "}",
      ".ddc-set h3{margin:0 0 4px;font-size:15px;font-weight:600}",
      ".ddc-set .sub{color:" + V.faint + ";font-size:12px;margin-bottom:16px;line-height:1.7}",
      ".ddc-srow{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid " + V.line + "}",
      ".ddc-srow .lbl{width:132px;flex:none;color:" + V.dim + "}",
      ".ddc-srow .ctl{flex:1;min-width:0;display:flex;gap:8px;align-items:center}",
      ".ddc-sin{flex:1;min-width:0;box-sizing:border-box;background:" + V.solid + ";color:" + V.fg + ";",
      "border:1px solid " + V.line + ";border-radius:8px;padding:6px 9px;font-size:12.5px;outline:none;font-family:inherit}",
      ".ddc-sin:focus{border-color:" + V.accent + "}",
      ".ddc-sin::placeholder{color:" + V.faint + "}",
      ".ddc-sel{background:" + V.solid + ";color:" + V.fg + ";border:1px solid " + V.line + ";",
      "border-radius:8px;padding:6px 9px;font-size:12.5px;font-family:inherit;outline:none;min-width:150px}",
      ".ddc-sbtn{border:1px solid " + V.line + ";background:" + V.solid + ";color:" + V.fg + ";",
      "border-radius:8px;padding:6px 12px;font-size:12.5px;cursor:pointer;font-family:inherit;white-space:nowrap}",
      ".ddc-sbtn:hover{border-color:" + V.accent + ";color:" + V.accent + "}",
      ".ddc-sbtn:disabled{opacity:.5;cursor:default}",
      ".ddc-sbtn.pri{background:" + V.accent + ";border-color:" + V.accent + ";color:#fff}",
      ".ddc-sbtn.pri:hover{filter:brightness(1.08);color:#fff}",
      ".ddc-stat{font-size:11.5px;white-space:nowrap;min-width:74px}",
      ".ddc-stat.ok{color:#12a05c}.ddc-stat.bad{color:#e5484d}.ddc-stat.idle{color:" + V.faint + "}",
      ".ddc-msg{margin-top:12px;padding:9px 12px;border-radius:8px;font-size:12.5px;line-height:1.6;",
      "border:1px solid " + V.line + ";background:" + V.solid + "}",
      ".ddc-msg.ok{border-color:rgba(18,160,92,.45);color:#12a05c}",
      ".ddc-msg.bad{border-color:rgba(229,72,77,.45);color:#e5484d}",
      ".ddc-actions{display:flex;gap:8px;margin-top:18px}",
    ].join("");

    function ensureSetCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-ddc="settings"]')) return;
      var s = document.createElement("style");
      s.setAttribute("data-ddc", "settings");
      s.textContent = SET_CSS;
      document.head.append(s);
    }

    var MODE_LABELS = { auto: "自动（推荐）", lan: "局域网", tailscale: "Tailscale", cloudflare: "Cloudflare" };

    function DeviceSettings() {
      ensureSetCss();
      var cfgS = useState(null); var cfg = cfgS[0], setCfg = cfgS[1];
      var msgS = useState(null); var msg = msgS[0], setMsg = msgS[1];
      var testS = useState({}); var tests = testS[0], setTests = testS[1];
      var busyS = useState(false); var busy = busyS[0], setBusy = busyS[1];

      function load() {
        fetch("/dsh-device-center/config")
          .then(function (r) { return r.json(); })
          .then(function (d) { if (d.ok) setCfg(d.config); else setMsg({ ok: false, text: d.error }); })
          .catch(function (e) { setMsg({ ok: false, text: "读取配置失败：" + e }); });
      }
      useEffect(function () { load(); }, []);

      function field(k, v) { var n = Object.assign({}, cfg); n[k] = v; setCfg(n); }

      function save() {
        setBusy(true); setMsg(null);
        fetch("/dsh-device-center/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: cfg.mode, lan: cfg.lan, tailscale: cfg.tailscale, cloudflare: cfg.cloudflare,
            timeoutMs: Number(cfg.timeoutMs) || 8000,
            // 密钥留空 = 不改，所以只在用户真的输入了才带上
            token: cfg.token || "",
            cloudflareClientId: cfg.cfId || "",
            cloudflareClientSecret: cfg.cfSecret || "",
          }),
        })
          .then(function (r) { return r.json(); })
          .then(function (r) {
            setBusy(false);
            if (r.ok) {
              setMsg({ ok: true, text: "已保存" + (r.changed && r.changed.length ? "：" + r.changed.join(", ") : "") });
              setCfg(Object.assign({}, cfg, { token: "", cfId: "", cfSecret: "" }));
              load();
            } else { setMsg({ ok: false, text: r.error }); }
          })
          .catch(function (e) { setBusy(false); setMsg({ ok: false, text: "保存失败：" + e }); });
      }

      function test(id) {
        setTests(Object.assign({}, tests, { [id]: { pending: true } }));
        fetch("/dsh-device-center/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: id }),
        })
          .then(function (r) { return r.json(); })
          .then(function (r) {
            var one = (r.results || [])[0] || { ok: false, error: r.error || "无结果" };
            setTests(Object.assign({}, tests, { [id]: one }));
          })
          .catch(function (e) { setTests(Object.assign({}, tests, { [id]: { ok: false, error: String(e) } })); });
      }

      if (!cfg) {
        return h("div", { className: "ddc-set" },
          h("h3", null, "设备中心"),
          h("div", { className: "sub" }, msg ? msg.text : "载入中…"));
      }

      function statusOf(id) {
        var t = tests[id];
        if (!t) return h("span", { className: "ddc-stat idle" }, "未测试");
        if (t.pending) return h("span", { className: "ddc-stat idle" }, "测试中…");
        if (t.ok) return h("span", { className: "ddc-stat ok" }, "通 " + t.ms + "ms" + (t.version ? " · v" + t.version : ""));
        return h("span", { className: "ddc-stat bad", title: t.error || "" }, "不通");
      }

      function epRow(id, label, hint) {
        return h("div", { className: "ddc-srow", key: id },
          h("div", { className: "lbl" }, label),
          h("div", { className: "ctl" },
            h("input", {
              className: "ddc-sin", value: cfg[id] || "", placeholder: hint,
              onChange: function (e) { field(id, e.target.value); },
            }),
            h("button", { className: "ddc-sbtn", onClick: function () { test(id); } }, "测试"),
            statusOf(id)
          )
        );
      }

      return h("div", { className: "ddc-set" },
        h("h3", null, "设备中心"),
        h("div", { className: "sub" },
          "个人基础设施控制面的接入方式。三条路都配好后用「模式」选一条；" +
          "选「自动」时会先试上次成功的那条，再按 局域网 → Tailscale → Cloudflare 依次尝试。"),

        h("div", { className: "ddc-srow" },
          h("div", { className: "lbl" }, "模式"),
          h("div", { className: "ctl" },
            h("select", {
              className: "ddc-sel", value: cfg.mode,
              onChange: function (e) { field("mode", e.target.value); },
            }, Object.keys(MODE_LABELS).map(function (k) {
              return h("option", { key: k, value: k }, MODE_LABELS[k]);
            })),
            h("span", { className: "ddc-stat idle" }, cfg.mode === "auto" ? "自动选路" : "固定走这条")
          )
        ),

        epRow("lan", "局域网", "http://192.168.0.135:8700"),
        epRow("tailscale", "Tailscale", "http://100.90.73.126:8700"),
        epRow("cloudflare", "Cloudflare", "https://infra.dynamytranslate.top"),

        h("div", { className: "ddc-srow" },
          h("div", { className: "lbl" }, "CF Access ID"),
          h("div", { className: "ctl" },
            h("input", {
              className: "ddc-sin", value: cfg.cfId || "",
              placeholder: cfg.cfIdSet ? "已配置（留空则不改）" : "Cloudflare Access Service Token 的 Client ID",
              onChange: function (e) { field("cfId", e.target.value); },
            })
          )
        ),
        h("div", { className: "ddc-srow" },
          h("div", { className: "lbl" }, "CF Access Secret"),
          h("div", { className: "ctl" },
            h("input", {
              className: "ddc-sin", type: "password", value: cfg.cfSecret || "",
              placeholder: cfg.cfSecretSet ? "已配置（留空则不改）" : "Service Token 的 Client Secret",
              onChange: function (e) { field("cfSecret", e.target.value); },
            })
          )
        ),
        h("div", { className: "ddc-srow" },
          h("div", { className: "lbl" }, "控制面令牌"),
          h("div", { className: "ctl" },
            h("input", {
              className: "ddc-sin", type: "password", value: cfg.token || "",
              placeholder: cfg.tokenSet ? "已配置（留空则不改）" : "控制台访问令牌",
              onChange: function (e) { field("token", e.target.value); },
            })
          )
        ),
        h("div", { className: "ddc-srow" },
          h("div", { className: "lbl" }, "控制台令牌"),
          h("div", { className: "ctl" },
            h("input", {
              className: "ddc-sin", type: "password", value: cfg.consoleToken || "",
              placeholder: cfg.consoleTokenSet ? "已配置（留空则不改）" : "与控制面令牌相同（/var/lib/infra-control/token）",
              onChange: function (e) { field("consoleToken", e.target.value); },
            })
          )
        ),

        // 权限：Agent 通道能做什么。这是**授权**而不是配置，所以单独成组并给出风险说明。
        h("div", { className: "ddc-srow" },
          h("div", { className: "lbl" }, "Agent 权限"),
          h("div", { className: "ctl" },
            h("select", {
              className: "ddc-sel", value: cfg.perm || "read",
              onChange: function (e) { field("perm", e.target.value); },
            },
              h("option", { value: "read" }, "只读查询"),
              h("option", { value: "root" }, "完全权限")
            ),
            h("span", { className: "ddc-stat " + (cfg.perm === "root" ? "bad" : "idle") },
              cfg.perm === "root" ? "Agent 可执行操作" : "Agent 只能查看")
          )
        ),
        h("div", { className: "ddc-srow", style: { borderTop: "0", paddingTop: "2px" } },
          h("div", { className: "lbl" }, ""),
          h("div", { className: "ctl" },
            h("span", { style: { color: V.faint, fontSize: "11.5px", lineHeight: "1.65" } },
              "「完全权限」让 Agent 能在各节点上执行命令、重启服务（对话框浮层里也可随时切换）。" +
              "绿联 NAS 属于 Level 0，无论选哪档都禁止操作。")
          )
        ),
        h("div", { className: "ddc-srow" },
          h("div", { className: "lbl" }, "超时 (ms)"),
          h("div", { className: "ctl" },
            h("input", {
              className: "ddc-sin", style: { maxWidth: "120px" }, value: cfg.timeoutMs,
              onChange: function (e) { field("timeoutMs", e.target.value); },
            }),
            h("span", { className: "ddc-stat idle" }, "自动模式会逐条试，别设太大")
          )
        ),

        h("div", { className: "ddc-actions" },
          h("button", { className: "ddc-sbtn pri", disabled: busy, onClick: save },
            busy ? "保存中…" : "保存"),
          h("button", { className: "ddc-sbtn", disabled: busy, onClick: load }, "重新载入")
        ),

        msg ? h("div", { className: "ddc-msg " + (msg.ok ? "ok" : "bad") }, msg.text) : null,

        h("div", { className: "sub", style: { marginTop: "18px" } },
          "说明：密钥字段只显示「是否已配置」，不回显明文 —— 要改就重新输入一次，留空表示保持不变。" +
          "Cloudflare 那条还需要在 Cloudflare Zero Trust → Access → Service Auth 创建 Service Token，" +
          "并在应用策略里允许它，否则会被 302 拦到登录页。")
      );
    }

    // ------------------------------------------------------------------
    // 挂载
    // ------------------------------------------------------------------
    function apply(ctx) {
      try {
        var slots = ctx && ctx.get ? ctx.get("slots") : null;
        var sessions = ctx && ctx.get ? ctx.get("sessions") : null;
        if (!slots || !sessions) return;

        slots.inject("conversation.input.left", function () {
          return slots.register({
            name: "conversation.input.left",
            id: "device-center",
            order: 40,
            inject: function (sessionId) {
              var actx = sessions.scope(sessionId);
              if (actx === void 0) throw new Error("dsh-device-center: session scope unavailable");
              var conversation = actx.get("conversation");
              if (conversation === void 0) throw new Error("dsh-device-center: conversation unavailable");

              return {
                /**
                 * 把资源 ID 追加到草稿末尾 —— **绝不覆盖用户已经打的内容**。
                 *
                 * 这里踩过一个必须记住的坑：最初我用 `input.state.get()` 读当前草稿，
                 * 但 SnapshotStore 的读法是 `getSnapshot()`，`get` 根本不存在。
                 * 于是读取永远失败、cur 恒为空串，`setDraft(id)` 就把整段输入**替换**掉了
                 * （用户实测："之前的输入全没了"）。
                 *
                 * 现在两层保险：
                 *  1. 首选 scoped 事件 slash/input-insert-text —— span 的 start==end
                 *     即"纯插入"，不触碰其余文本；而且带 draftRev 做 CAS，
                 *     用户同时在打字时会被检测到，而不是被静默覆盖。
                 *  2. 事件不可用时退回 setDraft，但读取用正确的 getSnapshot()，
                 *     丢失的只是光标位置，不是内容。
                 */
                insert: function (text) {
                  var input = conversation.input.for(actx);

                  var snap = null;
                  try {
                    var st = input.state;
                    if (st && typeof st.getSnapshot === "function") snap = st.getSnapshot();
                    else if (st && typeof st.get === "function") snap = st.get();
                  } catch (_) { snap = null; }

                  var draft = snap && typeof snap.draft === "string" ? snap.draft : "";
                  var rev = snap && typeof snap.draftRev === "number" ? snap.draftRev : 0;
                  var at = draft.length;
                  var ins = draft && !/\s$/.test(draft) ? " " + text : text;

                  if (typeof actx.emit === "function") {
                    try {
                      var handled = actx.emit("slash/input-insert-text", {
                        text: ins,
                        span: { start: at, end: at, draftRev: rev },
                        continue: false,
                      });
                      if (handled === true) return;
                    } catch (_) { /* 落到回退 */ }
                  }

                  input.setDraft(draft ? draft.replace(/\s+$/, "") + " " + text : text);
                },
              };
            },
          }, DeviceButton);
        });

        // 设置页挂在 root 作用域，**不需要 sessions** —— 所以放在那个
        // `if (!slots || !sessions) return` 之后单独注册，但用一个独立判断，
        // 免得"会话服务不可用"把设置页也一起吞掉。
        slots.inject("settings.section", function () {
          return slots.register({
            name: "settings.section",
            id: "device-center",
            order: 60,
            label: function () { return "设备中心"; },
          }, DeviceSettings);
        });
      } catch (err) {
        if (typeof console !== "undefined") console.warn("dsh-device-center client:", err);
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "sessions"];
    // 测试缝：树/光标的纯逻辑给 test/tree-logic.test.mjs 用（宿主只读 apply/inject）
    exports.__internals = {
      toEntries: toEntries, flatten: flatten, prune: prune, matchNode: matchNode,
      defaultExpanded: defaultExpanded, openedForSearch: openedForSearch, resolveCursor: resolveCursor,
    };
    return module.exports;
  },
});
