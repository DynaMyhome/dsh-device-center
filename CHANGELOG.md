# Changelog

## 0.3.1 — 设备浮层展开/折叠与选中修复

- Peer range now also enumerates `0.1.7-alpha.2`. Verified on WSL (Ubuntu-24.04) running 0.1.7-alpha.2: all three access paths answered from inside the plugin process (LAN 125 ms, Tailscale 79 ms, Cloudflare ok) against control plane `0.19.8+seed-caddoc`.

用户报告的现象：「本来想展开或折叠**当前选中的这一行**，结果莫名其妙是第一行折叠/展开了，完全不知道自己在哪；而且每行左右各有一个三角，左边那个点了没用，右边才有效，很容易误解。」

根因（用一个 `node -e` 状态机复现确认，并写成回归测试 `test/tree-logic.test.mjs`）：

- **默认展开是一次性哨兵，不是状态。** `expanded` 为空时渲染期临时把全部顶层展开（只写进副本 `exp2`）。用户第一次点任意一行的折叠三角 → `expanded` 变非空 → 哨兵失效 → **其它所有顶层行一起折叠**（看起来就是"第一行动了"）；把最后一行也折叠掉时哨兵又生效 → 全部弹开，折叠不掉。现在默认展开在数据到位时写进 `expanded`（唯一真源）。
- **光标是数组下标**（`cur`），而行数与顺序随折叠/搜索变化；`cur >= rows.length` 时只改局部变量不改 state，于是高亮漂走、Tab/Enter 作用到别的行。现在光标按**节点 id** 记录，展开/折叠时光标跟着被操作的那一行。
- **左侧三角在 `ddc-main` 内部且没有自己的 onClick**，点击冒泡到行体 → 静默把资源 ID 插进对话框（用户以为"点了没用"）。现在左右两个三角都是真开关，`stopPropagation` 后只切换该行。
- **`1-9` 快速选没有排除搜索框** → 搜索框里打数字会立刻插入资源 ID（搜不了 `100.104`）。**该快捷键已移除**：搜索框自动聚焦时裸数字无法与"输入数字查询"区分，而列表并不显示行号，收益≈0、误解很大。要恢复就在 `onKey` 末尾按 `!q` 条件放回。
- **打开浮层后焦点留在「设备」按钮上**：自动聚焦的 effect 在 `place` 还是空（浮层 `visibility:hidden`）时执行，而隐藏元素不可聚焦，`focus()` 静默失败 → 方向键/Enter 全被按钮吃掉，Enter/空格只会把面板再关掉。现在等 `place` 就绪后再聚焦。
- **点一下列表焦点就从搜索框丢掉** → 弹出层的 `onKeyDown` 收不到事件，方向键/Enter 全失效。现在行级 `onMouseDown` 阻止焦点转移。

行为变更（用户 2026-09-25 拍板）：

| 键 | 行为 |
|---|---|
| Enter | 始终"加入光标行的资源 ID"（与提示条一致；不再对父节点偷偷变成折叠） |
| 空格 | 有子节点→展开/折叠；叶子→加入（搜索框为空时；框里有字时留给文本框打空格） |
| → / ← | 展开并进入第一个子节点 / 折叠或退回父行（同上，仅在搜索框为空时） |
| Tab | 保留"进下一层"；Shift+Tab 反向 |
| Esc | 先清空搜索词，再关面板 |

（`1-9 快速选` 已按上面的理由移除，提示条同步更新。）

另外：搜索改为**剪枝**（只留命中节点 + 祖先链），修掉了"命中的深层节点以孤立缩进行出现在顶层"的观感问题；搜索态展开是临时的，清空搜索即恢复用户自己的展开状态。宿主侧零改动（仍是 1 个工具、`op` 枚举不变）。

## 0.3.0 — DSH 0.1.7 compatibility

- Replaced `ctx.settings.register(ns, schema)` with the plugin's own `Config` schema (14 fields, all `.volatile()`).
- Added the `live()` unwrapper for `.volatile()` value holders.
- **Breaking for the overlay UI:** DSH 0.1.7 gives a host plugin no public way to write its own config, so `POST /dsh-device-center/config`, `POST /dsh-device-center/mode` and the perm write-back now return 501 with a pointer to the profile config form. Read paths, the resource graph, `annotate`, and the authoritative control-plane permission switch are unaffected.
- Peer ranges now cover 0.1.0-rc.7 .. 0.1.7-alpha.1; the `@deepseek-ai/dsh-settings` peer is gone. Verified booting on 0.1.7-alpha.1.
