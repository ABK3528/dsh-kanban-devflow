#!/usr/bin/env node
// 一条命令装好：把套件自带的看板插件 dsh-kanban-devflow（plugin/ 目录，fork 自 @alpacachen/dsh-kanban 1.13.1）装进 DSH profile，
// 替换原版插件（必要时授权当前 DSH 版本），并登记同步桥 kanban-bridge.mjs 的位置，插件启动时会加载它。
// 之后每个 git 项目在 DSH 里打开时，同步桥会自动接入（流程手册、角色、「研发交付」流程、看板甬道和标签）。
// 可重复执行；git pull 更新套件后再跑一次。
//   node install.mjs            安装/更新；装着原版插件时换成 dsh-kanban-devflow
//   node install.mjs --check    只检查安装状态，不改任何文件
//   node install.mjs --remove   换回原版 @alpacachen/dsh-kanban 1.13.1（看板数据不受影响）
//   node install.mjs --force    插件内容没变也重新安装
// 改完需重启 DSH 桌面版。
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const KIT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN_SRC = join(KIT, 'plugin')
const BRIDGE = join(KIT, 'bridge', 'kanban-bridge.mjs')
const BUILT = ['index.js', 'workflow/index.js', 'lib/client.js'] // 构建产物随仓库提交，安装不需要构建工具
const NAME = 'dsh-kanban-devflow'
const UPSTREAM = '@alpacachen/dsh-kanban'
const UPSTREAM_VERSION = '1.13.1' // --remove 换回的原版版本（fork 的基线）
const UPSTREAM_DECLARED = ['0.2.2-rc.5'] // 原版 1.13.1 package.json 里的 dsh.compatibility.dshReleases
const MIN_DSH = '0.2.2-rc.5' // 1.13 起插件用到 rc.5 的接口
const BRIDGE_CONFIG = 'dsh-devflow-bridge.json' // 插件从 profile 目录读这个文件找同步桥（plugin/workflow/devflow-bridge.ts）
const OLD_MARK = '/* dsh-kanban-flow-kit bridge */' // 旧版 install.mjs 打补丁时留下的标记

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = resolve(process.env.DSH_PROFILE_DIR || join(dshHome, 'profiles', 'desktop'))
const profileName = process.env.DSH_PROFILE || basename(profile)
// dsh 命令按 DSH_HOME 找 profile：只给了 profile 目录时，从 <home>/profiles/<name> 推出 home
const dshEnv = { ...process.env }
if (process.env.DSH_PROFILE_DIR && basename(dirname(profile)) === 'profiles') dshEnv.DSH_HOME = dirname(dirname(profile))
// 只有真实的 ~/.dsh 下的 profile 会被正在运行的桌面版占用；隔离的 DSH_HOME（测试实例）不检查
const liveProfile = profile.startsWith(join(homedir(), '.dsh') + sep)

