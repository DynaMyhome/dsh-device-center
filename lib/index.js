/**
 * dsh-device-center — DeepSeek Harness 插件：你的设备中心
 *
 * **只有 1 个工具。** 这是刻意的硬约束（见 infra-control/AGENTS.md §4.1）：
 * 工具目录每增加一项都产生固定上下文开销并稀释工具选择准确率。原方案列了
 * 11 个 infra.* 工具，已否决 —— 能力全部通过 op 枚举扩展，工具数不变。
 *
 *   device_center(op, target?, params?)
 *
 * 插件本身**不含业务逻辑**：它只是控制面 Action Registry 的一个传输层。
 * 控制面的 REST 路由走的是同一个 Registry，所以人和 Agent 看到的行为永远一致
 * （AGENTS.md §4.2「一套 Action，两个前端」）。
 *
 * 配置在 DSH 设置页的 `device-center` 命名空间：
 *   baseUrl   控制面地址，LAN: http://192.168.0.135:8700
 *   token     访问令牌（与控制台登录用的是同一个）
 *
 * 注意：这个 token 只拿到 Agent 通道的权限（V0 上限为 READ）——
 * 能查、能写描述，不能重启服务或删资源。
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-device-center'

/** Tools service is injected by the cordis host. */
export const inject = ['tools']

/** Persisted settings namespace (kept for the legacy settings.yaml section name). */
export const SETTINGS_NAMESPACE = 'device-center'

/**
 * This entry's settings. 0.1.7 removed `ctx.settings.register(ns, schema)`: a
 * plugin's settings ARE its own Config now, persisted as the profile entry's
 * `config` in the profile Cordis patch and addressed by entry id
 * (`dsh-device-center`). `.volatile()` marks fields the Settings form may edit
 * on the live instance.
 */
export const Config = z.object({
  /**
   * 接入点。三个都填好，然后用 mode 选一个 —— 这样换网络环境不用改配置。
   *
   * 为什么要三个：控制面只在家里局域网里有一台 VM，但使用者会在外面。
   * 三条路各有取舍（实测 ttfb）：
   *   lan        局域网直连，52ms，最快，但只在同一个网段有效
   *   tailscale  158ms，**哪里都能用**（Tailscale 打洞或走 DERP 中继）
   *   cloudflare 463ms 起，且前面有 Cloudflare Access，需要 Service Token
   */
  lan: z.string().default('http://192.168.0.135:8700').volatile(),
  tailscale: z.string().default('http://100.90.73.126:8700').volatile(),
  cloudflare: z.string().default('https://infra.dynamytranslate.top').volatile(),
  /** Cloudflare Access Service Token（不是控制面的 token）。留空则该路径不可用。 */
  cloudflareClientId: z.string().default('').volatile(),
  cloudflareClientSecret: z.string().default('').volatile(),
  /** 选哪条路：auto 或 lan / tailscale / cloudflare。 */
  mode: z.string().default('auto').volatile(),
  /** 控制面访问令牌。 */
  token: z.string().default('').volatile(),
  /** 单次请求超时（毫秒）。auto 模式会按这个值逐条试。 */
  timeoutMs: z.number().min(1000).max(300000).default(30000).volatile(),
  /**
   * Agent 通道的默认权限上限。
   *
   *   'read'  —— 只能查（推荐）。Agent 能看资源图、写描述，但不能改机器。
   *   'root'  —— 完全权限。Agent 可执行 run_task / service_action。
   *
   * 这只是**默认值**：对话框浮层里可以随时临时切换，那个切换会写回控制面。
   * 控制面才是权威 —— 它按会话 cookie 鉴权，Agent 无法给自己提权。
   */
  perm: z.string().default('read').volatile(),
  /**
   * 控制台登录令牌（= /var/lib/infra-control/token）。
   *
   * 为什么需要两个令牌：控制面对"人"和"Agent"是两套鉴权。
   *   token（bearer）      —— Agent 通道，只读，且**不能给自己提权**
   *   consoleToken（会话） —— 人，可到 ADMIN，能改权限上限
   *
   * 设置页里点"切换权限"是在扮演**人**，所以必须用 consoleToken 登录取
   * 会话 cookie。这不是多余的：如果 Agent 能用 bearer 提权，那权限模型就白做了。
   */
  consoleToken: z.string().default('').volatile(),
  /** 兼容旧配置：只有 baseUrl 时当作局域网地址。 */
  baseUrl: z.string().default('').volatile(),
})