const args = new Set(process.argv.slice(2))
const remove = args.has('--remove')
const check = args.has('--check')
const force = args.has('--force')
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: dshEnv, ...opts })
// 比较 0.2.2-rc.5 这类版本号：预发布版小于正式版
const cmpVer = (x, y) => {
  const parse = v => { const [main, pre] = v.split('-'); return [...main.split('.').map(Number), pre ? Number(pre.replace(/\D+/g, '')) : Infinity] }
  const a = parse(x), b = parse(y)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

if (args.has('--help') || args.has('-h')) {
  console.log(`用法：node install.mjs [--check | --remove | --force]
  （无参数）  安装/更新看板插件 ${NAME}（套件 plugin/ 目录），装着原版 ${UPSTREAM} 时换下它；DSH 版本不在插件声明里就授权
  --check     只检查安装状态，不改文件
  --remove    换回原版 ${UPSTREAM}@${UPSTREAM_VERSION}，删掉同步桥登记（看板数据不受影响）
  --force     插件内容没变也重新安装
环境变量：DSH_HOME 指定 DSH 数据目录（默认 ~/.dsh）；DSH_PROFILE_DIR 直接指定 profile 目录（默认 <DSH_HOME>/profiles/desktop）；
          DSH_PROFILE 指定 dsh 命令用的 profile 名（默认取目录名）`)
  process.exit(0)
}

const fail = (message) => { console.error(message); process.exit(1) }
const profilePkg = () => readJson(join(profile, 'package.json'), {})
const deps = () => profilePkg().dependencies ?? {}
const installedVersion = (name) => readJson(join(profile, 'node_modules', ...name.split('/'), 'package.json'), null)?.version ?? null
const allowedFor = (key) => readJson(join(profile, 'compatibility.json'), {})[key] ?? []
const bridgeConfigOk = () => readJson(join(profile, BRIDGE_CONFIG), {}).bridge === BRIDGE

function dshVersionOrFail() {
  const v = sh('dsh', ['--version']).stdout?.trim() || ''
  if (!v) fail('找不到 dsh 命令。请先安装 DeepSeek Harness 桌面版，并确认终端里能运行 dsh。')
  if (cmpVer(v, MIN_DSH) < 0) fail(`DSH ${v} 太旧：看板插件需要 DSH ${MIN_DSH} 或更新版本。先升级 DeepSeek Harness 桌面版。`)
  return v
}

// 把 plugin/ 打成 tgz。npm pack 的产物是确定的（固定 mtime），文件名带内容哈希：内容一变路径就变，pnpm 才会重装。
function packPlugin() {
  const meta = readJson(join(PLUGIN_SRC, 'package.json'), null)
  if (!meta || meta.name !== NAME) fail(`没有找到 ${PLUGIN_SRC}/package.json（${NAME}）。套件不完整，重新 git clone 一份。`)
  const missing = BUILT.filter(f => !existsSync(join(PLUGIN_SRC, f)))
  if (missing.length) fail(`插件缺少构建产物：${missing.join('、')}。在 plugin/ 里运行 pnpm install && node build.mjs 后重试。`)
  const tmp = mkdtempSync(join(tmpdir(), 'devflow-pack-'))
  const r = sh('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp], { cwd: PLUGIN_SRC })
  if (r.error || r.status !== 0) { rmSync(tmp, { recursive: true, force: true }); fail(`npm pack 失败：${r.error?.message ?? r.stderr.trim()}\n需要能在终端里运行 npm（随 Node.js 安装）。`) }
  const file = join(tmp, JSON.parse(r.stdout)[0].filename)
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8)
  return { tmp, file, version: meta.version, declared: Object.keys(meta.dsh?.compatibility?.dshReleases ?? {}), target: join(profile, 'devflow', `${NAME}-${meta.version}-${sha}.tgz`) }
}

function status(pack) {
  const spec = deps()[NAME]
  return {
    spec,
    current: spec === `file:${pack.target}` && existsSync(pack.target) && installedVersion(NAME) === pack.version,
    upstream: Boolean(deps()[UPSTREAM]) || Boolean(installedVersion(UPSTREAM)),
    bridge: bridgeConfigOk(),
  }
}

// 装插件、换插件、授权都要改 profile 的 package.json 和依赖，DSH 运行时不动它：让用户先退出
function requireQuit(what) {
  if (!liveProfile || process.env.DSH_INSTALL_FORCE) return
  if (sh('pgrep', ['-f', 'DeepSeek Harness.app/Contents/MacOS']).stdout?.trim()) fail(`需要${what}，请先完全退出 DeepSeek Harness 桌面版，再重新运行本命令。`)
}

function backupProfile() {
  const bak = join(profile, 'workflow-poc', `install-backup-${Date.now()}`)
  mkdirSync(bak, { recursive: true })
  for (const f of ['package.json', 'pnpm-lock.yaml', 'compatibility.json']) if (existsSync(join(profile, f))) copyFileSync(join(profile, f), join(bak, f))
  return bak
}

const dsh = a => {
  console.log(`> dsh plugin --profile ${profileName} ${a.join(' ')}`)
  const r = spawnSync('dsh', ['plugin', '--profile', profileName, ...a], { stdio: 'inherit', env: dshEnv })
  if (r.status !== 0) fail(`dsh plugin ${a.join(' ')} 失败（退出码 ${r.status}）。profile 文件的备份见上面的提示。`)
}
// dsh plugin add 会直接拒绝没声明当前 DSH 版本的插件，所以授权要在安装之前
function allowIfNeeded(pkgAtVer, declared, dshVersion) {
  if ([...declared, ...allowedFor(pkgAtVer)].includes(dshVersion)) return
  console.log(`${pkgAtVer} 没有声明兼容 DSH ${dshVersion}，授权这一对精确版本（DSH 提示可能崩溃或数据损坏）…`)
  dsh(['allow-version', pkgAtVer, '--dsh-version', dshVersion, '--accept-risk'])
}

if (!existsSync(join(profile, 'package.json'))) fail(`没有找到 DSH profile：${profile}。先打开一次 DeepSeek Harness 桌面版，或用 DSH_HOME / DSH_PROFILE_DIR 指定。`)

if (check) {
  const pack = packPlugin()
  rmSync(pack.tmp, { recursive: true, force: true })
  const s = status(pack)
  const lines = [
    s.current ? `插件     ${NAME} ${pack.version}，和套件 plugin/ 一致` : s.spec ? `插件     ${NAME} 已安装（${installedVersion(NAME) ?? '依赖未装好'}），但和套件 plugin/ 不一致，需要重跑 install.mjs` : `插件     没有安装 ${NAME}`,
    s.upstream ? `原版     ${UPSTREAM} ${installedVersion(UPSTREAM) ?? ''} 还在 profile 里${s.spec ? '，和 fork 同时装会冲突' : ''}` : `原版     ${UPSTREAM} 未安装`,
    s.bridge ? `同步桥   已登记 ${BRIDGE_CONFIG}` : `同步桥   没有登记（${BRIDGE_CONFIG}）`,
  ]
  console.log(`profile ${profile}\n` + lines.join('\n'))
  process.exit(s.current && !s.upstream && s.bridge ? 0 : 1)
}

if (remove) {
  const hasFork = Boolean(deps()[NAME])
  if (!hasFork && !existsSync(join(profile, BRIDGE_CONFIG))) { console.log(`没有安装 ${NAME}，不需要还原。`); process.exit(0) }
  if (hasFork) {
    requireQuit(`把 ${NAME} 换回 ${UPSTREAM}@${UPSTREAM_VERSION}`)
    const dshVersion = dshVersionOrFail()
    const bak = backupProfile()
    console.log(`换回 ${UPSTREAM}@${UPSTREAM_VERSION}（已备份 package.json、pnpm-lock.yaml、compatibility.json 到 ${bak}）…`)
    // 先装原版再卸 fork：中途失败时 profile 里至少还有一个看板插件
    if (installedVersion(UPSTREAM) !== UPSTREAM_VERSION) {
      allowIfNeeded(`${UPSTREAM}@${UPSTREAM_VERSION}`, UPSTREAM_DECLARED, dshVersion)
      dsh(['add', `${UPSTREAM}@${UPSTREAM_VERSION}`])
    }
    dsh(['remove', NAME])
  }
  rmSync(join(profile, BRIDGE_CONFIG), { force: true })
  rmSync(join(profile, 'devflow'), { recursive: true, force: true })
  const upstreamIndex = join(profile, 'node_modules', ...UPSTREAM.split('/'), 'index.js')
  if (existsSync(upstreamIndex) && readFileSync(upstreamIndex, 'utf8').includes(OLD_MARK)) {
    console.warn(`注意：原版插件文件里还留着旧版套件的补丁。重装一次可以清掉：dsh plugin --profile ${profileName} remove ${UPSTREAM}，再 add ${UPSTREAM}@${UPSTREAM_VERSION}`)
  }
  console.log(`已换回 ${UPSTREAM}@${UPSTREAM_VERSION}，同步桥不再加载。重启 DSH 桌面版后生效；各项目的 .dsh-kanban.json 不受影响（原版只显示每张卡的第一个标签）。`)
  process.exit(0)
}

// ---- 安装 / 更新 ----
const dshVersion = dshVersionOrFail()
const pack = packPlugin()
try {
  const s = status(pack)
  const needAllow = ![...pack.declared, ...allowedFor(`${NAME}@${pack.version}`)].includes(dshVersion)
  if (s.current && !s.upstream && !needAllow && !force) {
    if (!s.bridge) { writeFileSync(join(profile, BRIDGE_CONFIG), JSON.stringify({ bridge: BRIDGE }, null, 2) + '\n'); console.log(`已登记同步桥（${BRIDGE_CONFIG}）。重启 DSH 桌面版后生效。`) }
    else console.log(`${NAME} ${pack.version} 已是最新，不需要改动。`)
    process.exit(0)
  }
  const what = s.upstream ? `把 ${UPSTREAM} 换成 ${NAME} ${pack.version}` : s.spec ? `更新 ${NAME} 到套件当前版本` : `安装 ${NAME} ${pack.version}`
  requireQuit(what)
  const bak = backupProfile()
  console.log(`${what}（已备份 package.json、pnpm-lock.yaml、compatibility.json 到 ${bak}）…`)
  // tgz 要放在固定位置：profile 的 package.json 里记的是它的绝对路径
  mkdirSync(dirname(pack.target), { recursive: true })
  if (!existsSync(pack.target)) copyFileSync(pack.file, pack.target)
  allowIfNeeded(`${NAME}@${pack.version}`, pack.declared, dshVersion)
  dsh(['add', pack.target])
  // 原版和 fork 的 Cordis 插件 id 相同，只能留一个
  if (s.upstream) dsh(['remove', UPSTREAM])
  for (const f of readdirSync(dirname(pack.target))) if (join(dirname(pack.target), f) !== pack.target) rmSync(join(dirname(pack.target), f), { force: true })
  writeFileSync(join(profile, BRIDGE_CONFIG), JSON.stringify({ bridge: BRIDGE }, null, 2) + '\n')
} finally {
  rmSync(pack.tmp, { recursive: true, force: true })
}
console.log(`已安装 ${NAME} ${pack.version}（插件包 ${pack.target}）。\n`
  + '完全退出并重新打开 DSH 桌面版后生效；之后在 DSH 里打开的 git 项目会自动接入（甬道、标签、流程、文档），不需要再发提示词。\n'
  + '不想接入某个项目：在它根目录建空文件 .dsh-devflow-off。换回原版插件：node install.mjs --remove。')