export const DEFAULT_SETTINGS = Object.freeze({
  lan: 'http://192.168.0.135:8700',
  tailscale: 'http://100.90.73.126:8700',
  cloudflare: 'https://infra.dynamytranslate.top',
  cloudflareClientId: '',
  cloudflareClientSecret: '',
  mode: 'auto',
  token: '',
  timeoutMs: 30000,
  perm: 'read',
  consoleToken: '',
  baseUrl: '',
})

/**
 * 模块级的活动配置。
 *
 * why：同源路由 `handleTree` 是模块级函数，闭包里拿不到 `apply` 的 config，
 * 而 HTTP 请求又要能读配置。用一个模块级引用把它们接起来。
 *
 * 0.1.7：settings seam 已删除，配置改由本插件的 Config 承载（profile patch 持久化）。
 * `.volatile()` 字段在 resolve 后是"活值容器"（带 get()），所以读取时统一解包。
 */
let activeConfig = null

/** 解包一个 `.volatile()` 容器；普通值原样返回。 */
function live(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try { return value.get() } catch { return undefined }
  }
  return value
}

function activeSettings() {
  let s = null
  try { s = activeConfig ?? null } catch { s = null }
  const get = (k) => live(s?.[k])
  const pick = (k, d) => (typeof get(k) === 'string' && get(k) ? get(k) : d)
  return {
    lan: pick('lan', DEFAULT_SETTINGS.lan),
    tailscale: pick('tailscale', DEFAULT_SETTINGS.tailscale),
    cloudflare: pick('cloudflare', DEFAULT_SETTINGS.cloudflare),
    cloudflareClientId: typeof get('cloudflareClientId') === 'string' ? get('cloudflareClientId') : '',
    cloudflareClientSecret: typeof get('cloudflareClientSecret') === 'string' ? get('cloudflareClientSecret') : '',
    mode: pick('mode', 'auto'),
    token: typeof get('token') === 'string' ? get('token') : '',
    timeoutMs: typeof get('timeoutMs') === 'number' ? get('timeoutMs') : DEFAULT_SETTINGS.timeoutMs,
    perm: get('perm') === 'root' ? 'root' : 'read',
    consoleToken: typeof get('consoleToken') === 'string' ? get('consoleToken') : '',
    // 旧配置兼容：只写了 baseUrl 的人，把它当成局域网地址
    legacyBaseUrl: typeof get('baseUrl') === 'string' ? get('baseUrl') : '',
  }
}

/** 候选接入点，按"优先尝试"的顺序排列。 */
function candidates(s) {
  const list = []
  if (s.legacyBaseUrl) list.push({ id: 'lan', label: '局域网（旧 baseUrl）', url: s.legacyBaseUrl })
  list.push({ id: 'lan', label: '局域网', url: s.lan })
  list.push({ id: 'tailscale', label: 'Tailscale', url: s.tailscale })
  list.push({ id: 'cloudflare', label: 'Cloudflare', url: s.cloudflare })
  // 去掉空地址，并按 id 去重（旧配置可能和 lan 重复）
  const seen = new Set()
  return list.filter(c => {
    if (!c.url || seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })
}

/**
 * 上一次成功的接入点。
 *
 * auto 模式下先用它 —— 否则每次请求都要从局域网开始逐个试，
 * 在外面时就会白白等一个必然超时的连接。
 */
let lastGood = { id: null, at: 0 }
const LAST_GOOD_TTL = 5 * 60 * 1000

/** 按 mode 决定尝试顺序。 */
function orderedCandidates(s) {
  const all = candidates(s)
  if (s.mode && s.mode !== 'auto') {
    const one = all.filter(c => c.id === s.mode)
    // 指定了模式但没配地址 -> 退回全部，并在错误里说明
    return one.length ? one : all
  }
  if (lastGood.id && Date.now() - lastGood.at < LAST_GOOD_TTL) {
    const preferred = all.filter(c => c.id === lastGood.id)
    return preferred.concat(all.filter(c => c.id !== lastGood.id))
  }
  return all
}

function headersFor(s, c) {
  const h = { Authorization: `Bearer ${s.token}` }
  if (c.id === 'cloudflare' && s.cloudflareClientId && s.cloudflareClientSecret) {
    // Cloudflare Access Service Token：没有它会被 302 到登录页
    h['CF-Access-Client-Id'] = s.cloudflareClientId
    h['CF-Access-Client-Secret'] = s.cloudflareClientSecret
  }
  return h
}

/**
 * 依次尝试接入点，返回第一个成功的响应。
 *
 * 失败时抛出的错误里带上**每条路的失败原因**，这样上层（工具或浮窗）
 * 能直接告诉用户"切到哪条能通"，而不是干巴巴一句"连不上"。
 */
async function fetchAny(s, path, init = {}) {
  const order = orderedCandidates(s)
  if (!order.length) {
    const e = new Error('device-center 没有配置任何接入点')
    e.attempts = []
    throw e
  }
  const attempts = []
  for (const c of order) {
    const url = c.url.replace(/\/+$/, '') + path
    try {
      const res = await fetch(url, {
        ...init,
        // 关键：不要自动跟随重定向。
        //
        // Cloudflare Access 的拦截是一个 302 跳到登录页。fetch 默认会**跟过去**，
        // 于是拿回一个 200（登录页的 HTML），看起来"通了"，实际完全没到控制面 ——
        // 表现为 JSON 解析失败、或者三条接入点全部显示 OK（实测踩到）。
        // manual 让 3xx 原样返回，才能识别出"这条被身份认证挡住了"。
        redirect: 'manual',
        headers: { ...headersFor(s, c), ...(init.headers || {}) },
        signal: AbortSignal.timeout(s.timeoutMs),
      })
      // 302/303/307 = 被 Access 拦截；0 = manual 下的不透明重定向；
      // 401/403 = 令牌不对或权限不足。都算"这条不通"，继续试下一条 ——
      // 这正是多接入点的意义。
      const blocked = res.status === 0 || (res.status >= 300 && res.status < 400) ||
        res.status === 401 || res.status === 403
      if (blocked) {
        attempts.push({ id: c.id, label: c.label, url: c.url, status: res.status, error: statusHint(res.status) })
        continue
      }
      lastGood = { id: c.id, at: Date.now() }
      return { res, endpoint: c, attempts }
    } catch (err) {
      attempts.push({ id: c.id, label: c.label, url: c.url, error: shortErr(err) })
    }
  }
  const e = new Error('所有接入点都无法访问')
  e.attempts = attempts
  throw e
}

function statusHint(code) {
  if (code === 0 || (code >= 300 && code < 400)) {
    return '被 Cloudflare Access 拦截（需要在设置页填 Service Token）'
  }
  if (code === 401) return '令牌无效'
  if (code === 403) return '权限不足'
  return `HTTP ${code}`
}

/**
 * 与 fetchAny 同一套接入点选择，但**不把 403 当作"这条不通"**。
 *
 * 为什么必须分开：fetchAny 的语义是"找一个能连上的接入点"，所以 401/403
 * 被当成路由失败继续试下一条。但带会话 cookie 调 /api/perm 时，403 是
 * **应用层的正常回答**（"你不是人"），不是接入点的问题。用 fetchAny 会导致
 * 三条路都被判失败，最终报"所有接入点都无法访问" —— 一个纯粹的假故障。
 *
 * 仍然把 3xx/0 当作不通（那是 Cloudflare Access 拦截，与请求内容无关）。
 *
 * `init.asHuman` 会**去掉 Authorization: Bearer** —— 见 handlePerm 里的说明，
 * 这不是可选项：控制面的 authKind() 先看 bearer 头，只要带了就永远判定为
 * Agent，会话 cookie 再对也没用。
 */
async function fetchAnyAccepting4xx(s, path, init = {}) {
  const { asHuman, ...rest } = init
  const order = orderedCandidates(s)
  if (!order.length) {
    const e = new Error('device-center 没有配置任何接入点')
    e.attempts = []
    throw e
  }
  const attempts = []
  for (const c of order) {
    const url = c.url.replace(/\/+$/, '') + path
    try {
      const base = headersFor(s, c)
      if (asHuman) delete base.Authorization
      const res = await fetch(url, {
        ...rest,
        redirect: 'manual',
        headers: { ...base, ...(rest.headers || {}) },
        signal: AbortSignal.timeout(s.timeoutMs),
      })
      // 只有"被身份认证挡住"才算这条路不通；4xx 是业务回答，原样返回。
      if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
        attempts.push({ id: c.id, label: c.label, url: c.url, status: res.status, error: statusHint(res.status) })
        continue
      }
      lastGood = { id: c.id, at: Date.now() }
      return { res, endpoint: c, attempts }
    } catch (err) {
      attempts.push({ id: c.id, label: c.label, url: c.url, error: shortErr(err) })
    }
  }
  const e = new Error('所有接入点都无法访问')
  e.attempts = attempts
  throw e
}

function shortErr(err) {
  const m = String(err?.message ?? err)
  if (/timeout|abort/i.test(m)) return '超时'
  if (/ECONNREFUSED|fetch failed/i.test(m)) return '连接被拒绝'
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return '域名解析失败'
  return m.slice(0, 80)
}

/** 给 UI/工具看的路由状态摘要。 */
function endpointStatus(s, activeId, attempts) {
  const byId = new Map((attempts || []).map(a => [a.id, a]))
  return candidates(s).map(c => ({
    id: c.id,
    label: c.label,
    url: c.url,
    active: c.id === activeId,
    error: byId.get(c.id)?.error || null,
    status: byId.get(c.id)?.status || null,
  }))
}

/** op 清单。写进工具描述里 —— 只有一个工具时，描述就是模型的全部依据。 */
const OPS = [
  // 读
  'status            控制面概览：资源/服务/凭据/Runner 计数',
  'list_resources    列出资源（可按 kind / zone / q 过滤）',
  'get_resource      取资源详情：描述、属性、端点可达性、能力、关系、凭据',
  'topology          资源图（不传 target 返回整棵树）',
  'find              按 kind / zone / q 搜索资源',
  'find_capability   按能力找节点，如 spectre.simulate；不传则列出全部能力',
  'list_services     服务清单与健康状态',
  'list_credentials  各节点的访问凭据状态（configured/untested/missing）',
  'list_runners      已接入的 Node Runner 及在线状态',
  'get_inventory     某节点的内部视角库存（OS/CPU/内存/磁盘/监听端口/systemd）',
  'get_relations     资源之间的关系（依赖/转发/暴露/承载）',
  'probe_history     最近的外部探测记录（哪个端点连得上）',
  'audit_tail        最近的操作审计',
  // 写（Agent 允许：只改元数据，爆炸半径为零）
  'annotate          写入/更新资源描述 —— 把「我查清楚了这是什么」沉淀下来',
  // 需要更高权限（Agent 通道会被拒，由人在控制台执行）
  'set_lifecycle     纳管/退役资源（CONTROL）',
  'set_credential_status  更新凭据状态（CONTROL）',
  'reset_annotation  把描述交还 seed 管理（CONTROL）',
  'delete_resource   物理删除（ADMIN）',
  'run_task / service_action  需 Node Runner 执行，V1 提供',
]

const RESOURCE_ID_HELP = [
  '资源 ID 用稳定身份寻址，不需要 IP/用户名/密码：',
  '  device:phy-d            物理设备（Phy-D 家庭电脑）',
  '  vm:cds1                 VMware 虚拟机（Radeon EDA 节点）',
  '  wsl:wsl-ubuntu          本机 WSL2 发行版',
  '  ctr:campus-vpn          容器',
  '  svc:hindsight-api       服务',
  '  host:windows-phy-d      宿主机操作系统',
].join('\n')

export function apply(ctx, config) {
  // 0.1.7：settings seam 已删除。本插件的配置就是自己的 Config（profile patch 持久化，
  // 条目 id = dsh-device-center）；挂到模块级，让同源路由与工具共用同一份读取逻辑。
  activeConfig = config ?? null

  /** 工具与路由统一走 activeSettings()，只有一处配置读取逻辑。 */
  const readSettings = activeSettings

  function renderText(text) {
    return [{ type: 'text', text }]
  }

  ctx.tools.register(defineTool({
    name: 'device_center',
    description:
      '你的设备中心：统一查看和管理你自己的机器与上面跑的东西 —— 物理设备 / 虚拟机 / WSL / 容器 / 服务 / 端点 / 能力 / 访问凭据。' +
      '用稳定身份（如 vm:cds1、svc:hindsight-api）寻址，**不需要 IP、用户名、密码或 SSH 命令**。\n' +
      '\n' +
      '当用户说「去看看 phyd-Top 的磁盘」「找一台能跑 Spectre 的节点」「hindsight 是不是挂了」' +
      '「我本地那个模型还能用吗」「哪台机器能远程操作」时用这个工具。\n' +
      '\n' +
      'op 取值：\n' +
      OPS.map(s => '  ' + s).join('\n') + '\n' +
      '\n' +
      RESOURCE_ID_HELP + '\n' +
      '\n' +
      '典型用法：\n' +
      '  device_center({op:"find_capability", params:{capability:"spectre.simulate"}})   找能跑 Spectre 的节点\n' +
      '  device_center({op:"get_inventory", target:"runner:87efc1c1964b"})               看某节点的内部状态\n' +
      '  device_center({op:"list_credentials"})                                          哪些节点还没配访问方式\n' +
      '  device_center({op:"probe_history", params:{limit:50}})                          看最近哪些端点连不上\n' +
      '  device_center({op:"annotate", target:"svc:xxx", params:{description:"..."}})    把你查清的结论写进资源图\n' +
      '\n' +
      '重要：**外部探测与内部库存是两回事**。Prober 说某端口连不上，可能只是防火墙拦截；' +
      '此时用 get_inventory 看 listen_ports，端口在听就说明服务是活的。不要只凭一个 DOWN 就下结论。',
    parameters: {
      op: {
        type: 'string',
        required: true,
        description: '操作名，见工具描述里的 op 清单',
      },
      target: {
        type: 'string',
        description: '目标资源 ID（如 vm:cds1、svc:hindsight-api、runner:xxx）。部分 op 需要。',
      },
      params: {
        type: 'object',
        additionalProperties: true,
        description: 'op 的参数，如 {capability:"spectre.simulate"}、{description:"..."}、{limit:50}',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, v) => {
        if (v && v.ok === false) return renderText(`infra 调用失败：${v.error}`)
        // 把"走了哪条接入点"显示出来 —— 否则排查"为什么慢/为什么通"时完全没有线索。
        // 注意它挂在 v 上而不是 v.result 里，所以不能只序列化 result。
        const ep = v && v._endpoint ? `经 ${v._endpoint.label}（${v._endpoint.url}）\n` : ''
        const body = JSON.stringify(v?.result ?? v, null, 2)
        const max = 40000
        return renderText(ep + (body.length > max ? body.slice(0, max) + '\n…(结果过长已截断)' : body))
      },
    },
    execute: async (args) => {
      const s = readSettings()
      if (!s.token) {
        throw new Error('device center 未配置 token：请在 DSH 设置页的 device-center 命名空间填入控制面访问令牌')
      }
      const body = { op: args.op, target: args.target ?? '', params: args.params ?? {}, actor: 'agent' }

      let picked
      try {
        picked = await fetchAny(s, '/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (e) {
        // 把每条接入点的失败原因一并交给模型 —— 它才能告诉用户"切到哪条能通"，
        // 而不是只回一句"连不上"然后卡住。
        const detail = (e.attempts || [])
          .map(a => `  - ${a.label} (${a.url}): ${a.error || statusHint(a.status)}`)
          .join('\n')
        throw new Error(
          `无法连接控制面。已尝试的接入点：\n${detail || '  （没有配置任何接入点）'}\n` +
          `请在 DSH 设置页的 device-center 里检查 mode 与各接入点地址。`
        )
      }

      const res = picked.res
      if (res.status === 401) {
        throw new Error('控制面拒绝了请求：token 无效，请检查 DSH 设置页的 device-center.token')
      }
      const data = await res.json().catch(() => ({}))
      if (res.status === 403) {
        // 权限不足不是错误用法，而是设计如此 —— 把原因原样交给模型，它会转告用户
        return { ok: false, op: args.op, error: data?.error ?? '权限不足' }
      }
      if (!res.ok) {
        throw new Error(`控制面返回 HTTP ${res.status}：${JSON.stringify(data).slice(0, 300)}`)
      }
      // 让模型知道这次走的是哪条路 —— 排查"为什么慢/为什么通了"时有用
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        data._endpoint = { id: picked.endpoint.id, label: picked.endpoint.label, url: picked.endpoint.url }
      }
      return data
    },
    timeoutMs: 60000,
  }))

  registerTreeRoute(ctx)
  registerModeRoute(ctx)
  registerPermRoute(ctx)
  registerConfigRoutes(ctx)
}

/** 设置页用的配置读写与连通性测试路由。 */
export const CONFIG_ROUTE = '/dsh-device-center/config'
export const TEST_ROUTE = '/dsh-device-center/test'

function registerConfigRoutes(ctx) {
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact', path: CONFIG_ROUTE, handler: handleConfig,
    }), 'dsh-device-center: config route')
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact', path: TEST_ROUTE, handler: handleTest,
    }), 'dsh-device-center: test route')
  })
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function json(res, code, body) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * GET  -> 当前配置。**密钥类字段只回"是否已设置"，不回明文。**
 * POST -> 局部更新；密钥字段只有传了非空值才覆盖（空串 = 不改）。
 *
 * 为什么不回明文：设置页虽然在本机，但把控制面令牌与 Cloudflare Secret
 * 渲染进 DOM 没有任何好处 —— 用户要改时重新输入一次即可。
 */
async function handleConfig(req, res) {
  if (!activeConfig) return json(res, 500, { ok: false, error: '插件配置不可用' })

  if (req.method === 'GET') {
    const s = activeSettings()
    return json(res, 200, {
      ok: true,
      config: {
        mode: s.mode,
        lan: s.lan,
        tailscale: s.tailscale,
        cloudflare: s.cloudflare,
        timeoutMs: s.timeoutMs,
        perm: s.perm,
        tokenSet: !!s.token,
        consoleTokenSet: !!s.consoleToken,
        cfIdSet: !!s.cloudflareClientId,
        cfSecretSet: !!s.cloudflareClientSecret,
      },
    })
  }

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })

  return json(res, 501, { ok: false, error: WRITE_UNAVAILABLE })
}

/**
 * 0.1.7 起，宿主插件没有写自身配置的公开接口：settings seam（`settings.register`
 * / `SettingsScope.update`）整个被删除，插件配置改由 Config + profile patch 承载，
 * 写入只能从 UI 的配置表单发起。所以本插件的三个写入路由暂时返回这条说明。
 *
 * 改配置的入口（改成后立即生效，无需重启）：
 *   DSH 设置 → 插件 → dsh-device-center，或直接编辑
 *   %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml 里 `id: dsh-device-center`
 *   条目的 `config:` 段。
 */
const WRITE_UNAVAILABLE =
  '本插件的配置写入在 DSH 0.1.7 上改为经 profile 配置表单:设置 → 插件 → dsh-device-center' +
  '(或编辑 profiles/web/cordis.patch.yml 中 id: dsh-device-center 的 config)。'

/** 单独测某条接入点，让设置页能直接说"这条通不通、多快"。 */
async function handleTest(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }

  const s = activeSettings()
  if (!s.token) return json(res, 200, { ok: false, error: '尚未配置控制面令牌' })

  const all = candidates(s)
  const targets = body.id ? all.filter(c => c.id === body.id) : all
  if (!targets.length) return json(res, 200, { ok: false, error: `没有名为 ${body.id} 的接入点` })

  const results = []
  for (const c of targets) {
    const url = c.url.replace(/\/+$/, '') + '/api/status'
    const t0 = Date.now()
    try {
      const r = await fetch(url, {
        // 同 fetchAny：不跟随重定向，否则 Access 的 302 会被当成"通了"
        redirect: 'manual',
        headers: headersFor(s, c),
        signal: AbortSignal.timeout(Math.min(s.timeoutMs, 10000)),
      })
      const ms = Date.now() - t0
      const blocked = r.status === 0 || (r.status >= 300 && r.status < 400) || r.status === 401 || r.status === 403
      if (blocked) {
        results.push({ id: c.id, label: c.label, url: c.url, ok: false, ms, error: statusHint(r.status) })
        continue
      }
      const data = await r.json().catch(() => null)
      results.push({
        id: c.id, label: c.label, url: c.url, ok: r.ok, ms,
        version: data?.result?.version ?? data?.version ?? '',
        error: r.ok ? null : `HTTP ${r.status}`,
      })
    } catch (e) {
      results.push({ id: c.id, label: c.label, url: c.url, ok: false, ms: Date.now() - t0, error: shortErr(e) })
    }
  }
  return json(res, 200, { ok: true, results })
}

/** 客户端浮窗用的同源路由。 */
export const TREE_ROUTE = '/dsh-device-center/tree'

/**
 * 客户端浮窗不直接打控制面，而是走这条同源路由，原因有两个：
 *  1. 浏览器从 DSH 页面直连 http://192.168.0.135:8700 是跨源请求，要么给控制面
 *     加 CORS（扩大攻击面），要么在这里转发；
 *  2. 令牌留在服务端，永远不会出现在浏览器里。
 *
 * 一次取全客户端需要的东西（树 + 凭据状态 + Runner 在线情况），
 * 让浮窗打开时只发一个请求。
 */
function registerTreeRoute(ctx) {
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: TREE_ROUTE,
      handler: handleTree,
    }), 'dsh-device-center: device tree route')
  })
}

async function handleTree(req, res) {
  const send = (code, body) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    // 设备树变化很慢，但凭据/在线状态会变 —— 让浏览器每次校验，别缓存
    res.setHeader('cache-control', 'no-cache, must-revalidate')
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'GET') return send(405, { ok: false, error: 'method not allowed' })

  // 注意：handleTree 是模块级函数，拿不到 apply 的闭包，所以设置从一个
  // 模块级的活动 scope 读 —— 由 apply 在挂载时写入。
  const s = activeSettings()
  if (!s.token) return send(500, { ok: false, error: 'device-center 未配置 token' })

  // 三条路一起取，任意一条通了就行；fetchAny 内部会按 mode 的顺序逐条试。
  const get = (path) => fetchAny(s, path).then(r => r.json()).catch(() => null)

  try {
    const first = await fetchAny(s, '/api/topology')
    const base = { endpoint: first.endpoint, attempts: first.attempts }
    const [tree, links, status] = await Promise.all([
      first.res.json(),
      get('/api/links'),
      get('/api/status'),
    ])
    const nodes = tree?.result ?? tree ?? []
    let count = 0
    const walk = (list) => {
      for (const n of list || []) { count++; if (n.children) walk(n.children) }
    }
    walk(nodes)

    return send(200, {
      ok: true,
      result: {
        tree: nodes,
        credentials: links?.result?.credentials ?? {},
        runners: links?.result?.runners ?? {},
        count,
        version: status?.result?.version ?? '',
        // 浮窗要显示"现在走的是哪条路"，以及每条路的可用性
        endpoint: { id: base.endpoint.id, label: base.endpoint.label, url: base.endpoint.url },
        mode: s.mode,
        endpoints: endpointStatus(s, base.endpoint.id, base.attempts),
      },
    })
  } catch (e) {
    // 全都不通：把每条路的失败原因回给浮窗，让它提示"切到哪条能通"
    return send(502, {
      ok: false,
      error: '所有接入点都无法访问',
      mode: s.mode,
      endpoints: endpointStatus(s, null, e.attempts),
      attempts: e.attempts || [],
    })
  }
}

/** 切换接入模式的路由（浮窗里点一下就切，不用去翻设置页）。 */
export const MODE_ROUTE = '/dsh-device-center/mode'

function registerModeRoute(ctx) {
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: MODE_ROUTE,
      handler: handleMode,
    }), 'dsh-device-center: endpoint mode route')
  })
}

async function handleMode(req, res) {
  const send = (code, body) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' })

  let mode = ''
  try {
    const chunks = []
    for await (const c of req) chunks.push(c)
    mode = String(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').mode || '')
  } catch {
    return send(400, { ok: false, error: '请求体不是合法 JSON' })
  }

  const allowed = ['auto', 'lan', 'tailscale', 'cloudflare']
  if (!allowed.includes(mode)) {
    return send(400, { ok: false, error: `mode 必须是 ${allowed.join(' / ')} 之一` })
  }
  // 0.1.7: 宿主插件无法再写自身配置（见 WRITE_UNAVAILABLE）。浮层里的"切换接入点"
  // 因此只提示去 profile 配置表单改。
  return send(501, { ok: false, error: WRITE_UNAVAILABLE })
}

/**
 * 权限上限的读写路由。
 *
 * 语义：切换 Agent 通道能做什么。'read' = 只读查询，'root' = 完全权限。
 *
 * 走 consoleToken 登录取会话 cookie —— 因为控制面刻意只允许"人"改这个值
 * （Agent 用 bearer 调会被 403）。这不是绕路，而是在正确地扮演人的角色：
 * 点按钮的是你，不是 Agent。
 */
export const PERM_ROUTE = '/dsh-device-center/perm'

function registerPermRoute(ctx) {
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: PERM_ROUTE,
      handler: handlePerm,
    }), 'dsh-device-center: agent permission route')
  })
}

async function handlePerm(req, res) {
  const send = (code, body) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const s = activeSettings()
  if (!s.consoleToken) {
    return send(400, {
      ok: false,
      error: '未配置控制台令牌，无法修改权限。请在设置页填入「控制台登录令牌」。',
      needConsoleToken: true,
    })
  }

  // 1) 用控制台令牌换会话 cookie（扮演"人"）
  //
  // asHuman 是关键：不带 Authorization 头。控制面的 authKind() **先看 bearer**
  // —— 只要请求带了有效 bearer，它就认定这是 Agent，随后 /api/perm 直接 403。
  // 会话 cookie 再正确也没用。踩过一次：表现为"令牌明明配了却说我不是人"。
  let cookie
  try {
    const picked = await fetchAnyAccepting4xx(s, '/api/login', {
      asHuman: true,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: s.consoleToken }),
    })
    if (picked.res.status !== 200) {
      return send(picked.res.status, { ok: false, error: '控制台令牌无效，无法修改权限' })
    }
    const raw = picked.res.headers.getSetCookie?.() ?? []
    const one = raw.find(c => c.startsWith('infra_session='))
      || (picked.res.headers.get('set-cookie') || '').split(';')[0]
    cookie = String(one || '').split(';')[0]
    if (!cookie) return send(502, { ok: false, error: '控制面没有下发会话 cookie' })
  } catch (e) {
    return send(502, { ok: false, error: `登录控制面失败：${e?.message ?? e}` })
  }

  const auth = { Cookie: cookie, 'Content-Type': 'application/json' }

  // 2) GET = 读当前；POST = 改
  if (req.method === 'GET') {
    try {
      const picked = await fetchAnyAccepting4xx(s, '/api/perm', { asHuman: true, headers: auth })
      const data = await picked.res.json().catch(() => ({}))
      return send(picked.res.status, data)
    } catch (e) {
      return send(502, { ok: false, error: `读取权限失败：${e?.message ?? e}` })
    }
  }

  if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' })

  let level = ''
  try {
    const chunks = []
    for await (const c of req) chunks.push(c)
    level = String(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').level || '')
  } catch {
    return send(400, { ok: false, error: '请求体不是合法 JSON' })
  }

  // 'root' / 'read' 是给用户看的词，控制面认的是 ADMIN / READ
  const map = { read: 'READ', root: 'ADMIN', READ: 'READ', ADMIN: 'ADMIN' }
  const wire = map[level] || map[String(level).toUpperCase()]
  if (!wire) return send(400, { ok: false, error: "level 只能是 'read' 或 'root'" })

  try {
    const picked = await fetchAnyAccepting4xx(s, '/api/perm', {
      asHuman: true,
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ level: wire }),
    })
    const data = await picked.res.json().catch(() => ({}))
    if (picked.res.ok && data?.ok) {
      // 0.1.7: 插件不能再写自身配置，所以控制面（权威）改了之后，本插件里的默认值
      // 保持 profile 配置里的值不变；重启后以 profile 配置为准。
      lastGood = { id: null, at: 0 }
    }
    return send(picked.res.status, data)
  } catch (e) {
    return send(502, { ok: false, error: `设置权限失败：${e?.message ?? e}` })
  }
}

