const fs = require('fs')
const path = require('path')
/* ===========================
   MINECRAFT-DATA PIN (รองรับเวอร์ชัน 26.x จาก fork)
   ปัญหา: มีหลายแพ็กเกจ (prismarine-registry, pathfinder ฯลฯ) ดึง minecraft-data
   ตัวทางการ (ไม่มีข้อมูล 26.2) ทำให้ขึ้น "Do not have data for 26.2"
   ทางแก้: บังคับให้ทุก require('minecraft-data') ชี้ไปที่ตัวเดียวกับที่
   minecraft-protocol (fork) ใช้ — จะทำงานเฉพาะเมื่อตัวนั้นเป็น fork (+complexity)
   ถ้าใช้ไลบรารีทางการจะไม่ทำอะไรเลย
=========================== */
;(function pinMinecraftData() {
  try {
    const Module = require('module')
    const protoPath = require.resolve('minecraft-protocol')
    const dataEntry = require.resolve('minecraft-data', { paths: [path.dirname(protoPath)] })
    // หา package.json ของ minecraft-data ที่ตรงกับไฟล์ entry
    let dir = path.dirname(dataEntry)
    let pkg = null
    for (let i = 0; i < 4; i++) {
      const f = path.join(dir, 'package.json')
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (j.name === 'minecraft-data') { pkg = j; break }
      }
      dir = path.dirname(dir)
    }
    if (!pkg || !String(pkg.version).includes('complexity')) return
    const origResolve = Module._resolveFilename
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'minecraft-data') return dataEntry
      return origResolve.call(this, request, ...rest)
    }
    console.log(`[DATA] minecraft-data pinned -> ${pkg.version}`)
  } catch (e) {
    console.error('[DATA] pin skipped:', e.message)
  }
})()

const mineflayer = require('mineflayer')
const express = require('express')

// อาการ event loop ค้างล่าสุด (PERF monitor ด้านล่างเป็นคนอัปเดต) — ไว้ใส่ใน log เวลาโดน disconnect.timeout
var perfLast = { at: 0, ms: 0 }

/* ===========================
   CRASH SAFETY NET
   A bug deep inside a dependency (e.g. mineflayer-pathfinder's internal
   tool-selection logic) must never be allowed to kill the whole process —
   that would disconnect every managed bot at once. Log it and keep going.
=========================== */
process.on('uncaughtException', (err) => {
  console.error('[SAFETY-NET] Uncaught exception (server kept running):', err && err.stack ? err.stack : err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[SAFETY-NET] Unhandled rejection (server kept running):', reason)
})

const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json({ verify: (req, res, buf) => { if (req.url === '/discord/interactions') req.rawBody = buf } }))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), bots: bots.size })
})

app.get('/styles.css', (req, res) => {
  const cssPath = path.join(__dirname, 'styles.css')
  if (fs.existsSync(cssPath)) {
    res.setHeader('Cache-Control', 'no-cache') // ให้เบราว์เซอร์เช็คไฟล์ใหม่ทุกครั้ง (CSS ทั้งหมดอยู่ในไฟล์นี้)
    res.sendFile(cssPath)
  } else {
    res.status(404).send('styles.css not found')
  }
})

/* ===========================
   CONFIG & PERSISTENCE
=========================== */

const BOTS_CONFIG_FILE = path.join(__dirname, 'bots_config.json')
const SERVER_CONFIG_FILE = path.join(__dirname, 'server_config.json')
// โฟลเดอร์เก็บโทเคนล็อกอิน Microsoft (ล็อกอินครั้งเดียวแล้วจำไว้ ไม่ต้องขอโค้ดใหม่ทุกครั้งที่ reconnect/restart)
// ถ้าโฮสต์ลบไฟล์ทุกครั้งที่ restart (เช่นฟรีโฮสต์) ให้ตั้ง env AUTH_CACHE_DIR ไปที่ดิสก์ถาวร · ห้าม commit โฟลเดอร์นี้ขึ้น git
const AUTH_CACHE_DIR = (() => {
  try {
    const d = process.env.AUTH_CACHE_DIR || path.join(__dirname, 'auth_cache')
    fs.mkdirSync(d, { recursive: true })
    return d
  } catch (e) {
    console.error('[AUTH] สร้างโฟลเดอร์แคชล็อกอินไม่ได้:', e.message)
    return null
  }
})()

let serverConfig = {
  host: 'play.amorycraft.com',
  port: 25565,
  defaultUsername: 'FGOP',
  version: '', // ว่าง = ตรวจเวอร์ชันอัตโนมัติ, หรือใส่เช่น '26.2' / '1.21.8'
  keepaliveUrl: '', // ลิงก์ที่ให้ยิงเองทุก 5 นาที (ว่าง = ใช้ค่าเริ่มต้น PUBLIC_URL/health)
  discordWebhookUrl: '' // Discord webhook ตัวรวม (ทุกบอทใช้ร่วมกัน · บอทแต่ละตัวตั้งของตัวเองทับได้ใน Settings)
}

// โหลด server config แยก
function loadServerConfig() {
  if (fs.existsSync(SERVER_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(SERVER_CONFIG_FILE, 'utf8')
      if (raw.trim()) {
        const data = JSON.parse(raw)
        if (data.host) serverConfig.host = data.host
        if (data.port) serverConfig.port = Number(data.port) || 25565
        if (data.defaultUsername) serverConfig.defaultUsername = data.defaultUsername
        if (data.version !== undefined && data.version !== null) serverConfig.version = String(data.version).trim()
        if (typeof data.keepaliveUrl === 'string') serverConfig.keepaliveUrl = data.keepaliveUrl.trim()
        if (typeof data.discordWebhookUrl === 'string') serverConfig.discordWebhookUrl = whNormalize(data.discordWebhookUrl)
      }
    } catch (e) {
      console.error('[ERROR] Failed to load server config:', e.message)
    }
  }
}

function saveServerConfig() {
  try {
    fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify(serverConfig, null, 2))
    ghSchedulePush()
  } catch (e) {
    console.error('[ERROR] Failed to save server config:', e.message)
  }
}

/* ===========================
   GITHUB SYNC — สำรอง/กู้ bots_config.json + server_config.json ผ่าน GitHub
   Render ล้างดิสก์ทุกครั้งที่รีสตาร์ต → เซฟลง GitHub (branch แยก) แล้วดึงกลับมาตอนเปิด
   ตั้ง env บน Render:  GITHUB_TOKEN (fine-grained PAT สิทธิ์ Contents: Read and write),
                       GITHUB_REPO (รูปแบบ owner/repo), GITHUB_DATA_BRANCH (ไม่ใส่ = bot-data)
   ถ้าไม่ได้ตั้ง GITHUB_TOKEN + GITHUB_REPO ระบบนี้ปิดอยู่ และทำงานเหมือนเดิม (ไฟล์ในเครื่องอย่างเดียว)
   push ไป branch ข้อมูลเท่านั้น → Render ที่ดู branch หลักจะไม่ดีพลอยซ้ำเอง
=========================== */
const GH_TOKEN = process.env.GITHUB_TOKEN || ''
const GH_REPO = (process.env.GITHUB_REPO || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^\/|\/$/g, '')
const GH_BRANCH = process.env.GITHUB_DATA_BRANCH || 'bot-data'
const GH_ENABLED = !!(GH_TOKEN && GH_REPO)
const GH_PUSH_DELAY_MS = 4000
const ghSha = {}      // sha ของไฟล์บน GitHub (ต้องใช้ตอนอัปเดต)
const ghLastPushed = {} // เนื้อหาที่ push ล่าสุด (ไม่เปลี่ยน = ไม่ push)
let ghTimer = null
let ghBusy = null

function ghFiles() { return [BOTS_CONFIG_FILE, SERVER_CONFIG_FILE] }

async function ghReq(method, apiPath, body) {
  const res = await fetch('https://api.github.com/repos/' + GH_REPO + apiPath, {
    method,
    headers: {
      Authorization: 'Bearer ' + GH_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'galaxy-afk-hub',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000)
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

async function ghEnsureBranch() {
  const ref = await ghReq('GET', '/git/ref/heads/' + encodeURIComponent(GH_BRANCH))
  if (ref.status === 200) return true
  if (ref.status !== 404) throw new Error('เช็ค branch ไม่ได้ (HTTP ' + ref.status + ') — เช็ค GITHUB_TOKEN / GITHUB_REPO')
  const repo = await ghReq('GET', '')
  if (repo.status !== 200) throw new Error('เข้า repo ไม่ได้ (HTTP ' + repo.status + ') — เช็คชื่อ repo และสิทธิ์ของ token')
  const base = await ghReq('GET', '/git/ref/heads/' + encodeURIComponent(repo.json.default_branch))
  if (base.status !== 200) throw new Error('หา branch หลักไม่เจอ (HTTP ' + base.status + ')')
  const mk = await ghReq('POST', '/git/refs', { ref: 'refs/heads/' + GH_BRANCH, sha: base.json.object.sha })
  if (mk.status !== 201) throw new Error('สร้าง branch ' + GH_BRANCH + ' ไม่สำเร็จ (HTTP ' + mk.status + ')')
  console.log('[GITHUB] สร้าง branch "' + GH_BRANCH + '" แล้ว (แยกจาก branch หลัก)')
  return true
}

// ตอนเปิดเซิร์ฟเวอร์: ดึงไฟล์จาก GitHub มาทับไฟล์ในเครื่อง (ถ้ามีบน GitHub)
async function ghPull() {
  if (!GH_ENABLED) return
  await ghEnsureBranch()
  for (const file of ghFiles()) {
    const name = path.basename(file)
    const r = await ghReq('GET', '/contents/' + encodeURIComponent(name) + '?ref=' + encodeURIComponent(GH_BRANCH))
    if (r.status === 200 && r.json && typeof r.json.content === 'string') {
      const text = Buffer.from(r.json.content, 'base64').toString('utf8')
      ghSha[name] = r.json.sha
      if (text.trim()) {
        fs.writeFileSync(file, text)
        ghLastPushed[name] = text
        console.log('[GITHUB] ดึง ' + name + ' จาก GitHub แล้ว')
      }
    } else if (r.status === 404) {
      console.log('[GITHUB] ยังไม่มี ' + name + ' บน branch ' + GH_BRANCH + ' — ใช้ไฟล์ในเครื่อง/ค่าเริ่มต้น แล้วจะอัปโหลดตอนมีการบันทึก')
    } else {
      console.error('[GITHUB] ดึง ' + name + ' ไม่สำเร็จ (HTTP ' + r.status + ')')
    }
  }
}

async function ghPushOne(file) {
  const name = path.basename(file)
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  if (!text.trim() || text === ghLastPushed[name]) return
  const send = () => ghReq('PUT', '/contents/' + encodeURIComponent(name), {
    message: 'auto: update ' + name,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: GH_BRANCH,
    ...(ghSha[name] ? { sha: ghSha[name] } : {})
  })
  let r = await send()
  if (r.status === 409 || r.status === 422) { // sha ไม่ตรง (ไฟล์บน GitHub ถูกแก้จากที่อื่น) → ขอ sha ล่าสุดแล้วลองอีกครั้ง
    const cur = await ghReq('GET', '/contents/' + encodeURIComponent(name) + '?ref=' + encodeURIComponent(GH_BRANCH))
    if (cur.status === 200 && cur.json) { ghSha[name] = cur.json.sha; r = await send() }
  }
  if (r.status === 200 || r.status === 201) {
    ghSha[name] = r.json && r.json.content ? r.json.content.sha : ghSha[name]
    ghLastPushed[name] = text
    console.log('[GITHUB] อัปโหลด ' + name + ' แล้ว')
  } else {
    console.error('[GITHUB] อัปโหลด ' + name + ' ไม่สำเร็จ (HTTP ' + r.status + ')' + (r.json && r.json.message ? ': ' + r.json.message : ''))
  }
}

async function ghPushAll() {
  if (!GH_ENABLED) return
  if (ghBusy) return ghBusy
  ghBusy = (async () => {
    try {
      await ghEnsureBranch()
      for (const f of ghFiles()) await ghPushOne(f)
    } catch (e) {
      console.error('[GITHUB] error:', e.message)
    } finally { ghBusy = null }
  })()
  return ghBusy
}

// เรียกหลังเซฟไฟล์ในเครื่อง — รอ 15 วิรวบการแก้หลายครั้งเป็น commit เดียว
function ghSchedulePush() {
  if (!GH_ENABLED) return
  if (ghTimer) clearTimeout(ghTimer)
  ghTimer = setTimeout(() => { ghTimer = null; ghPushAll() }, GH_PUSH_DELAY_MS)
}

// ตอนปิดเซิร์ฟเวอร์: ส่งทันทีไม่รอ 15 วิ (รอไม่เกิน maxMs)
async function ghFlush(maxMs) {
  if (!GH_ENABLED) return
  if (ghTimer) { clearTimeout(ghTimer); ghTimer = null }
  await Promise.race([ghPushAll(), new Promise(r => setTimeout(r, maxMs || 6000))])
}

let nextBotId = 1
const bots = new Map()

let saveTimeout = null
function scheduleSaveBots() {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    saveBots()
    saveTimeout = null
  }, 1000)
}

function saveBots() {
  try {
    const data = Array.from(bots.values()).map(b => ({
      username: b.state.originalUsername,
      accountType: b.state.accountType,
      theme: b.state.theme || 'galaxy',
      autoLogin: b.state.autoLogin,
      loginPassword: b.state.loginPassword,
      autoPin: b.state.autoPin,
      loginPin: b.state.loginPin,
      autoCommands: b.state.autoCommands,
      autoServerSelect: b.state.autoServerSelect,
      serverSelectItem: b.state.serverSelectItem,
      autoEat: b.state.autoEat,
      autoWalk: b.state.autoWalk,
      autoClick: b.state.autoClick,
      autoAttack: b.state.autoAttack,
      attackDelay: b.state.attackDelay,
      pinDelay: b.state.pinDelay,
      autoTpa: b.state.autoTpa,
      webhookOn: b.state.webhookOn,
      webhookUrl: b.state.webhookUrl,
      webhookMsgId: b.state.webhookMsgId,
      webhookMsgUrl: b.state.webhookMsgUrl
    }))
    const tmpFile = BOTS_CONFIG_FILE + '.tmp'
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2))
    fs.renameSync(tmpFile, BOTS_CONFIG_FILE)
    ghSchedulePush()
  } catch (err) {
    console.error('[ERROR] Failed to save bots config:', err.message)
  }
}

function loadBots() {
  if (fs.existsSync(BOTS_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(BOTS_CONFIG_FILE, 'utf8')
      if (!raw.trim()) {
        console.log('[SYSTEM] Config file is empty, starting fresh')
        createManagedBot({ username: serverConfig.defaultUsername, accountType: 'offline' })
        return
      }
      const data = JSON.parse(raw)
      if (!Array.isArray(data) || data.length === 0) {
        console.log('[SYSTEM] No bots in config, creating default')
        createManagedBot({ username: serverConfig.defaultUsername, accountType: 'offline' })
        return
      }
      data.forEach(botCfg => createManagedBot(botCfg))
      console.log(`[SYSTEM] Restored ${data.length} bots from config.`)
    } catch (e) {
      console.error('[ERROR] Failed to load bots config:', e.message)
      try {
        const backupFile = BOTS_CONFIG_FILE + '.backup.' + Date.now()
        fs.copyFileSync(BOTS_CONFIG_FILE, backupFile)
        console.log(`[SYSTEM] Corrupted config backed up to ${backupFile}`)
      } catch {}
      createManagedBot({ username: serverConfig.defaultUsername, accountType: 'offline' })
    }
  } else {
    createManagedBot({ username: serverConfig.defaultUsername, accountType: 'offline' })
  }
}

/* ===========================
   AUTO-EAT DATA
=========================== */

const FOOD_PRIORITY = [
  'golden_apple', 'enchanted_golden_apple',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'baked_potato', 'bread', 'apple', 'carrot', 'potato', 'melon_slice', 'sweet_berries', 'glow_berries',
  'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon',
  'pumpkin_pie', 'cookie', 'dried_kelp', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'beetroot'
]
const FOOD_AVOID = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
// ดีเลย์ตีคลิกซ้าย (ms): 50 - 60000, ค่าเริ่มต้น 500
// ดีเลย์ก่อนกด PIN หลังแป้นขึ้น (ms): 0 - 15000, ค่าเริ่มต้น 1500
function clampPinDelay(v) { if (v === undefined || v === null || v === '') return 1500; const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(15000, Math.round(n))) : 1500 }
function clockOf(ms) { try { return new Date(ms).toTimeString().slice(0, 8) } catch { return '-' } }
function clampAttackDelay(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(50, Math.min(60000, Math.round(n))) : 500 }

/* ===========================
   HELPERS
=========================== */

const TIME_FMT_OPTS = { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }
function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/[&<>"']/g, c => HTML_ESC[c])
}

// รวมข้อความจาก chat component ทั้งต้น (text + extra ซ้อนกัน + translate/with) — ใช้กับ object เท่านั้น
function flattenChat(n, depth) {
  if (n === null || n === undefined || depth > 10) return ''
  if (typeof n === 'string') return n
  if (typeof n === 'number' || typeof n === 'boolean') return String(n)
  if (Array.isArray(n)) return n.map(x => flattenChat(x, depth + 1)).join('')
  if (typeof n !== 'object') return ''
  let out = ''
  if (typeof n.text === 'string' && (n.text || !n.translate)) out += n.text
  else if (n.translate) {
    const args = Array.isArray(n.with) ? n.with.map(w => flattenChat(w, depth + 1)).filter(Boolean).join(', ') : ''
    out += String(n.translate) + (args ? ': ' + args : '')
  }
  if (n.extra) out += flattenChat(n.extra, depth + 1)
  return out
}

function stringifyMsg(msg) {
  try {
    if (!msg || msg === null) return 'Unknown message'
    if (typeof msg === 'string') return msg
    if (typeof msg === 'number' || typeof msg === 'boolean') return String(msg)
    if (typeof msg === 'object') { const flat = flattenChat(msg, 0); if (flat) return flat }
    if (msg.text) return msg.text
    if (msg.translate) {
      const translateWith = Array.isArray(msg.with)
        ? msg.with.map(w => typeof w === 'string' ? w : (w && w.text) ? w.text : '').join(', ')
        : ''
      return msg.translate + (translateWith ? ': ' + translateWith : '')
    }
    if (Array.isArray(msg.extra)) {
      return msg.extra.map(x => typeof x === 'string' ? x : (x.text || '')).join('')
    }
    if (msg.toJSON && typeof msg.toJSON === 'function') {
      const json = msg.toJSON()
      if (json && json.text) return json.text
    }
    if (typeof msg.toString === 'function') {
      const str = msg.toString()
      return str !== '[object Object]' ? str : JSON.stringify(msg)
    }
    return JSON.stringify(msg)
  } catch {
    return 'Unknown message'
  }
}

function getUptime(state) {
  if (!state.connectedAt) return '-'
  const sec = Math.floor((Date.now() - state.connectedAt) / 1000)
  if (sec < 0) return '-'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

const TECH_LOG_RE = /^\[(TRACE|PERF|DROP|LITE|WEBHOOK)\]/

function stampNow() {
  const now = new Date()
  return `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}]`
}

function pushLog(state, msg) {
  if (!msg) return
  const line = `${stampNow()} ${msg}`
  // บรรทัดเทคนิค (TRACE/PERF/DROP/LITE) แยกไปอีกถัง — ไม่ปนกับ log ปกติและไม่ไปทับ "ข้อความล่าสุด" บนการ์ด
  if (TECH_LOG_RE.test(msg)) {
    if (!state.tech) state.tech = []
    state.tech.unshift(line)
    if (state.tech.length > 120) state.tech.length = 120
    return
  }
  state.lastMessage = msg
  state.logs.unshift(line)
  if (/^\[(NPC|BUILD)\]/.test(msg)) {
    if (!state.npcLines) state.npcLines = []
    state.npcLines.unshift(line)
    if (state.npcLines.length > 80) state.npcLines.length = 80
  }
  // ✅ ข้อ 9: ลดจำนวน log สูงสุดเหลือ 100 บรรทัด
  if (state.logs.length > 100) state.logs.length = 100
}

// ข้อความแชท/ข้อความจากเซิร์ฟเวอร์ในเกม — แยกจาก log ของระบบ
function pushChat(state, msg) {
  if (!msg) return
  state.lastMessage = msg
  if (!state.chat) state.chat = []
  state.chat.unshift(`${stampNow()} ${msg}`)
  if (state.chat.length > 150) state.chat.length = 150
}

/* ===========================
   BOT MANAGER CORE
=========================== */

function createManagedBot({ username, accountType, theme, autoLogin, loginPassword, autoPin, loginPin, autoCommands, autoServerSelect, serverSelectItem, autoEat, autoWalk, autoClick, autoAttack, attackDelay, pinDelay, autoTpa, webhookOn, webhookUrl, webhookMsgId, webhookMsgUrl }) {
  const state = {
    id: nextBotId++,
    username,
    originalUsername: username,
    accountType: accountType || 'offline',
    theme: theme || 'galaxy',
    status: 'starting',
    lastMessage: '-',
    connectedAt: null,
    logs: [],
    chat: [],
    tech: [],
    autoLogin: autoLogin === true || autoLogin === 'true',
    loginPassword: loginPassword || '',
    loginPin: String(loginPin || '').replace(/[^0-9]/g, '').slice(0, 8),
    autoPin: autoPin === undefined ? !!loginPin : (autoPin === true || autoPin === 'true'),
    autoCommands: Array.isArray(autoCommands) ? autoCommands : [],
    autoServerSelect: autoServerSelect === true || autoServerSelect === 'true',
    serverSelectItem: serverSelectItem || 'grass_block',
    autoEat: autoEat === undefined ? true : (autoEat === true || autoEat === 'true'),
    autoWalk: autoWalk === undefined ? true : (autoWalk === true || autoWalk === 'true'), // เดินไปหา NPC เองหลังใส่ PIN เสร็จ
    autoClick: autoClick === undefined ? true : (autoClick === true || autoClick === 'true'), // ถึง NPC แล้วคลิกขวาเอง
    autoAttack: autoAttack === true || autoAttack === 'true', // ตีคลิกซ้ายอัตโนมัติ
    attackDelay: clampAttackDelay(attackDelay), // ดีเลย์ระหว่างการตีแต่ละครั้ง (ms)
    autoTpa: autoTpa === true || autoTpa === 'true', // false (ค่าเริ่มต้น) = แจ้งแล้วรอให้กดเลือกเองที่เว็บ/Discord · true = ยอมรับให้เองทันที
    pinDelay: clampPinDelay(pinDelay), // โหมด PIN อัตโนมัติ: รอหลังแป้นขึ้นกี่ ms ก่อนเริ่มกด
    webhookOn: webhookOn === undefined ? true : (webhookOn === true || webhookOn === 'true'),
    webhookUrl: whNormalize(webhookUrl), // webhook เฉพาะบอทตัวนี้ (ว่าง = ใช้ตัวรวมจาก /config)
    webhookMsgId: webhookMsgId || null,  // id ข้อความ "การ์ดสถานะ" ของบอทตัวนี้ใน Discord (แก้ไขข้อความเดิมแทนการส่งใหม่)
    webhookMsgUrl: webhookMsgUrl || '',
    reconnectAttempt: 0,
    reconnectInfo: null
  }

  let bot = null
  let reconnectTimeout = null
  let autoCmdTimers = []
  let reconnectAttempts = 0
  let dialogAttempts = 0
  let dialogSeenPreSpawn = false // เจอ dialog ก่อน spawn -> ขยายเวลา timeout
  let pinCooldownUntil = 0
  let pinLatest = null
  let pinRecheck = null
  let pinSubmits = 0             // จำนวนครั้งที่บอทกรอก PIN ครบ 4 หลัก (กันโดนล็อก) — ข้าม reconnect
  let pinRun = null              // สถานะการกด PIN ที่กำลังทำอยู่
  let pinLastDialog = null       // dialog PIN ล่าสุดที่เซิร์ฟเวอร์ส่งมา (ปุ่ม + จำนวนครั้งที่เหลือ + จุดแสดงหลัก)
  let pinSoftFails = 0           // รอบที่เซิร์ฟเวอร์ "ไม่นับ" (คลิกไม่ครบ/ถูกรีเซ็ต) — ไม่เสียโอกาส แต่จำกัดไว้กันวน
  let pinWrong = false           // เซิร์ฟเวอร์ยืนยันแล้วว่า PIN ที่บันทึกไว้ผิด (กดครบทุกหลักและถูกนับว่าผิด)
  let pinDotsProven = false      // เคยเห็นจุดเปลี่ยนตามการกดจริง = เชื่อจุดได้ (ใช้ตัดสินว่าคลิกถูกรับหรือไม่)
  let pinDotEmpty = '○'          // สัญลักษณ์จุด "ว่าง" ในหน้า PIN
  let clickHexLogged = 0
  let physTicks = 0
  let forcedMoves = 0
  let groundFalse = 0            // จำนวน physics tick ที่ onGround=false (ใช้วัดอาการ "ลอย/ตก มาๆ หายๆ")
  let lastGround = false         // onGround ของ tick ล่าสุดก่อนเซิร์ฟเวอร์แก้ตำแหน่ง
  let lastVel = null             // ความเร็วแนวนอนของ tick ล่าสุด
  let softFixes = 0              // จำนวนครั้งที่ฟื้น onGround/ความเร็วหลังเซิร์ฟเวอร์แค่ "ซิงก์" ตำแหน่ง
  let outMoves = 0               // จำนวนแพ็กเก็ตเคลื่อนที่ที่บอทส่งออกไปจริง (position/look/flying)
  let sentLoaded = false         // บอทเคยส่ง player_loaded หรือยัง
  // --- ให้บอทส่งแพ็กเก็ตครบเหมือนไคลเอนต์จริง (ถ้า mineflayer ไม่ส่ง เราส่งแทนและ log บอก) ---
  let pullTimes = []             // เวลาที่เซิร์ฟเวอร์ดึงตำแหน่งบอท (forcedMove) ใน 10 วิล่าสุด
  let lastPullAt = 0
  let lastPullOut = 0            // outMoves ตอนถูกดึงครั้งก่อน
  let pullLogN = 0               // จำนวนครั้งที่ log รายละเอียดการถูกดึง (รีเซ็ตทุกครั้งที่เริ่มกดเดินใหม่)
  let outSeen = {}               // ชื่อแพ็กเก็ตใน play ที่บอทส่งออกไป -> จำนวน
  let settingsAny = false        // บอทเคยส่ง settings/client_information (state ไหนก็ได้) ในการเชื่อมต่อนี้
  let tpConfirmed = new Set()    // teleportId ที่บอทตอบ confirm แล้ว
  let tpSeenIn = 0, tpForced = 0
  let chunkBatchesIn = 0, chunkAcksOut = 0, chunkAcksForced = 0
  let pongSent = new Set(), pongForced = 0
  let tickEndOut = 0, tickEndForce = false, tickEndChecked = false, tickEndForced = 0
  let entryToken = 0
  let walkDiagDone = false
  let lastPhys = null            // ตำแหน่งล่าสุดที่ physics ของบอทคำนวณได้ (ก่อนเซิร์ฟเวอร์ดึงกลับ)
  let connectBeganAt = 0         // เวลาที่เริ่มเชื่อมต่อรอบนี้ (ใช้โชว์หน้าโหลดระหว่างรอหน้า PIN)
  let uiEverShown = false        // เคยมี dialog/หน้าต่างของเซิร์ฟเวอร์ขึ้นแล้วในรอบการเชื่อมต่อนี้
  let winDumpAt = 0
  let uiDialog = null          // dialog ล่าสุดที่เซิร์ฟเวอร์ส่งมา (ให้แดชบอร์ดแสดง/กดเอง)
  let pinManualUntil = 0       // ช่วงที่ให้คนกด PIN เอง — บอทจะไม่กดอัตโนมัติ
  let pinSeenAt = 0            // เวลาล่าสุดที่เซิร์ฟเวอร์ส่งหน้า PIN pad มา
  let pinClearedAt = 0         // เวลาที่เซิร์ฟเวอร์ปิดหน้า PIN (clear_dialog)
  let pinBlockedAt = 0         // เวลาล่าสุดที่เซิร์ฟเวอร์ตอบ "กรุณากรอกรหัส PIN ก่อนใช้งาน"
  let traceSeen = new Set()
  let kaSent = new Set()      // keepAliveId ที่บอทตอบกลับไปแล้ว (ใช้เช็คว่าต้องตอบแทนไหม)
  let kaForced = 0            // จำนวนครั้งที่เราตอบ keep_alive แทน mineflayer
  let useItemVariant = 0   // layout ของแพ็กเก็ต use_item ที่ใช้อยู่ — หมุนเมื่อเซิร์ฟเวอร์ decode ไม่ได้ (จำข้ามการ reconnect)
  let useItemFails = 0     // จำนวนครั้งที่โดนเตะเพราะ decode use_item ไม่ได้ (ครบทุก layout แล้วจะเลิกคลิกอัตโนมัติ กันวนโดนเตะไม่จบ)
  let useItemBroken = false
  let useItemDiag = 0
  let dialogVariant = 0 // layout ของ payload ใน custom_click_action — จำข้ามการ reconnect (หมุนเมื่อเซิร์ฟเวอร์ decode ไม่ได้)
  let msa = null                 // โค้ดล็อกอิน Microsoft ที่กำลังรอให้ผู้ใช้ยืนยัน { code, uri, at, until } — ระหว่างรอห้ามขอโค้ดใหม่/ห้าม reconnect
  let pinWaitTimer = null        // ตัวนับเวลา "รอแป้น PIN พร้อมก่อนกด" (โหมดอัตโนมัติ)
  let pinManualLogged = false    // โหมดใส่ PIN เอง: แจ้งแล้วหรือยังในการเชื่อมต่อรอบนี้
  let autoEatInterval = null
  const MAX_RECONNECT_ATTEMPTS = 100
  const BASE_RECONNECT_DELAY = 5000
  const MAX_RECONNECT_DELAY = 60000
  const STOPPED_STATES = new Set(['stopped', 'auth_failed', 'banned'])

  function cleanupBot() {
    if (autoEatInterval) { clearInterval(autoEatInterval); autoEatInterval = null }
    for (let i = 0; i < autoCmdTimers.length; i++) {
      try { clearTimeout(autoCmdTimers[i]) } catch {}
    }
    autoCmdTimers = []
    if (pinWaitTimer) { clearTimeout(pinWaitTimer); pinWaitTimer = null }
    if (bot) {
      try { bot.removeAllListeners() } catch (err) { console.error(`[BOT ${state.id}] Cleanup error:`, err.message) }
      // ปิดการเชื่อมต่อแบบไล่ลำดับ: bot.quit() -> bot.end() -> ปิด client/socket ตรง ๆ
      // (bot.quit/end ถูกใส่โดย plugin ของ mineflayer หลังตรวจเวอร์ชันสำเร็จ ถ้า error ก่อนหน้านั้น (เช่น ต่อเซิร์ฟเวอร์ไม่ติด) จะยังไม่มี
      //  เดิมเรียก bot.quit() ตรง ๆ แล้ว throw -> socket ไม่ถูกปิด และ log "bot.quit is not a function" ซ้ำทุกรอบ reconnect)
      const c0 = bot._client
      let closed = false
      for (const fn of ['quit', 'end']) {
        if (closed || typeof bot[fn] !== 'function') continue
        try { bot[fn](); closed = true } catch (err) { console.error(`[BOT ${state.id}] Cleanup ${fn} error:`, err.message) }
      }
      try {
        if (c0 && !c0.destroyed) {
          if (!closed && typeof c0.end === 'function') c0.end('cleanup')
          if (c0.socket && !c0.socket.destroyed) setTimeout(() => { try { c0.socket.destroy() } catch {} }, 1500)
        }
      } catch (err) {
        console.error(`[BOT ${state.id}] Cleanup socket error:`, err.message)
      }
      resetControls()
      bot = null
    }
  }

  // กำลังรอให้ผู้ใช้ยืนยันโค้ด Microsoft อยู่หรือเปล่า (โค้ดอายุ ~15 นาที — ระหว่างนี้ห้ามตัดการเชื่อมต่อแล้วขอโค้ดใหม่)
  function msaWaiting() {
    return !!(msa && msa.until > Date.now() && bot && state.status === 'connecting')
  }

  function scheduleReconnect() {
    if (STOPPED_STATES.has(state.status) || reconnectTimeout) return
    if (msaWaiting()) return
    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts),
      MAX_RECONNECT_DELAY
    )
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null
      reconnectAttempts++
      connect()
    }, delay)
    state.reconnectAttempt = reconnectAttempts + 1
    state.reconnectInfo = { attempt: reconnectAttempts + 1, delay, at: Date.now() }
    pushLog(state, `Reconnecting in ${Math.round(delay / 1000)}s... (attempt ${reconnectAttempts + 1})`)
  }

  function runAutoCommands() {
    if (!state.autoCommands || state.autoCommands.length === 0) return
    for (let i = 0; i < state.autoCommands.length; i++) {
      const { delay, cmd } = state.autoCommands[i]
      if (!cmd || !cmd.trim()) continue
      const delayMs = Math.max(0, Number(delay) || 2000)
      const t = setTimeout(() => {
        if (bot && state.status === 'online') {
          bot.chat(cmd.trim())
          pushLog(state, `[AUTO] ${cmd.trim()}`)
        }
      }, delayMs)
      autoCmdTimers.push(t)
    }
  }

  function connect() {
    if (msaWaiting()) {
      pushLog(state, `[MSA] ยังรอยืนยันโค้ด ${msa.code} อยู่ (หมดอายุ ${clockOf(msa.until)}) — ไม่ขอโค้ดใหม่ให้ · ถ้าต้องการโค้ดใหม่ให้กด Stop แล้วค่อย Start`)
      return
    }
    msa = null
    cleanupBot()
    if (state.status === 'starting') reconnectAttempts = 0

    state.status = 'connecting'
    state.connectedAt = null
    pushLog(state, 'Connecting...')

    // ✅ ข้อ 4: ใช้ serverConfig ปัจจุบัน
    const options = {
      host: serverConfig.host,
      port: serverConfig.port,
      username: state.originalUsername,
      version: serverConfig.version ? serverConfig.version : false,
      physicsEnabled: true,
      hideErrors: true
    }

    if (state.accountType === 'premium') {
      options.auth = 'microsoft'
      if (AUTH_CACHE_DIR) options.profilesFolder = AUTH_CACHE_DIR // เก็บโทเคนไว้ในโฟลเดอร์ที่เขียนได้แน่ ๆ (ล็อกอินครั้งเดียวจบ)
      // แสดงโค้ดล็อกอิน Microsoft ในแดชบอร์ด + Discord
      // โค้ดเดียวกันไม่แจ้งซ้ำ · ระหว่างรอผู้ใช้กรอกโค้ดจะไม่ตัดการเชื่อมต่อ/ไม่ reconnect (เดิม timeout 30 วิ ทำให้ขอโค้ดใหม่รัว ๆ)
      options.onMsaCode = (d) => {
        try {
          const code = d && d.user_code
          const now = Date.now()
          if (msa && msa.code === code && msa.until > now) return
          const ttl = Math.max(60, Number(d && d.expires_in) || 900) * 1000
          const uri = (d && d.verification_uri) || 'https://www.microsoft.com/link'
          msa = { code, uri, at: now, until: now + ttl }
          pushLog(state, `[MSA] เปิด ${uri} แล้วใส่โค้ด ${code} เพื่อล็อกอิน (โค้ดหมดอายุ ${clockOf(msa.until)} — บอทจะรอจนกว่าจะหมดอายุ ไม่ขอโค้ดใหม่)`)
          whNotifyMsa(state, msa)
        } catch {}
      }
    }

    // ---- LITE MODE: ลด CPU/แรมเมื่อยืนในจุดที่มี entity / piston / block entity เยอะ ----
    // BOT_VIEW_DISTANCE = tiny(2) | short(4) | normal(8) | far(12) | ตัวเลข  (ค่าเริ่มต้น tiny — เซิร์ฟเวอร์ส่ง chunk/entity รอบตัวบอทน้อยลงมาก)
    // BOT_LITE=0 = ปิดโหมดนี้ทั้งหมด (กลับไปพฤติกรรมเดิม)
    const liteOn = process.env.BOT_LITE !== '0'
    if (liteOn) {
      const vd = String(process.env.BOT_VIEW_DISTANCE || 'tiny').trim().toLowerCase()
      options.viewDistance = /^\d+$/.test(vd) ? Math.max(2, Math.min(32, Number(vd))) : vd
      // ปิดปลั๊กอินภายในของ mineflayer ที่ระบบนี้ไม่ได้ใช้ และทำงานหนักตอนมี piston/อนุภาค/เสียงเยอะ
      options.plugins = {}
      for (const n of ['block_actions', 'particle', 'sound', 'explosion', 'boss_bar', 'book', 'fishing', 'villager', 'enchantment_table', 'anvil', 'command_block']) options.plugins[n] = false
    }

    try {
      try {
        bot = mineflayer.createBot(options)
        if (liteOn) pushLog(state, `[LITE] เปิดอยู่ (viewDistance=${options.viewDistance}) — ถ้าสงสัยว่าทำให้หลุด/โดนเตะ ตั้ง env BOT_LITE=0 แล้ว restart`)
      } catch (e1) {
        if (!liteOn) throw e1
        pushLog(state, `[LITE] เปิดโหมดประหยัดไม่สำเร็จ (${e1 && e1.message}) — ใช้การตั้งค่าเดิมแทน`)
        delete options.plugins; delete options.viewDistance
        bot = mineflayer.createBot(options)
      }
      try { bot._client.setMaxListeners(100) } catch {}
      guardPacketHandlers(bot)
      installParserGuard(bot)
      traceOutbound(bot)
      dialogAttempts = 0
      dialogSeenPreSpawn = false
      pinRun = null
      pinLastDialog = null
      pinManualLogged = false
      if (pinWaitTimer) { clearTimeout(pinWaitTimer); pinWaitTimer = null }
      physTicks = 0
      outMoves = 0
      sentLoaded = false
      pullTimes = []; lastPullAt = 0; lastPullOut = 0; pullLogN = 0
      outSeen = {}; settingsAny = false
      tpConfirmed = new Set(); tpSeenIn = 0; tpForced = 0
      chunkBatchesIn = 0; chunkAcksOut = 0; chunkAcksForced = 0
      pongSent = new Set(); pongForced = 0
      kaSent = new Set(); kaForced = 0
      tickEndOut = 0; tickEndForce = false; tickEndChecked = false; tickEndForced = 0
      walkDiagDone = false
      lastTickSeen = 0
      lastTickAt = Date.now()
      uiDialog = null
      connectBeganAt = Date.now(); uiEverShown = false
      pinBlockedAt = 0
      pinSeenAt = 0
      pinClearedAt = 0
      bot.on('windowOpen', (w) => { uiEverShown = true; try { scheduleWindowPin(w) } catch {} try { scheduleTpaWindow() } catch {} setTimeout(() => { try { logWindowSlots(w) } catch {} }, 900); let t = ''; try { t = uiWinTitle(w) } catch {} pushLog(state, `[UI] เซิร์ฟเวอร์เปิดหน้าต่าง: ${t || w.type || '?'} — กดเองได้ที่แดชบอร์ด (Server UI)`) })
      bot.on('windowClose', () => pushLog(state, '[UI] หน้าต่างถูกปิด'))
      bot.on('physicsTick', () => {
        physTicks++
        try {
          const e = bot.entity
          if (e && e.position) {
            if (!e.onGround) groundFalse++
            lastGround = !!e.onGround
            lastVel = e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null
            lastPhys = { x: e.position.x, y: e.position.y, z: e.position.z }
          }
        } catch {}
        // ไคลเอนต์ 1.21.2+ ส่ง tick_end ท้ายทุก tick — ถ้า mineflayer ไม่ส่ง (ผ่านไป ~4 วิยังไม่มีเลย) เราส่งแทนหลังแพ็กเก็ตเดินของ tick นั้น
        try {
          const cl = bot._client
          if (!tickEndChecked && physTicks >= 80 && cl && cl.state === 'play') {
            tickEndChecked = true
            if (!tickEndOut && hasPacket('tick_end')) {
              tickEndForce = true
              pushLog(state, '[CTRL] 🔧 บอทไม่เคยส่ง tick_end (ไคลเอนต์จริงส่งทุก tick) — ส่งให้เองต่อจากนี้')
            }
          }
          if (tickEndForce && cl && cl.state === 'play') {
            setImmediate(() => { try { if (bot && bot._client === cl && cl.state === 'play') { cl.write('tick_end', {}); tickEndForced++ } } catch {} })
          }
        } catch {}
      })
      bot.on('forcedMove', () => {
        forcedMoves++
        const nowPull = Date.now()
        const dtPull = lastPullAt ? nowPull - lastPullAt : -1
        lastPullAt = nowPull
        pullTimes.push(nowPull)
        while (pullTimes.length && nowPull - pullTimes[0] > 10000) pullTimes.shift()
        const outSince = outMoves - lastPullOut
        lastPullOut = outMoves
        try { logPull(dtPull, outSince) } catch {}
        try { softenForcedMove() } catch {}
      })
      pushLog(state, '[BUILD] manual-control v2 (เดินเอง W A S D + คลิกขวา NPC เอง + จอพิกัด NPC · ส่ง teleport_confirm / chunk_batch_received / pong / tick_end / settings / player_loaded แทน mineflayer ถ้าขาด · log การถูกดึงกลับ + เวอร์ชัน/ความเร็วฟิสิกส์ตอนเริ่มเดิน)')
      traceSeen = new Set()
      setupDialogLogin(bot)
      setupAutoWalk(bot)
      setupResourcePack(bot)
      try { installPacketDrop(bot) } catch (e) { pushLog(state, `[DROP] ไม่เปิดใช้: ${e && e.message}`) }
    } catch (err) {
      state.status = 'error'
      pushLog(state, `[ERROR] Failed to create bot: ${err.message}`)
      scheduleReconnect()
      return
    }

    // ---- ตัวช่วยรับมือ "Parse error" (แพ็กเก็ตเดียวอ่านไม่ออก ไม่ควรทำให้บอททั้งตัวตาย) ----
    const connBot = bot
    let pktCount = 0          // จำนวนแพ็กเก็ตที่แกะสำเร็จ (ใช้ดูว่า stream ยังเดินอยู่ไหมหลังเกิด parse error)
    let parseErrN = 0         // จำนวน parse error ในการเชื่อมต่อนี้
    let parseWatch = null     // timer เฝ้าดูว่าหลัง parse error แล้ว stream ค้างหรือเปล่า
    try { connBot._client.on('packet', () => { pktCount++ }) } catch {}
    let lastPktSeenAt = Date.now()   // เวลาล่าสุดที่เห็นแพ็กเก็ตเข้า (อัปเดตโดย watchdog ด้านล่างทุก 5 วิ)
    {
      // ZOMBIE WATCHDOG: เซิร์ฟเวอร์ส่ง keep_alive ทุก ~15 วิ ถ้าออนไลน์อยู่แต่ไม่มีแพ็กเก็ตเข้าเลยเกิน 45 วิ = stream ค้าง/ตาย
      // ต่อใหม่เองดีกว่ารอให้เซิร์ฟเวอร์ตัด disconnect.timeout (ไม่ทำงานตอนสถานะอื่น เช่น stopped/kicked/connecting)
      let lastCount = 0
      const zw = setInterval(() => {
        try {
          if (bot !== connBot) { clearInterval(zw); return }
          if (pktCount !== lastCount) { lastCount = pktCount; lastPktSeenAt = Date.now(); return }
          if (state.status === 'online' && Date.now() - lastPktSeenAt > 45000) {
            clearInterval(zw)
            pushLog(state, `[WATCHDOG] ไม่มีแพ็กเก็ตเข้าเลย ${Math.round((Date.now() - lastPktSeenAt) / 1000)} วิ (stream ค้าง/ตาย) — ต่อใหม่ก่อนโดน disconnect.timeout`)
            cleanupBot()
            state.status = 'offline'
            scheduleReconnect()
          }
        } catch {}
      }, 5000)
      autoCmdTimers.push(zw)   // cleanupBot() จะเคลียร์ให้ (clearTimeout ใช้กับ interval ได้)
    }
    const packetNameFromBuffer = (buf) => {
      try {
        if (!buf || !buf.length) return null
        let id = 0, shift = 0
        for (let i = 0; i < 5 && i < buf.length; i++) { const x = buf[i]; id |= (x & 0x7f) << shift; if (!(x & 0x80)) break; shift += 7 }
        const pr = connBot.registry && connBot.registry.protocol
        const types = pr && pr.play && pr.play.toClient && pr.play.toClient.types
        const fields = types && types.packet && types.packet[1]
        const nameField = Array.isArray(fields) ? fields.find(f => f && f.name === 'name') : null
        const mappings = nameField && nameField.type && nameField.type[1] && nameField.type[1].mappings
        const nm = mappings ? mappings[id] || mappings['0x' + id.toString(16).padStart(2, '0')] : null
        return `id=0x${id.toString(16)}${nm ? ' (' + nm + ')' : ''}`
      } catch { return null }
    }

    const connectionTimeout = setTimeout(() => {
      // กำลังรอผู้ใช้ยืนยันโค้ด Microsoft → รอต่อ (เช็กใหม่ทุก 30 วิ) จนกว่าโค้ดจะหมดอายุ
      if (state.status === 'connecting' && msa && msa.until > Date.now()) { connectionTimeout.refresh(); return }
      if (state.status === 'connecting' && msa && msa.until <= Date.now()) {
        pushLog(state, `[MSA] โค้ด ${msa.code} หมดอายุแล้วและยังไม่มีการยืนยัน — จะขอโค้ดใหม่ในรอบ reconnect ถัดไป`)
        msa = null
      }
      if (state.status === 'connecting' && dialogSeenPreSpawn && !connectionTimeout._extended) {
        connectionTimeout._extended = true
        pushLog(state, '[DIALOG] ยังรอ dialog ของเซิร์ฟเวอร์อยู่ — ขยายเวลารออีก 60 วินาที')
        connectionTimeout.refresh()
        return
      }
      if (state.status === 'connecting') {
        pushLog(state, 'Connection timed out after 30s' + (connectionTimeout._extended ? ' (+60s)' : ''))
        cleanupBot()
        state.status = 'error'
        scheduleReconnect()
      }
    }, 30000)
    // ล็อกอิน Microsoft ผ่านแล้ว (ได้ session) → เลิกรอโค้ด แล้วเริ่มนับ timeout 30 วิสำหรับการเข้าเซิร์ฟเวอร์ใหม่
    try {
      connBot._client.on('session', () => {
        if (bot !== connBot) return
        if (msa) pushLog(state, '[MSA] ✅ ล็อกอิน Microsoft สำเร็จ — กำลังเข้าเซิร์ฟเวอร์')
        msa = null
        connectionTimeout.refresh()
      })
    } catch {}

    let joined = false
    const onJoined = (viaFallback) => {
      if (joined) return
      joined = true
      clearTimeout(connectionTimeout)
      if (viaFallback) {
        pushLog(state, '[TRACE] ไม่ได้รับ event spawn แต่เซิร์ฟเวอร์ส่งข้อมูลโลกมาแล้ว — ถือว่าเข้าเซิร์ฟสำเร็จ (fallback)')
        sendPlayerLoadedIfMissing()
      }
      state.status = 'online'
      state.connectedAt = Date.now()
      reconnectAttempts = 0
      state.reconnectAttempt = 0
      msa = null
      if (bot.username && bot.username !== state.username) {
        state.username = bot.username
      }
      pushLog(state, 'Connected successfully')

      if (autoEatInterval) clearInterval(autoEatInterval)
      autoEatInterval = setInterval(() => {
        tryAutoEat().catch(e => pushLog(state, `[AUTO-EAT] error: ${e.message}`))
      }, 4000)

      if (state.autoServerSelect) {
        const selectDelay = ((state.autoLogin && state.loginPassword) || (state.autoPin && state.loginPin)) ? 4500 : 2000
        const t = setTimeout(() => {
          if (bot && state.status === 'online') {
            joinServerSelector()
          }
        }, selectDelay)
        autoCmdTimers.push(t)
      }

      pushLog(state, '[CTRL] เดินเอง/คลิกขวาเอง ได้ที่แดชบอร์ด แท็บ Control (มีจอตำแหน่งตัวบอทและ NPC ใกล้ตัว)')

      setTimeout(() => {
        runAutoCommands()
      }, 2500)
    }
    bot.once('spawn', () => onJoined(false))

    // fallback: เข้า play state แล้วแต่ spawn ไม่ยิง (เกิดกับเวอร์ชันใหม่/เซิร์ฟที่ล็อกผู้เล่นไว้ที่หน้า login)
    // อย่าปล่อยให้ timeout 30s ตัดการเชื่อมต่อทิ้ง ไม่งั้นจะวนเข้า-ออกไม่จบและไม่เคยได้ตอบ dialog
    {
      const thisBot = bot
      let playSeen = false
      thisBot._client.on('packet', (d, m) => {
        if (playSeen || !m || m.state !== 'play') return
        playSeen = true
        const t = setTimeout(() => {
          if (bot === thisBot && state.status === 'connecting') onJoined(true)
        }, 8000)
        autoCmdTimers.push(t)
      })
    }

    bot.on('message', (jsonMsg) => {
      const msgText = stringifyMsg(jsonMsg)
      if (msgText && /กรุณากรอกรหัส\s*PIN|กรอกรหัส\s*PIN\s*ก่อน/i.test(msgText)) pinBlockedAt = Date.now()
      try { if (msgText) detectTpa(msgText) } catch {}
      if (msgText && msgText !== state.lastChatText) {
        state.lastChatText = msgText
        pushChat(state, msgText)
      }
      if (msgText && /kicked from|were kicked|ถูกเตะ/i.test(msgText)) {
        // ข้อความโดนเตะสำคัญ — ลงใน Log ด้วย (นอกจากแชท)
        pushLog(state, '[KICK] ' + msgText)
        try { pushLog(state, '[KICK-RAW] ' + JSON.stringify(jsonMsg && jsonMsg.json !== undefined ? jsonMsg.json : jsonMsg).slice(0, 600)) } catch {}
      }
    })

    bot.on('kicked', (reason) => {
      clearTimeout(connectionTimeout)
      const reasonStr = stringifyMsg(reason)
      if (reasonStr.toLowerCase().includes('ban')) {
        state.status = 'banned'
        pushLog(state, `BANNED: ${reasonStr}`)
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout)
          reconnectTimeout = null
        }
        return
      }
      state.status = 'kicked'
      pushLog(state, `KICKED: ${reasonStr}`)
      if (/timeout|timed out/i.test(reasonStr)) {
        try {
          const quiet = Math.round((Date.now() - lastPktSeenAt) / 1000)
          const lagAgo = perfLast.at ? Math.round((Date.now() - perfLast.at) / 1000) : null
          pushLog(state, `[TIMEOUT] วินิจฉัย: เห็นแพ็กเก็ตเข้าล่าสุดเมื่อ ~${quiet} วิก่อน (เช็คทุก 5 วิ) · parse error ${parseErrN} ครั้ง · ตอบ keep_alive แทน ${kaForced} ครั้ง · event loop ค้างล่าสุด ${perfLast.ms ? perfLast.ms + 'ms เมื่อ ' + lagAgo + ' วิก่อน' : 'ไม่เคยเกิน 1 วิ'}`)
          pushLog(state, '[TIMEOUT] อ่านผล: ถ้า parse error>0 และแพ็กเก็ตเงียบ = stream เสีย · ถ้า event loop ค้างใกล้เวลาโดนเตะ = โฮสต์ CPU/แรมไม่พอ (ลอง BOT_VIEW_DISTANCE=tiny, ลดจำนวนบอท) · ถ้าแพ็กเก็ตยังมาปกติ = ฝั่งเซิร์ฟเวอร์/พร็อกซีตัดเอง')
        } catch {}
      }
      if (/custom_click_action/i.test(reasonStr) && /decode/i.test(reasonStr)) {
        const used = dialogVariant % CLICK_LAYOUTS.length
        dialogVariant++
        pushLog(state, `[DIALOG] server rejected layout #${used} (${CLICK_LAYOUTS[used]}) — next reconnect will try #${dialogVariant % CLICK_LAYOUTS.length} (${CLICK_LAYOUTS[dialogVariant % CLICK_LAYOUTS.length]})`)
      }
      if (/use_item/i.test(reasonStr) && /decode/i.test(reasonStr)) {
        const used = useItemVariant % USE_ITEM_LAYOUTS.length
        useItemFails++
        useItemVariant++
        if (useItemFails >= USE_ITEM_LAYOUTS.length * 2) {
          useItemBroken = true
          pushLog(state, `[USE_ITEM] ลองครบทุก layout แล้วเซิร์ฟเวอร์ยัง decode ไม่ได้ — เลิกคลิกขวาไอเทมอัตโนมัติ (ส่ง log บรรทัด [USE_ITEM] schema/bytes ด้านบนมาดู) · กดเปิดใช้ใหม่ได้ด้วยการ restart`)
        } else {
          pushLog(state, `[USE_ITEM] เซิร์ฟเวอร์ decode layout #${used} (${USE_ITEM_LAYOUTS[used]}) ไม่ได้ — รอบหน้าจะลอง #${useItemVariant % USE_ITEM_LAYOUTS.length} (${USE_ITEM_LAYOUTS[useItemVariant % USE_ITEM_LAYOUTS.length]})`)
        }
      }
      if (/version|เวอร์ชัน|เวอร์ชั่น/i.test(reasonStr)) {
        pushLog(state, `[HINT] เซิร์ฟเวอร์ขอให้ใช้เวอร์ชันอื่น — ตั้งค่า Game Version ที่หน้า /config (ตอนนี้: ${serverConfig.version || 'auto'}) และต้องใช้ mineflayer ที่รองรับเวอร์ชันนั้น`)
      }
    })

    bot.on('error', (err) => {
      const msg = err?.message || String(err)
      /* Parse error / PartialReadError = แพ็กเก็ต "เดียว" ที่ schema ของไลบรารีอ่านไม่ตรงกับเซิร์ฟเวอร์ (เช่น array size ใหญ่ผิดปกติ)
         ไม่ใช่การหลุดของการเชื่อมต่อ → ห้ามตัดบอททิ้ง (เดิมตรงนี้ทำให้สถานะเป็น error + cleanupBot() + ไม่มี reconnect = บอทตายถาวร)
         ไม่ clearTimeout(connectionTimeout) ตรงนี้ เพื่อให้ถ้าค้างตอนกำลังเชื่อมต่อ timeout 30s ยังทำงานตามเดิม */
      if (/Parse error for|array size is abnormally large|PartialReadError|Read error for/i.test(msg)) {
        parseErrN++
        if (parseErrN <= 5 || parseErrN % 50 === 0) {
          let extra = ''
          try {
            const buf = err && (err.buffer || err.packet)
            const nm = packetNameFromBuffer(Buffer.isBuffer(buf) ? buf : null)
            if (nm) extra = ` | แพ็กเก็ต ${nm} ยาว ${buf.length}B hex=${buf.subarray(0, 24).toString('hex')}`
          } catch {}
          pushLog(state, `[ERROR] ${msg}${extra} (ข้ามแพ็กเก็ตนี้ ไม่ตัดการเชื่อมต่อ · ครั้งที่ ${parseErrN})`)
        }
        // ปกติ installParserGuard กันไม่ให้ parser ตายแล้ว แต่ถ้ายังตายอยู่ (destroyed) = ไม่มีทางรับ keep_alive อีก → ต่อใหม่ทันที ไม่รอโดน timeout
        try {
          const dz = connBot && connBot._client && connBot._client.deserializer
          if (dz && dz.destroyed && state.status === 'online' && bot === connBot) {
            pushLog(state, '[WATCHDOG] parser ตายหลัง parse error (จะไม่ได้รับแพ็กเก็ตอีก) — ต่อใหม่ทันที')
            cleanupBot()
            state.status = 'offline'
            scheduleReconnect()
            return
          }
        } catch {}
        // กันกรณี stream ค้างแต่ไม่ได้ destroyed → ถ้าเงียบเกิน 15 วิ ให้ต่อใหม่เอง
        if (!parseWatch) {
          const before = pktCount
          parseWatch = setTimeout(() => {
            parseWatch = null
            if (bot === connBot && connBot && state.status === 'online' && pktCount === before) {
              pushLog(state, '[WATCHDOG] หลัง parse error แล้วไม่มีแพ็กเก็ตเข้าเลย 15 วิ — ต่อใหม่')
              cleanupBot()
              state.status = 'offline'
              scheduleReconnect()
            }
          }, 15000)
        }
        return
      }
      clearTimeout(connectionTimeout)
      msa = null
      if (state.status === 'online' && /Serialization error|SizeOf error/i.test(msg)) { pushLog(state, `[ERROR] ${msg} (ข้าม ไม่ตัดการเชื่อมต่อ)`); return }
      if (msg.includes('profile') || msg.includes('auth') || msg.includes('token')) {
        state.status = 'auth_failed'
        pushLog(state, `[AUTH ERROR] ${msg}`)
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout)
          reconnectTimeout = null
        }
        return
      }
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT')) {
        state.status = 'connection_error'
        pushLog(state, `[CONNECTION] ${msg}`)
      } else {
        state.status = 'error'
        pushLog(state, `[ERROR] ${msg}`)
      }
      cleanupBot()
      // cleanupBot() ถอด listener 'end' ออกแล้ว จึงต้องสั่งต่อใหม่เองตรงนี้ ไม่งั้นบอทค้างสถานะ error จนกว่าจะกด connect เอง
      scheduleReconnect()
    })

    bot.on('end', (reason) => {
      clearTimeout(connectionTimeout)
      if (STOPPED_STATES.has(state.status)) return
      state.status = 'offline'
      pushLog(state, 'Disconnected. Reconnecting...')
      scheduleReconnect()
    })
  }

  /* ---- Server password dialog (Minecraft 1.21.6+ "Dialog" screen) ----
     Servers can pop up a native screen with a text box + buttons (this is what the
     "WELCOME TO ..." password screen is). The bot has no screen, so we read the
     show_dialog packet, fill the text input(s) with the saved password and
     "click" the confirm button by sending the same packet the real client would. */

  const NBT_TAGS = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'string', 'byteArray', 'intArray', 'longArray', 'list', 'compound'])

  function nbtToPlain(x) {
    if (x === null || x === undefined) return x
    if (Array.isArray(x)) return x.map(nbtToPlain)
    if (typeof x === 'object') {
      if (typeof x.type === 'string' && NBT_TAGS.has(x.type) && 'value' in x) {
        const v = x.value
        if (x.type === 'compound') {
          const o = {}
          const types = {}
          for (const k of Object.keys(v || {})) {
            o[k] = nbtToPlain(v[k])
            if (v[k] && typeof v[k].type === 'string') types[k] = v[k].type
          }
          // เก็บชนิดของ tag ไว้แบบไม่โผล่ใน JSON (ใช้ตอนส่งค่า additions กลับให้ตรงชนิดเดิม เช่น int array)
          Object.defineProperty(o, '__types', { value: types, enumerable: false })
          return o
        }
        if (x.type === 'list') {
          const items = v && Array.isArray(v.value) ? v.value : []
          return items.map(i => (v.type === 'compound' ? nbtToPlain({ type: 'compound', value: i }) : i))
        }
        if (Array.isArray(v)) {
          const arr = v.slice()
          Object.defineProperty(arr, '__nbt', { value: x.type, enumerable: false })
          return arr
        }
        return v
      }
      const o = {}
      for (const k of Object.keys(x)) o[k] = nbtToPlain(x[k])
      return o
    }
    return x
  }

  function textOf(c) {
    try {
      if (c === null || c === undefined) return ''
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return c.map(textOf).join('')
      return (c.text || c.translate || '') + (c.extra ? textOf(c.extra) : '')
    } catch { return '' }
  }

  function findDialogRoot(node) {
    // find the object that actually describes the dialog (has inputs/yes/action/actions)
    if (!node || typeof node !== 'object') return null
    if (node.inputs || node.yes || node.actions || (node.action && node.action.action) || node.type) {
      if (node.inputs || node.yes || node.actions || (node.action && node.action.action)) return node
    }
    for (const k of Object.keys(node)) {
      const r = findDialogRoot(node[k])
      if (r) return r
    }
    return null
  }

  function pickButton(dlg) {
    if (dlg.yes && dlg.yes.action) return dlg.yes                       // confirmation
    if (dlg.action && dlg.action.action) return dlg.action              // notice
    if (Array.isArray(dlg.actions) && dlg.actions.length) {             // multi_action
      return dlg.actions.find(a => a && a.action) || null
    }
    return null
  }

  function readVarInt(buf, pos) {
    let value = 0, shift = 0, len = 0
    for (;;) {
      const b = buf[pos + len]
      if (b === undefined) throw new Error('truncated varint')
      value |= (b & 0x7f) << shift
      len++
      if (!(b & 0x80)) break
      shift += 7
      if (shift > 35) throw new Error('varint too long')
    }
    return { value, len }
  }

  /* ---- custom_click_action (serverbound) ----
     สเปกจริง (vanilla 1.21.6+ / 26.x): Identifier + VarInt(ความยาว payload เป็นไบต์) + NBT แบบไม่มีชื่อ root
     ตัวอย่างไบต์: <id string> <varint len> 0x0A <entries...> 0x00
     ปัญหาเดิม: protocol definition ของ fork เขียน "0x01 + NBT" (option) โดยไม่มี length prefix
     → เซิร์ฟเวอร์อ่าน 0x01 เป็นความยาว payload = 1 ไบต์ แล้วอ่าน compound ไม่จบ
     → "Failed to decode packet 'serverbound/minecraft:custom_click_action'" (ตรงกับ log ทุกรอบ)
     และ log "payload layout already OK (marker byte 0x01)" ก็คือสัญญาณว่า fork เขียน layout ผิดนี้
     ทางแก้: ไม่พึ่ง serializer ของ fork ในส่วน payload — ดึงเฉพาะ packet-id + identifier จาก serializer
     (ได้ id ของ state ปัจจุบันถูกเสมอ) แล้วต่อ payload เองตาม layout ที่เลือก
     layout 0 = สเปก (length-prefixed NBT)  <- ค่าเริ่มต้น
     layout 1 = 0x01 + NBT (แบบเดิม)  layout 2 = NBT เปล่า
     ถ้าโดน kick ด้วย custom_click_action จะหมุนไป layout ถัดไปในการ reconnect รอบหน้า */

  const CLICK_LAYOUTS = ['length-prefixed NBT (spec)', '0x01 + NBT (legacy)', 'bare NBT']

  function writeVarInt(n) {
    const out = []
    n >>>= 0
    while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7 }
    out.push(n)
    return Buffer.from(out)
  }

  // NBT ใช้ "modified UTF-8" (NUL = C0 80, ตัวอักษรนอก BMP = surrogate คู่ละ 3 ไบต์)
  function mutf8(str) {
    const bytes = []
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i)
      if (ch >= 0x01 && ch <= 0x7f) bytes.push(ch)
      else if (ch === 0 || ch <= 0x7ff) bytes.push(0xc0 | (ch >> 6), 0x80 | (ch & 0x3f))
      else bytes.push(0xe0 | (ch >> 12), 0x80 | ((ch >> 6) & 0x3f), 0x80 | (ch & 0x3f))
    }
    return Buffer.from(bytes)
  }

  function nbtString(s) {
    const b = mutf8(String(s))
    if (b.length > 0xffff) throw new Error('NBT string too long')
    const len = Buffer.alloc(2)
    len.writeUInt16BE(b.length)
    return Buffer.concat([len, b])
  }

  const TAG_ID = { byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6, byteArray: 7, string: 8, list: 9, compound: 10, intArray: 11, longArray: 12 }

  function i64(v) {
    const b = Buffer.alloc(8)
    if (Array.isArray(v)) { b.writeInt32BE(v[0] | 0, 0); b.writeInt32BE(v[1] | 0, 4) } else b.writeBigInt64BE(BigInt(v))
    return b
  }

  // plain value (+ชนิดเดิมถ้ารู้) -> {type, value} สำหรับ encoder
  function plainToField(v, tag) {
    if (!tag && Array.isArray(v) && v.__nbt) tag = v.__nbt
    if (!tag) {
      if (typeof v === 'string') tag = 'string'
      else if (typeof v === 'boolean') { tag = 'byte'; v = v ? 1 : 0 }
      else if (typeof v === 'number') tag = Number.isInteger(v) ? 'int' : 'double'
      else if (Array.isArray(v)) tag = 'intArray'
      else if (v && typeof v === 'object') tag = 'compound'
      else tag = 'string'
    }
    if (tag === 'compound') {
      const out = {}
      const types = (v && v.__types) || {}
      for (const k of Object.keys(v || {})) out[k] = plainToField(v[k], types[k])
      return { type: 'compound', value: out }
    }
    if (tag === 'list') throw new Error('list tag inside additions is not supported')
    return { type: tag, value: v }
  }

  function additionsToFields(add) {
    const fields = {}
    if (add && typeof add === 'object') {
      const types = add.__types || {}
      for (const k of Object.keys(add)) fields[k] = plainToField(add[k], types[k])
    }
    return fields
  }

  function encodeTagPayload(f) {
    switch (f.type) {
      case 'string': return nbtString(f.value)
      case 'byte': return Buffer.from([Number(f.value) & 0xff])
      case 'short': { const b = Buffer.alloc(2); b.writeInt16BE(Number(f.value) | 0); return b }
      case 'int': { const b = Buffer.alloc(4); b.writeInt32BE(Number(f.value) | 0); return b }
      case 'long': return i64(f.value)
      case 'float': { const b = Buffer.alloc(4); b.writeFloatBE(Number(f.value)); return b }
      case 'double': { const b = Buffer.alloc(8); b.writeDoubleBE(Number(f.value)); return b }
      case 'byteArray': { const a = f.value || []; const b = Buffer.alloc(4 + a.length); b.writeInt32BE(a.length, 0); a.forEach((x, i) => b.writeInt8(x, 4 + i)); return b }
      case 'intArray': { const a = f.value || []; const b = Buffer.alloc(4 + a.length * 4); b.writeInt32BE(a.length, 0); a.forEach((x, i) => b.writeInt32BE(x | 0, 4 + i * 4)); return b }
      case 'longArray': { const a = f.value || []; const h = Buffer.alloc(4); h.writeInt32BE(a.length, 0); return Buffer.concat([h, ...a.map(i64)]) }
      case 'compound': return encodeCompoundBody(f.value)
      default: throw new Error(`unsupported NBT type "${f.type}"`)
    }
  }

  function encodeCompoundBody(fields) {
    const parts = []
    for (const key of Object.keys(fields)) {
      const f = fields[key]
      const id = TAG_ID[f.type]
      if (!id) throw new Error(`unsupported NBT type "${f.type}" for key "${key}"`)
      parts.push(Buffer.from([id]), nbtString(key), encodeTagPayload(f))
    }
    parts.push(Buffer.from([0x00]))
    return Buffer.concat(parts)
  }

  // fields = { key: {type, value} } -> compound แบบ network NBT (ไม่มีชื่อ root)
  function encodeNbtCompound(fields) {
    return Buffer.concat([Buffer.from([0x0a]), encodeCompoundBody(fields)])
  }

  function buildClickPayload(nbt, layout) {
    if (layout === 1) return Buffer.concat([Buffer.from([0x01]), nbt])
    if (layout === 2) return nbt
    return Buffer.concat([writeVarInt(nbt.length), nbt])
  }

  function sendCustomClickAction(c, id, fields) {
    const packet = { name: 'custom_click_action', params: { id, nbt: { type: 'compound', name: '', value: {} } } }
    const canRaw = c.serializer && typeof c.serializer.createPacketBuffer === 'function' && typeof c.writeRaw === 'function'
    if (!canRaw) {
      c.write(packet.name, { id, nbt: { type: 'compound', name: '', value: fields } })
      pushLog(state, '[DIALOG] raw write unavailable — sent with the library serializer')
      return
    }
    let head
    try {
      const buf = c.serializer.createPacketBuffer(packet)
      const pid = readVarInt(buf, 0)
      const idLen = readVarInt(buf, pid.len)
      head = buf.subarray(0, pid.len + idLen.len + idLen.value) // packet id + identifier
    } catch (e) {
      pushLog(state, `[DIALOG] serialize failed (${e.message}) — falling back to library write`)
      c.write(packet.name, packet.params)
      return
    }
    const layout = dialogVariant % CLICK_LAYOUTS.length
    const payload = buildClickPayload(encodeNbtCompound(fields), layout)
    const outBuf = Buffer.concat([head, payload])
    c.writeRaw(outBuf)
    pushLog(state, `[DIALOG] payload layout #${layout}: ${CLICK_LAYOUTS[layout]}`)
    if (clickHexLogged < 3) { clickHexLogged++; pushLog(state, `[DIALOG] click bytes (${outBuf.length}B): ${outBuf.subarray(0, 96).toString('hex')}`) }
  }

  /* ---- PIN pad (dialog ที่เป็นปุ่มเลข 0-9 ไม่มีช่องพิมพ์) ---- */

  function collectButtons(dlg) {
    const out = []
    const add = (b, role) => { if (b && b.action && b.action.type) out.push({ role, label: textOf(b.label).replace(/§./g, '').trim(), action: b.action }) }
    add(dlg.yes, 'yes'); add(dlg.no, 'no'); add(dlg.action, 'action'); add(dlg.exit_action, 'exit')
    if (Array.isArray(dlg.actions)) dlg.actions.forEach(b => add(b, 'actions'))
    return out
  }

  function findPinPad(dlg) {
    const buttons = collectButtons(dlg)
    const byDigit = {}
    for (const b of buttons) if (/^[0-9]$/.test(b.label) && !byDigit[b.label]) byDigit[b.label] = b
    const ok = Object.keys(byDigit).length >= 9
    if (!ok) return null
    const clr = buttons.find(b => /ล้าง|clear|reset/i.test(b.label))
    if (clr) Object.defineProperty(byDigit, '__clear', { value: clr, enumerable: false })
    return byDigit
  }

  // อ่าน "จุด" แสดงจำนวนหลักที่กรอกแล้ว (เช่น ○ ○ ○ ○ -> ● ○ ○ ○). คืน null ถ้าอ่านไม่ได้
  function dotsText(plain) {
    try {
      const txt = collectTexts(plain, []).join('')
      const g = txt.match(/[\p{So}•◦·∘]/gu)
      return g ? g.join('') : ''
    } catch { return '' }
  }
  function parseDots(plain) {
    try {
      const txt = collectTexts(plain, []).join('')
      const g = txt.match(/[\p{So}•◦·∘]/gu)
      if (!g || g.length < 4 || g.length > 8) return null
      const distinct = new Set(g)
      if (distinct.size > 2) return null
      if (distinct.size === 1) return { total: g.length, filled: g[0] === pinDotEmpty ? 0 : g.length, text: g.join('') }
      if (!distinct.has(pinDotEmpty)) return null
      return { total: g.length, filled: g.filter(x => x !== pinDotEmpty).length, text: g.join('') }
    } catch { return null }
  }

  function pressButton(c, btn, values) {
    const act = btn.action
    const type = String(act.type || '').replace('minecraft:', '')
    if (type === 'dynamic/custom' || type === 'custom') {
      const fields = additionsToFields(act.additions)
      sendCustomClickAction(c, String(act.id), fields)
      return `custom_click_action id=${act.id}`
    }
    if (type === 'dynamic/run_command' || type === 'run_command') {
      let cmd = String(act.template || act.command || '').replace(/^\//, '')
      if (!bot) throw new Error('no bot')
      bot.chat('/' + cmd)
      return `command /${cmd.split(' ')[0]}`
    }
    throw new Error(`unsupported action ${type}`)
  }

  function collectTexts(node, out) {
    if (node === null || node === undefined) return out
    if (typeof node === 'string') return out
    if (Array.isArray(node)) { node.forEach(n => collectTexts(n, out)); return out }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (k === 'actions' || k === 'exit_action' || k === 'action' || k === 'yes' || k === 'no' || k === 'label' || k === 'tooltip') continue // ข้ามปุ่ม อ่านเฉพาะข้อความหัว/เนื้อหา
        if (k === 'text' && typeof node[k] === 'string') out.push(node[k])
        else collectTexts(node[k], out)
      }
    }
    return out
  }

  // อ่าน "เหลือโอกาสอีก N ครั้ง" จากข้อความใน dialog (null = อ่านไม่เจอ)
  function remainingAttempts(plain) {
    try {
      const txt = collectTexts(plain, []).join('')
      const m = txt.match(/เหลือโอกาสอีก\s*(\d+)/)
      return m ? Number(m[1]) : null
    } catch { return null }
  }

  // รอ dialog ใหม่ (Paper ส่งปุ่มชุดใหม่ id ใหม่มาทุกครั้ง — id เก่าใช้ซ้ำไม่ได้) สูงสุด ms
  function waitFresh(run, seqBefore, ms) {
    return new Promise(res => {
      if (run.seq > seqBefore || !run.active) return res(run.seq > seqBefore)
      const t = setTimeout(() => { run.wake = null; res(false) }, ms)
      run.wake = () => { clearTimeout(t); run.wake = null; res(true) }
    })
  }

  function finishEntry(run) {
    if (pinRun !== run || !run.settling) return
    run.settling = false
    const before = run.leftBefore
    const after = run.minLeft
    const counted = (before !== null && after !== null) ? (after < before) : null
    if (counted === true) {
      pinSubmits++
      if (run.verified) {
        pinWrong = true
        pushLog(state, `[PIN] ❌ เซิร์ฟเวอร์นับว่า PIN ผิด (เหลือ ${after} ครั้ง) ทั้งที่บอทกดครบทุกหลักและเซิร์ฟเวอร์ยืนยันทีละหลักแล้ว → PIN ที่บันทึกไว้ไม่ตรงกับของจริง หยุดไม่กดซ้ำ (แก้ PIN ใน Settings แล้วกด Save)`)
        return
      }
      pushLog(state, `[PIN] เซิร์ฟเวอร์นับว่าผิด (เหลือ ${after} ครั้ง) — ยังยืนยันการกดทีละหลักไม่ได้ จึงอาจกดผิดหลัก (รอบที่ ${pinSubmits}/2)`)
    } else if (counted === false) {
      pinSoftFails++
      pushLog(state, `[PIN] เซิร์ฟเวอร์ไม่นับรอบนี้ (ยังเหลือ ${after} ครั้ง) → คลิกไม่ครบ/ถูกรีเซ็ต ไม่เสียโอกาส (${pinSoftFails}/4) จะลองใหม่`)
    } else {
      pinSubmits++
      pushLog(state, `[PIN] อ่านจำนวนครั้งที่เหลือไม่ได้ — นับเป็น 1 รอบ (${pinSubmits}/2) เพื่อความปลอดภัย`)
    }
    const p = pinLastDialog
    if (p && bot) setTimeout(() => { try { if (bot) runPin(p.c, p.pad, p.stateName, p.plain) } catch {} }, 400)
  }

  function runPin(c, pad, stateName, plain, skipWait) {
    if (Date.now() < pinManualUntil) return // ผู้ใช้กดเองอยู่ (หรือกดพักบอท) — ไม่กดอัตโนมัติ
    if (!state.autoPin) {
      // โหมด "ใส่เอง": บอทไม่กดให้ — แป้นแสดงที่แท็บ Server UI ให้กดเอง
      if (!pinManualLogged) {
        pinManualLogged = true
        pushLog(state, '[PIN] โหมดใส่ PIN เอง — เซิร์ฟเวอร์ขอ PIN แล้ว กดเองที่แท็บ Server UI (บอทจะไม่กดให้ · อยากให้กดอัตโนมัติเปลี่ยนที่ Settings > PIN)')
        whNotifyCustom(state, '🔢 ' + whLabel(state) + ' รอใส่ PIN', 'เซิร์ฟเวอร์ขอ PIN แล้ว — บอทอยู่โหมด **ใส่เอง** เข้าไปกดที่แท็บ Server UI ของบอทตัวนี้', WH_COLORS.warn, false)
      }
      return
    }
    const pin = String(state.loginPin || '')
    if (!/^[0-9]{4,8}$/.test(pin)) {
      pushLog(state, '[PIN] เซิร์ฟเวอร์ขอ PIN แต่ยังไม่ได้ตั้ง PIN (ต้องเป็นตัวเลข 4-8 หลัก) — ใส่ที่ Settings > Auto PIN แล้วกด Save')
      return
    }
    const left = remainingAttempts(plain)
    const dots = parseDots(plain)
    pinLastDialog = { c, pad, stateName, plain, left, dots, at: Date.now() }

    // กำลังกดอยู่: ส่งปุ่มชุดใหม่ + จุดล่าสุดให้ลูปที่กำลังรอ
    if (pinRun && pinRun.active) {
      pinRun.pad = pad; pinRun.left = left; pinRun.dots = dots; pinRun.seq++
      if (pinRun.wake) pinRun.wake()
      return
    }
    // กดครบแล้ว กำลังรอผล: เก็บ "เหลือกี่ครั้ง" ที่ต่ำสุดที่เห็น
    if (pinRun && pinRun.settling) {
      if (left !== null) pinRun.minLeft = pinRun.minLeft === null ? left : Math.min(pinRun.minLeft, left)
      return
    }
    // กำลังรอให้แป้นพร้อมก่อนกด: dialog ล่าสุดถูกเก็บใน pinLastDialog แล้ว — ตอนครบเวลาจะใช้ชุดล่าสุดนั้น
    if (pinWaitTimer && !skipWait) return

    if (pinWrong) {
      pushLog(state, '[PIN] PIN ที่บันทึกไว้ถูกเซิร์ฟเวอร์ปฏิเสธแล้ว — ไม่กดซ้ำ (แก้ PIN ใน Settings แล้วกด Save)')
      return
    }
    if (left !== null && !skipWait) pushLog(state, `[PIN] เซิร์ฟเวอร์แจ้งว่าเหลือโอกาสอีก ${left} ครั้ง`)
    if (left !== null && left <= 2) {
      pushLog(state, `[PIN] เหลือโอกาสแค่ ${left} ครั้ง — บอทกดอัตโนมัติเฉพาะตอนเหลือ 3 ครั้งขึ้นไป เพื่อไม่ให้ถูกล็อก (ตรวจ PIN ให้แน่ใจแล้วกรอกเอง หรือ Save PIN ใหม่)`)
      return
    }
    if (pinSubmits >= 2) {
      pushLog(state, '[PIN] กรอก PIN ไปแล้ว 2 ครั้งแต่ยังไม่ผ่าน — หยุดเพื่อไม่ให้ถูกล็อก (เช็ค PIN แล้วกด Save ใหม่)')
      return
    }
    if (pinSoftFails >= 4) {
      pushLog(state, '[PIN] คลิกไม่ถูกรับ 4 รอบติด (เซิร์ฟเวอร์ไม่นับเลย) — หยุดแล้ว ส่ง log บรรทัด [PIN] จุด / [DIALOG] click bytes มาให้ดูต่อ')
      return
    }

    // โหมดอัตโนมัติ: เห็นแป้นแล้วรอให้หน้าจอพร้อม (pinDelay ms) ค่อยเริ่มกด — กันกดเร็วเกินจนเซิร์ฟเวอร์ยังไม่รับ
    if (!skipWait && state.pinDelay > 0) {
      const seenAt = Date.now()
      pushLog(state, `[PIN] เห็นแป้น PIN แล้ว — รอ ${(state.pinDelay / 1000).toFixed(1)} วิให้หน้าจอพร้อมก่อนเริ่มกด`)
      pinWaitTimer = setTimeout(() => {
        pinWaitTimer = null
        try {
          if (!bot || !state.autoPin || Date.now() < pinManualUntil) return
          if (pinClearedAt >= seenAt) { pushLog(state, '[PIN] แป้น PIN หายไปก่อนถึงเวลากด (เซิร์ฟเวอร์ปิดหน้าแล้ว) — ไม่กด'); return }
          const p = pinLastDialog
          if (p) runPin(p.c, p.pad, p.stateName, p.plain, true)
        } catch (e) { pushLog(state, `[PIN] error: ${e.message}`) }
      }, state.pinDelay)
      return
    }

    const run = {
      active: true, settling: false, pad, pin, wake: null, seq: 0,
      left, dots, leftBefore: left, minLeft: left, verified: true, startedAt: Date.now()
    }
    pinRun = run
    pushLog(state, `[PIN] เริ่มกด PIN ${pin.length} หลัก (state=${stateName}) จุดตอนนี้="${dots ? dots.text : dotsText(plain) || '?'}"`)
    if (!dots) pushLog(state, '[PIN] อ่านจุดแสดงหลักจาก dialog ไม่ได้ → ใช้โหมดกดแบบรอ dialog ใหม่ทุกหลัก (ไม่ยืนยันรายหลัก)')

    ;(async () => {
      // ถ้ามีเลขค้างอยู่ในช่องจากรอบก่อน ให้กด "ล้าง" ก่อน
      if (run.dots && run.dots.filled > 0 && run.pad.__clear) {
        const sb = run.seq
        try { pressButton(c, run.pad.__clear); pushLog(state, `[PIN] มีเลขค้าง ${run.dots.filled} หลัก — กด "ล้าง" ก่อน`) } catch (e) { pushLog(state, `[PIN] กดล้างไม่สำเร็จ: ${e.message}`) }
        await waitFresh(run, sb, 3000)
        await sleep(150)
      }
      let idx = 0
      let retries = 0
      while (run.active && bot && idx < pin.length) {
        const d = pin[idx]
        const btn = run.pad[d]
        if (!btn) { pushLog(state, `[PIN] ไม่พบปุ่มเลข ${d}`); run.active = false; return }
        const isLast = idx === pin.length - 1
        const seqBefore = run.seq
        const filledBefore = run.dots ? run.dots.filled : null
        try {
          const what = pressButton(c, btn)
          pushLog(state, `[PIN] กดหลักที่ ${idx + 1}/${pin.length} (${what})`)
        } catch (e) {
          pushLog(state, `[PIN] กดไม่สำเร็จ: ${e.message}`)
          run.active = false
          return
        }
        // รอ dialog ใหม่ก่อนกดหลักถัดไปเสมอ (ปุ่ม id เก่าอาจใช้ไม่ได้แล้ว)
        let got = await waitFresh(run, seqBefore, 3000)
        await sleep(150)
        if (!run.active) return // clear_dialog (ผ่าน) หรือถูกหยุด
        let filledAfter = run.dots ? run.dots.filled : null
        if (filledBefore !== null || filledAfter !== null) {
          pushLog(state, `[PIN] จุด ${filledBefore === null ? '?' : filledBefore} → ${filledAfter === null ? '?' : filledAfter} "${run.dots ? run.dots.text : ''}"${got ? '' : ' (ไม่มี dialog ตอบกลับใน 3 วิ)'}`)
        }
        if (isLast) {
          // หลักสุดท้าย: จุดอาจถูกรีเซ็ตเพราะเซิร์ฟเวอร์ตรวจแล้ว — ถ้าจุดยังค้างที่ n-1 แปลว่าคลิกไม่เข้า ลองใหม่ได้โดยไม่เสียโอกาส
          if (pinDotsProven && filledAfter === pin.length - 1 && retries < 3) {
            retries++
            pushLog(state, `[PIN] หลักสุดท้ายยังไม่เข้า (จุดค้าง ${filledAfter}) — กดซ้ำ (${retries}/3)`)
            continue
          }
          break
        }
        if (pinDotsProven && filledBefore !== null && filledAfter !== null) {
          if (filledAfter === filledBefore + 1) { idx++; retries = 0; continue }
          if (filledAfter === filledBefore) {
            // อาจเป็น dialog รีเฟรชที่มาก่อนคำตอบของคลิก — รออีกหนึ่งชุดก่อนตัดสินว่าคลิกไม่เข้า
            const sb2 = run.seq
            await waitFresh(run, sb2, 2500)
            await sleep(100)
            if (!run.active) return
            filledAfter = run.dots ? run.dots.filled : null
            if (filledAfter === filledBefore + 1) { idx++; retries = 0; continue }
            if (filledAfter === filledBefore && retries < 3) {
              retries++
              run.verified = false
              pushLog(state, `[PIN] คลิกหลักที่ ${idx + 1} ไม่เข้า (จุดไม่เพิ่ม) — กดซ้ำด้วยปุ่มชุดล่าสุด (${retries}/3)`)
              continue
            }
            if (filledAfter === filledBefore) { pushLog(state, '[PIN] คลิกไม่เข้า 3 ครั้งติด — หยุดรอบนี้ (ยังไม่ได้ส่งครบ 4 หลัก จึงไม่เสียโอกาส)'); run.active = false; pinSoftFails++; return }
          }
          if (filledAfter === 0 && filledBefore > 0) {
            pushLog(state, '[PIN] เซิร์ฟเวอร์รีเซ็ตช่อง PIN (น่าจะรีเฟรชหน้า) — เริ่มกดหลักแรกใหม่')
            run.verified = false
            idx = 0; retries = 0
            continue
          }
          if (filledAfter !== null && filledAfter >= 0 && filledAfter < pin.length) {
            pushLog(state, `[PIN] จุดไม่ตรงที่คาด (${filledAfter}) — ปรับตำแหน่งตามเซิร์ฟเวอร์`)
            run.verified = false
            idx = filledAfter; continue
          }
        }
        // ยังไม่เคยพิสูจน์ว่าจุดขยับตามการกด: เรียนรู้จากหลักแรก
        if (!pinDotsProven && filledBefore !== null && filledAfter !== null) {
          if (filledAfter === filledBefore + 1) { pinDotsProven = true; pushLog(state, '[PIN] ยืนยันแล้วว่าจุดขยับตามการกด — จะตรวจทีละหลักตั้งแต่นี้') }
          else run.verified = false
        } else if (!pinDotsProven) {
          run.verified = false
        }
        idx++
      }
      if (run.active && idx >= pin.length) {
        run.active = false
        run.settling = true
        run.minLeft = run.left
        pushLog(state, `[PIN] กดครบ ${pin.length} หลักแล้ว — รอผลจากเซิร์ฟเวอร์`)
        setTimeout(() => finishEntry(run), 2200)
      }
    })().catch(e => { run.active = false; pushLog(state, `[PIN] error: ${e.message}`) })
  }

  function handleDialog(c, data, stateName) {
    dialogSeenPreSpawn = true
    const plain = nbtToPlain(data && data.dialog !== undefined ? data.dialog : data)
    let dump = ''
    try { dump = JSON.stringify(plain) } catch { dump = String(plain) }
    pushLog(state, `[DIALOG] (${stateName}) ${dump.length > 700 ? dump.slice(0, 700) + '…' : dump}`)

    const dlg = findDialogRoot(plain)
    if (!dlg) {
      pushLog(state, '[DIALOG] Could not find inputs/buttons in this dialog (it may be a registry reference). Copy the [DIALOG] line above so the code can be adapted.')
      return
    }
    try { uiDialog = buildUiDialog(c, stateName, dlg, plain) } catch (e) { pushLog(state, `[UI] อ่าน dialog ไม่ได้: ${e.message}`) }
    const pad = findPinPad(dlg)
    if (pad) { pinSeenAt = Date.now(); runPin(c, pad, stateName, plain); return }
    if (!state.autoLogin || !state.loginPassword) {
      pushLog(state, '[DIALOG] Server opened a dialog but Server Login is off / no password saved (Settings tab).')
      return
    }
    if (dialogAttempts >= 3) {
      pushLog(state, '[DIALOG] Already tried 3 times on this connection — not trying again (wrong password?).')
      return
    }
    if (collectButtons(dlg).length > 1 && !(Array.isArray(dlg.inputs) && dlg.inputs.length) && !dlg.yes) {
      pushLog(state, '[DIALOG] dialog นี้มีหลายปุ่มแต่ไม่ใช่ช่องรหัสหรือปุ่ม PIN 0-9 — ไม่กดมั่ว (ส่งบรรทัด [DIALOG] ด้านบนมาให้ปรับโค้ด)')
      return
    }
    dialogAttempts++

    // fill inputs: text boxes get the password, others keep their default
    const values = {}
    for (const inp of (Array.isArray(dlg.inputs) ? dlg.inputs : [])) {
      if (!inp || !inp.key) continue
      const t = String(inp.type || '').replace('minecraft:', '')
      if (t === 'text') values[inp.key] = state.loginPassword
      else if (inp.initial !== undefined) values[inp.key] = inp.initial
    }

    const btn = pickButton(dlg)
    if (!btn) { pushLog(state, '[DIALOG] No clickable button found in this dialog.'); return }
    const act = btn.action
    const type = String(act.type || '').replace('minecraft:', '')
    const label = textOf(btn.label)
    pushLog(state, `[DIALOG] Pressing button "${label}" (action: ${type})`)

    try {
      if (type === 'dynamic/run_command' || type === 'run_command') {
        let cmd = String(act.template || act.command || '')
        cmd = cmd.replace(/\$\(([^)]+)\)/g, (_, k) => (values[k] !== undefined ? String(values[k]) : ''))
        cmd = cmd.replace(/^\//, '')
        if (stateName !== 'play') { pushLog(state, '[DIALOG] run_command action cannot be sent before joining the world.'); return }
        bot.chat('/' + cmd)
        pushLog(state, `[DIALOG] Sent command: /${cmd.split(' ')[0]} ****`)
      } else if (type === 'dynamic/custom' || type === 'custom') {
        // vanilla: payload = additions (ชนิดเดิม) + one entry per input key
        const fields = additionsToFields(act.additions)
        for (const k of Object.keys(values)) {
          const v = values[k]
          fields[k] = typeof v === 'boolean' ? { type: 'byte', value: v ? 1 : 0 }
            : typeof v === 'number' ? { type: 'float', value: v } : { type: 'string', value: String(v) }
        }
        sendCustomClickAction(c, String(act.id), fields)
        pushLog(state, `[DIALOG] Sent custom_click_action id=${act.id}`)
      } else {
        pushLog(state, `[DIALOG] Unsupported button action "${type}" — send the [DIALOG] line so support can be added.`)
      }
    } catch (e) {
      pushLog(state, `[DIALOG] Failed to answer dialog: ${e.message}`)
    }
  }

  /* ---- กัน handler ของ mineflayer พังแล้วลาก stream แพ็กเก็ตตายทั้งก้อน ----
     เคสจริง: เซิร์ฟเวอร์ส่งแพ็กเก็ต teams (scoreboard team "CMINP0" ...) มาตอนเข้าโลก
     mineflayer/team.js เรียก ChatMessage.fromNotch(undefined) -> TypeError ใน listener
     exception หลุดขึ้นไปที่ parser ของ minecraft-protocol (log "problem inflating chunk")
     แพ็กเก็ตที่ตามมา (position/health/show_dialog) ไม่ถูกประมวลผลอีกเลย -> ไม่ spawn -> timeout 30s
     ทางแก้: ครอบ emit ของ client ด้วย try/catch แล้วข้ามเฉพาะ handler ที่พัง */
  /* ---- DROP: ข้ามการ "แกะ" แพ็กเก็ตที่บอทไม่ใช้ (อนุภาค/เสียง/แอนิเมชัน/การขยับของ entity อื่น) ----
     ในฟาร์มที่มี entity เยอะ แพ็กเก็ตพวกนี้มาเป็นพัน ๆ ต่อวินาที และกิน CPU เกือบหมด (โฮสต์ฟรีจึงค้างจนโดน disconnect.timeout)
     BOT_DROP=0 = ปิดทั้งหมด · BOT_DROP_MOVES=0 = ไม่ข้ามการขยับของ entity อื่น (ถ้าเปิด auto-attack หรือขี่พาหนะอยู่ จะไม่ข้ามส่วนนี้เองอัตโนมัติ)
     ถ้าอ่านตารางแพ็กเก็ตไม่ได้/โครงสร้างไม่ตรง จะไม่ทำอะไรเลย (ทำงานเหมือนเดิม) */
  function installPacketDrop(b) {
    if (process.env.BOT_DROP === '0') return
    const c = b && b._client
    if (!c || c.__dropHook) return
    c.__dropHook = true
    const dropMoves = process.env.BOT_DROP_MOVES !== '0'
    const COSMETIC = new Set(['world_particles', 'level_particles', 'particle', 'named_sound_effect', 'sound_effect', 'entity_sound_effect',
      'block_action', 'block_break_animation', 'world_event', 'level_event', 'animation', 'hurt_animation',
      'update_light', 'collect'])
    const MOVES = new Set(['rel_entity_move', 'entity_move_look', 'entity_look', 'entity_head_rotation',
      'move_entity_pos', 'move_entity_pos_rot', 'move_entity_rot', 'move_entity_pos_and_rotation'])
    let ids = null
    const buildIds = () => {
      const pr = b.registry && b.registry.protocol
      const types = pr && pr.play && pr.play.toClient && pr.play.toClient.types
      const fields = types && types.packet && types.packet[1]
      const nameField = Array.isArray(fields) ? fields.find(f => f && f.name === 'name') : null
      const mappings = nameField && nameField.type && nameField.type[1] && nameField.type[1].mappings
      if (!mappings) return null
      const a = new Set(), m = new Set()
      for (const k of Object.keys(mappings)) {
        const id = Number(k)
        if (!Number.isInteger(id)) continue
        const n = mappings[k]
        if (COSMETIC.has(n)) a.add(id)
        else if (MOVES.has(n)) m.add(id)
      }
      return { a, m }
    }
    const hook = () => {
      try {
        if (c.state !== 'play') return
        const d = c.deserializer
        if (!d || d.__dropHook || (typeof d._transform !== 'function' && typeof d.parsePacketBuffer !== 'function')) return
        if (!ids) {
          ids = buildIds()
          if (!ids) { pushLog(state, '[DROP] ไม่เปิดใช้ (อ่านตารางแพ็กเก็ตของเวอร์ชันนี้ไม่ได้) — ทำงานปกติ'); return }
          pushLog(state, `[DROP] เปิดใช้: ข้ามแพ็กเก็ตที่ไม่ใช้ ${ids.a.size} ชนิด + การขยับของ entity อื่น ${dropMoves ? ids.m.size : 0} ชนิด (BOT_DROP=0 เพื่อปิด)`)
        }
        d.__dropHook = true
        const shouldDrop = (buffer) => {
          if (!buffer || !buffer.length) return false
          let id = 0, shift = 0
          for (let i = 0; i < 5 && i < buffer.length; i++) { const x = buffer[i]; id |= (x & 0x7f) << shift; if (!(x & 0x80)) break; shift += 7 }
          return ids.a.has(id) || (dropMoves && ids.m.has(id) && !state.autoAttack && !b.vehicle)
        }
        if (typeof d._transform === 'function') {
          // ข้ามตั้งแต่ก่อนแกะ และไม่ push/emit ต่อ (ประหยัดกว่าคืน object หลอก)
          const origT = d._transform
          d._transform = function (chunk, enc, cb) {
            let drop = false
            try { drop = shouldDrop(chunk) } catch {}
            if (drop) { state._dropped = (state._dropped || 0) + 1; return cb() }
            return origT.call(this, chunk, enc, cb)
          }
        } else {
          const orig = d.parsePacketBuffer
          d.parsePacketBuffer = function (buffer) {
            try {
              if (shouldDrop(buffer)) {
                state._dropped = (state._dropped || 0) + 1
                return { data: { name: '__dropped', params: {} }, metadata: { size: buffer.length }, buffer, fullBuffer: buffer }
              }
            } catch {}
            return orig.call(this, buffer)
          }
        }
      } catch (e) { pushLog(state, `[DROP] ไม่เปิดใช้: ${e && e.message}`) }
    }
    c.on('state', (ns) => { if (ns === 'play') hook() })
    hook()
  }

  /* ---- กัน parser ตายเมื่อเจอแพ็กเก็ตที่อ่านไม่ออก (สาเหตุของ disconnect.timeout) ----
     protodef (FullPacketParser) เจอแพ็กเก็ตที่ schema ไม่ตรงจะส่ง error ผ่าน callback ของ Transform stream
     Node จะ destroy stream ทิ้ง -> บอทไม่ได้รับแพ็กเก็ตอีกเลย (รวมถึง keep_alive) -> เซิร์ฟเวอร์ตัด "disconnect.timeout" ใน ~15-30 วิ
     แพ็กเก็ตถูกแบ่งเฟรมมาก่อนแล้ว จึงข้ามเฉพาะตัวที่พังได้อย่างปลอดภัย: ส่ง error ให้ client รายงานตามปกติ แต่ไม่ให้ stream ตาย
     deserializer ถูกสร้างใหม่ทุกครั้งที่เปลี่ยน state (handshake/login/configuration/play) จึงต้องครอบใหม่ทุกครั้ง */
  function installParserGuard(b) {
    const c = b && b._client
    if (!c || c.__parserGuard) return
    c.__parserGuard = true
    const hook = () => {
      try {
        const d = c.deserializer
        if (!d || d.__survive || typeof d._transform !== 'function') return
        d.__survive = true
        const origT = d._transform
        d._transform = function (chunk, enc, cb) {
          let called = false
          const wrapped = function (err) {
            if (called) return
            called = true
            if (err) {
              try { d.emit('error', err) } catch {}   // ให้ client/mineflayer รายงาน error ตามเดิม (ไปที่ bot.on('error') แบบไม่ตัดการเชื่อมต่อ)
              return cb()                               // แต่ไม่ส่ง err ต่อให้ stream -> ไม่ถูก destroy
            }
            return cb.apply(null, arguments)
          }
          try {
            return origT.call(this, chunk, enc, wrapped)
          } catch (e) {
            // parser โยน exception ตรง ๆ (ไม่ผ่าน callback) ก็ข้ามแพ็กเก็ตนี้เช่นกัน
            try { d.emit('error', e) } catch {}
            if (!called) { called = true; return cb() }
          }
        }
      } catch {}
    }
    c.on('state', hook)
    hook()
  }

  /* ---- รับประกันว่า keep_alive ถูกตอบ ----
     ถ้าบอทไม่ตอบ keep_alive เซิร์ฟเวอร์จะตัด disconnect.timeout — ปกติ minecraft-protocol ตอบเอง แต่ถ้า handler พัง/ถูกข้ามด้วย guardPacketHandlers
     จะเงียบ ๆ ไม่ตอบ จึงเช็คซ้ำหลัง 250ms แล้วตอบแทน (ถ้า mineflayer ตอบแล้วจะไม่ส่งซ้ำ) ใช้ได้ทั้ง configuration และ play */
  function ensureKeepAlive(c, data, meta) {
    if (!data || data.keepAliveId === undefined) return
    const id = String(data.keepAliveId)
    const st = meta && meta.state
    setTimeout(() => {
      try {
        if (!bot || bot._client !== c || c.state !== st || kaSent.has(id)) return
        c.write('keep_alive', { keepAliveId: data.keepAliveId })
        kaForced++
        if (kaForced <= 3) pushLog(state, `[CTRL] 🔧 ไม่มีใครตอบ keep_alive #${id} (${st}) — ตอบแทน กัน disconnect.timeout (ครั้งที่ ${kaForced})`)
      } catch (e) {
        if (kaForced++ <= 3) pushLog(state, `[CTRL] ตอบ keep_alive แทนไม่สำเร็จ: ${e && e.message}`)
      }
    }, 250)
  }

  function guardPacketHandlers(b) {
    const c = b && b._client
    if (!c || c.__guarded) return
    c.__guarded = true
    const origEmit = c.emit
    const warned = new Set()
    c.emit = function (ev) {
      try {
        return origEmit.apply(this, arguments)
      } catch (e) {
        const k = String(ev)
        if (!warned.has(k) && warned.size < 25) {
          warned.add(k)
          pushLog(state, `[TRACE] ข้าม error ใน handler ของ "${k}": ${e && e.message}`)
        }
        return false
      }
    }
  }

  /* ---- ดูว่าบอท "ส่งอะไรออกไป" ตอนเซิร์ฟสั่งกลับเข้า configuration (หน้า PIN ใช้ช่วงนี้) ----
     log: [TRACE] -> <state>/<packet> และไบต์แรกของแพ็กเก็ตที่ส่งนอก play state
     + หยุดฟิสิกส์ของ mineflayer ระหว่างอยู่ใน configuration และไม่ปล่อยแพ็กเก็ตของ play (ขยับ/แชท ฯลฯ) ออกไปผิด state */
  const PLAY_ONLY_OUT = new Set(['position', 'position_look', 'look', 'flying', 'arm_animation', 'entity_action', 'held_item_slot',
    'block_dig', 'block_place', 'use_item', 'use_entity', 'teleport_confirm', 'chunk_batch_received', 'player_loaded', 'tick_end',
    'chat', 'chat_message', 'chat_command', 'chat_command_signed', 'window_click', 'close_window', 'steer_vehicle', 'vehicle_move',
    'abilities', 'client_command', 'set_creative_slot', 'spectate', 'pick_item', 'message_acknowledgement'])

  function traceOutbound(b) {
    const c = b && b._client
    if (!c || c.__outTrace) return
    c.__outTrace = true
    const seen = new Set()
    let hexLogged = 0
    const origWrite = c.write
    c.write = function (name, params) {
      if (name === 'keep_alive' && params && params.keepAliveId !== undefined) { if (kaSent.size > 200) kaSent.clear(); kaSent.add(String(params.keepAliveId)) }
      if (name === 'settings' || name === 'client_information') settingsAny = true
      if (this.state === 'play') {
        if (name === 'position' || name === 'position_look' || name === 'look' || name === 'flying') outMoves++
        else if (name === 'player_loaded') sentLoaded = true
        outSeen[name] = (outSeen[name] || 0) + 1
        if (name === 'teleport_confirm' || name === 'accept_teleportation') {
          if (params && params.teleportId !== undefined) { if (tpConfirmed.size > 500) tpConfirmed.clear(); tpConfirmed.add(String(params.teleportId)) }
        } else if (name === 'chunk_batch_received') chunkAcksOut++
        else if (name === 'pong') { if (params && params.id !== undefined) { if (pongSent.size > 500) pongSent.clear(); pongSent.add(String(params.id)) } }
        else if (name === 'tick_end') tickEndOut++
      }
      if (this.state !== 'play' && PLAY_ONLY_OUT.has(name)) {
        if (!seen.has('drop:' + name) && seen.size < 80) {
          seen.add('drop:' + name)
          pushLog(state, `[TRACE] ไม่ส่ง "${name}" เพราะตอนนี้อยู่ใน state ${this.state}`)
        }
        return
      }
      if ((this.state !== 'play' || name === 'configuration_acknowledged') && seen.size < 80) {
        const k = this.state + ':' + name
        if (!seen.has(k)) { seen.add(k); pushLog(state, `[TRACE] -> ${this.state}/${name}`) }
      }
      return origWrite.call(this, name, params)
    }
    const hookSerializer = () => {
      try {
        const ser = c.serializer
        if (!ser || ser.__hexHook) return
        ser.__hexHook = true
        ser.on('data', (buf) => {
          if (c.state !== 'play' && hexLogged < 25 && Buffer.isBuffer(buf)) {
            hexLogged++
            pushLog(state, `[TRACE] bytes(${c.state}) len=${buf.length} ${buf.subarray(0, 20).toString('hex')}`)
          }
        })
      } catch {}
    }
    hookSerializer()
    let outRelog = 0
    c.on('state', (ns, old) => {
      if (ns === 'configuration' && old === 'play' && outRelog < 4) {
        outRelog++
        try { for (const k of Array.from(seen)) if (k.startsWith('configuration:') || k.startsWith('drop:')) seen.delete(k) } catch {}
      }
      hookSerializer()
      try {
        if (ns === 'configuration') { b.clearControlStates && b.clearControlStates(); b.physicsEnabled = false }
        else if (ns === 'play') { b.physicsEnabled = true; schedulePlayEntryChecks() }
      } catch {}
    })
  }

  function setupDialogLogin(b) {
    const c = b && b._client
    if (!c) return
    c.on('state', (ns, old) => pushLog(state, `[TRACE] state ${old} -> ${ns}`))
    const fastSeen = Object.create(null)
    let kaLast = 0, kaBurst = 0
    let inRelog = 0
    c.on('state', (ns, old) => {
      if (ns === 'configuration' && old === 'play' && inRelog < 4) {
        inRelog++
        try {
          for (const k of Array.from(traceSeen)) if (k.startsWith('configuration:') || k.startsWith('xconfiguration:')) traceSeen.delete(k)
          delete fastSeen['configuration']
        } catch {}
      }
    })
    c.on('packet', (data, meta) => {
      if (!meta) return
      // log ชื่อ packet ที่เจอครั้งแรกในแต่ละ state (ช่วยดูว่าค้างตรงไหนถ้าไม่ spawn)
      // fast-path: จำผลต่อชื่อแพ็กเก็ต (เดิมรัน regex + ต่อสตริงกับ "ทุกแพ็กเก็ต" — ในฟาร์มที่มี entity เยอะคือหลายพันต่อวินาที)
      let tb = fastSeen[meta.state]; if (!tb) tb = fastSeen[meta.state] = Object.create(null)
      let cls = tb[meta.name]
      if (cls === undefined) {
      const key = meta.state + ':' + meta.name
      if (!traceSeen.has(key) && traceSeen.size < 150) {
        traceSeen.add(key)
        pushLog(state, `[TRACE] <- ${meta.state}/${meta.name}`)
      }
      if (/resource_pack|cookie_request|transfer/i.test(meta.name) && !traceSeen.has('x' + key)) {
        traceSeen.add('x' + key)
        let d = ''; try { d = JSON.stringify(data).slice(0, 300) } catch {}
        pushLog(state, `[TRACE] ${meta.state}/${meta.name} ${d}`)
      }
        cls = (/^(position|player_position|position_look|sync_player_position|chunk_batch_finished|ping)$/.test(meta.name) ? 2 : 0) | ((meta.name === 'show_dialog' || meta.name === 'clear_dialog') ? 4 : 0) | (meta.name === 'keep_alive' ? 8 : 0)
        tb[meta.name] = cls
      }
      if (!cls) return
      if (cls & 8) {
        const kn = Date.now()
        if (kaLast && kn - kaLast < 250) { if (++kaBurst === 3) pushLog(state, `[PERF] keep_alive มาติดกันเป็นชุด (${meta.state}) — มีของค้างมาก่อนหน้า: ถ้ามี [PERF] โปรเซสค้าง ด้วย = บอท/โฮสต์ช้าเอง, ถ้าไม่มี = ค้างที่เครือข่าย/พร็อกซี`) } else kaBurst = 0
        kaLast = kn
      }
      if (cls & 8) { try { ensureKeepAlive(c, data, meta) } catch {} }
      if ((cls & 2) && meta.state === 'play') { try { watchInbound(c, data, meta) } catch {} }
      if (!(cls & 4)) return
      if (meta.name === 'show_dialog') {
        try { handleDialog(c, data, meta.state) } catch (e) { pushLog(state, `[DIALOG] error: ${e.message}`) }
      } else if (meta.name === 'clear_dialog') {
        pushLog(state, '[DIALOG] server closed the dialog')
        pushLog(state, '[PIN] เซิร์ฟเวอร์ปิดหน้า PIN — ยังยืนยันไม่ได้ว่าผ่าน (ถ้าแชทยังบอก "กรุณากรอกรหัส PIN" = ยังไม่ผ่าน; ถ้ามีหน้าต่างเปิดตามมาให้ดู Server UI ในแดชบอร์ด)')
        if (uiDialog) uiDialog.closedAt = Date.now() // ค้างโชว์สั้น ๆ (ดู uiState) — ไม่ให้แผงหายวับ
        if (pinSeenAt) pinClearedAt = Date.now()
        pinManualUntil = 0
        if (pinRun) { pinRun.active = false; pinRun.settling = false; if (pinRun.wake) pinRun.wake() }
        pinSubmits = 0
        pinCooldownUntil = 0
        pinLatest = null
        pinSoftFails = 0
        pinWrong = false
        pinLastDialog = null
      }
    })
    c.on('error', (e) => pushLog(state, `[TRACE] client error: ${e && e.message}`))
    c.on('end', (r) => pushLog(state, `[TRACE] socket ended: ${r || ''}`))
  }

  /* ---- คลิกขวาของในมือ (use_item) แบบตรวจ schema + ลอง layout สำรอง ----
     เคสจริง: bot.activateItem() ของ mineflayer เขียน use_item ตาม schema ในไลบรารี แต่เซิร์ฟเวอร์เวอร์ชันใหม่ (26.x) decode ไม่ได้
     -> "Failed to decode packet 'serverbound/minecraft:use_item'" โดนเตะทุกครั้งที่บอทคลิก แล้ววน reconnect-โดนเตะไม่จบ
     ที่นี่: log schema + bytes จริงไว้ดู, ถ้าถูกเตะเพราะแพ็กเก็ตนี้จะสลับ layout รอบ reconnect ถัดไป (เหมือน dialogVariant) */
  const USE_ITEM_LAYOUTS = ['ค่าเริ่มต้นของไลบรารี (bot.activateItem)', 'hand + sequence (ไม่มี rotation)', 'hand + sequence + yaw/pitch (f32 องศา)']

  function activateItemSafe() {
    if (useItemBroken) throw new Error('คลิกขวาไอเทมถูกปิดไว้ เพราะเซิร์ฟเวอร์ decode แพ็กเก็ต use_item ไม่ได้ทุก layout (ดู log [USE_ITEM])')
    const c = bot && bot._client
    const layout = useItemVariant % USE_ITEM_LAYOUTS.length
    if (layout === 0 || !c || typeof c.writeRaw !== 'function' || !c.serializer || typeof c.serializer.createPacketBuffer !== 'function') {
      // layout 0 = พฤติกรรมเดิมทุกอย่าง + log diag ครั้งแรก ๆ
      if (useItemDiag < 2 && c) {
        useItemDiag++
        try {
          const t = bot.registry && bot.registry.protocol && bot.registry.protocol.play && bot.registry.protocol.play.toServer && bot.registry.protocol.play.toServer.types
          pushLog(state, `[USE_ITEM] schema ของไลบรารี: ${JSON.stringify(t && t.packet_use_item).slice(0, 400)} · เวอร์ชัน=${bot.version}`)
        } catch {}
        try {
          const ser = c.serializer
          if (ser && !ser.__useItemHook) {
            ser.__useItemHook = true
            const onData = (buf) => {
              try {
                if (Buffer.isBuffer(buf) && c.state === 'play' && buf.length <= 24 && !ser.__useItemHexDone) {
                  // use_item มีขนาดเล็ก — ไม่ล็อกแพ็กเก็ตอื่นเพื่อไม่ให้ log ท่วม (ดูเฉพาะตอนสั่งคลิกด้านล่าง)
                  if (ser.__expectUseItem) { ser.__useItemHexDone = true; ser.__expectUseItem = false; pushLog(state, `[USE_ITEM] bytes ที่ส่งจริง len=${buf.length} ${buf.toString('hex')}`) }
                }
              } catch {}
            }
            ser.on('data', onData)
          }
          if (ser) ser.__expectUseItem = true
        } catch {}
      }
      bot.activateItem()
      return `layout #0 ${USE_ITEM_LAYOUTS[0]}`
    }
    const types = bot.registry && bot.registry.protocol && bot.registry.protocol.play && bot.registry.protocol.play.toServer && bot.registry.protocol.play.toServer.types
    const pname = types && types.packet_use_item ? 'use_item' : null
    if (!pname) { bot.activateItem(); return 'ไม่พบ schema use_item — ใช้ค่าเริ่มต้น' }
    // หา id ของแพ็กเก็ตจาก mapper ของ toServer
    const fields = types.packet && types.packet[1]
    const nameField = Array.isArray(fields) ? fields.find(f => f && f.name === 'name') : null
    const mappings = nameField && nameField.type && nameField.type[1] && nameField.type[1].mappings
    let pid = null
    if (mappings) for (const k of Object.keys(mappings)) if (mappings[k] === 'use_item') { pid = Number(k); break }
    if (pid === null || !Number.isInteger(pid)) { bot.activateItem(); return 'หา id แพ็กเก็ต use_item ไม่ได้ — ใช้ค่าเริ่มต้น' }
    const varint = (n) => { const out = []; n = n >>> 0; while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7 } out.push(n); return Buffer.from(out) }
    const parts = [varint(pid), varint(0), varint(bot.__useItemSeq = ((bot.__useItemSeq || 0) + 1))] // hand=0, sequence
    if (layout === 2) {
      const D = 180 / Math.PI
      const yaw = 180 - (bot.entity.yaw || 0) * D
      const pitch = -(bot.entity.pitch || 0) * D
      const f = Buffer.alloc(8); f.writeFloatBE(yaw, 0); f.writeFloatBE(pitch, 4)
      parts.push(f)
    }
    const raw = Buffer.concat(parts)
    c.writeRaw(raw)
    pushLog(state, `[USE_ITEM] ส่ง layout #${layout} (${USE_ITEM_LAYOUTS[layout]}) bytes=${raw.toString('hex')}`)
    return `layout #${layout} ${USE_ITEM_LAYOUTS[layout]}`
  }

  /* ---- Auto server-select (right-click item, then click a slot in the menu) ---- */

  function waitForWindow(timeoutMs) {
    return new Promise((resolve) => {
      if (bot.currentWindow) return resolve(bot.currentWindow)
      const onOpen = (win) => { cleanup(); resolve(win) }
      const timer = setTimeout(() => { cleanup(); resolve(null) }, timeoutMs)
      function cleanup() { clearTimeout(timer); bot.removeListener('windowOpen', onOpen) }
      bot.once('windowOpen', onOpen)
    })
  }

  async function joinServerSelector() {
    if (!bot) return
    const heldItem = bot.heldItem
    pushLog(state, `[AUTO] Held item: ${heldItem ? heldItem.name : '(empty hand)'}`)
    const wanted = (state.serverSelectItem || 'grass_block').toLowerCase().trim()
    const MAX_ATTEMPTS = 4
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (!bot || state.status !== 'online') return
      try {
        if (useItemBroken) { pushLog(state, '[AUTO] ข้ามการคลิกขวาไอเทม (เซิร์ฟเวอร์ decode use_item ไม่ได้ — ดู log [USE_ITEM])'); return }
        pushLog(state, `[AUTO] Right-clicking to open server selector... (try ${attempt}/${MAX_ATTEMPTS})`)
        activateItemSafe()
        const win = await waitForWindow(6000)
        if (!win) {
          pushLog(state, '[AUTO] No menu opened yet, retrying...')
          await sleep(2000)
          continue
        }
        await sleep(600)
        const target = win.slots.find(s => s && s.name && s.name.toLowerCase().includes(wanted))
        if (!target) {
          const seen = win.slots.filter(s => s).map(s => s.name).join(', ') || '(empty)'
          pushLog(state, `[AUTO] Menu opened but "${wanted}" not found. Slots seen: ${seen}`)
          try { bot.closeWindow(win) } catch {}
          return
        }
        await bot.clickWindow(target.slot, 0, 0)
        pushLog(state, `[AUTO] Selected server (clicked ${target.name})`)
        return
      } catch (e) {
        pushLog(state, `[AUTO] Attempt ${attempt} failed: ${e.message}`)
        await sleep(2000)
      }
    }
    pushLog(state, '[AUTO] Server selector menu did not open after several tries. Check the item name in Settings, or the bot may not have received the menu item yet.')
  }

  /* ===========================
     MANUAL CONTROL — บังคับเอง (ระบบเดินไปพิกัด/วาป/คลิก NPC อัตโนมัติ + Auto-run ถูกรื้อออกทั้งหมดแล้ว)
       - เดิน: แดชบอร์ดส่งชุดปุ่มที่กดค้างอยู่มาเป็นระยะ (manualMove) — เงียบเกิน MOVE_DEADMAN_MS = ปล่อยปุ่มเอง
       - หัน / คลิกขวา NPC / คลิกขวาของในมือ: manualLook / manualInteract / manualUse
       - จอตำแหน่ง: controlState() ส่งพิกัด+ทิศของบอทและ entity ใกล้ตัวให้แท็บ Control
  =========================== */

  const NPC_SKIP = /^(item|item_entity|experience_orb|arrow|spectral_arrow|trident|text_display|item_display|block_display|interaction|marker|armor_stand|area_effect_cloud|lightning_bolt|ender_pearl|snowball|egg|firework_rocket|fishing_bobber|falling_block)$/i
  const D2R = Math.PI / 180
  let lastTickSeen = 0
  let lastTickAt = Date.now()
  let lastKick = 0
  const withTimeout = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)])
  const numOrNull = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v)
  const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
  function setCtl(k, on) { try { if (bot) bot.setControlState(k, on) } catch {} }
  function releaseAllKeys() { ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].forEach(k => setCtl(k, false)) }
  let moveTimer = null
  let moveBeat = 0
  const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'jump']
  const MOVE_DEADMAN_MS = 1200

  function stopMoveTimer() { if (moveTimer) { clearInterval(moveTimer); moveTimer = null } }

  // บอทถูกทิ้งแล้ว (cleanupBot): หยุดตัวจับเวลา ไม่แตะตัวบอท
  function resetControls() {
    stopMoveTimer()
  }

  // คืนข้อความเหตุผลถ้ายังควบคุมไม่ได้ (null = พร้อม)
  function controlReady() {
    if (!bot || state.status !== 'online') return 'บอทยังไม่ออนไลน์'
    if (!bot.entity || !bot.entity.position) return 'บอทยังไม่ได้ spawn (รอเซิร์ฟเวอร์ส่งตำแหน่งมา)'
    const c = bot._client
    if (c && c.state && c.state !== 'play') return `เซิร์ฟเวอร์อยู่ในหน้า "${c.state}" (หน้า PIN / ตั้งค่า) — ยังเดินไม่ได้ ใส่ PIN ให้เสร็จก่อน`
    return null
  }

  // physics loop ของ mineflayer บางเวอร์ชันใหม่ไม่เริ่มเอง (spawn ไม่ยิง) -> ไม่มี tick = สั่งเดินแล้วไม่ขยับ
  function ensurePhysics() {
    if (!bot) return
    if (!bot.physicsEnabled) bot.physicsEnabled = true
    const now = Date.now()
    if (physTicks !== lastTickSeen) { lastTickSeen = physTicks; lastTickAt = now; return }
    if (now - lastTickAt > 1500 && now - lastKick > 5000) {
      lastKick = now
      pushLog(state, '[CTRL] ⚠️ physics loop ไม่ทำงาน (ไม่มี tick) — กระตุ้นด้วย spawn event')
      try { bot.emit('spawn') } catch {}
      bot.physicsEnabled = true
    }
  }

  // mineflayer (physics.js) ตั้ง onGround=false และล้างความเร็วทุกครั้งที่ได้ position packet จากเซิร์ฟเวอร์
  // แม้เซิร์ฟเวอร์แค่ "ซิงก์" ตำแหน่งเดิมของบอท → pathfinder เห็นบอท "ลอย" 1 tick ต่อการแก้ 1 ครั้ง
  // (กระโดดไม่ได้ ความเร็วหาย จุดเริ่ม A* เพี้ยน) ถ้าแก้แค่นิดเดียวและใต้เท้ายังเป็นบล็อกตัน ให้ฟื้นค่าเดิม
  // เทเลพอร์ตจริง (ไกล/สูงต่างกัน) ปล่อยตามเซิร์ฟเวอร์ — physics tick ถัดไปคำนวณ onGround ใหม่เองอยู่แล้ว
  function softenForcedMove() {
    if (!bot || !bot.entity || !bot.entity.position || !lastPhys || !lastGround) return
    const e = bot.entity, o = lastPhys
    if (Math.hypot(e.position.x - o.x, e.position.z - o.z) > 0.6 || Math.abs(e.position.y - o.y) > 0.1) return
    const below = bot.blockAt(e.position.offset(0, -0.05, 0))
    if (!below || below.boundingBox !== 'block') return
    e.onGround = true
    // ต้องคืน vel.y ด้วย: prismarine-physics ตัดสิน onGround จาก "เคลื่อนลงแล้วชนพื้น" — vel.y ถูกล้างเป็น 0 → tick ถัดไปไม่ได้เคลื่อนลง → onGround=false อยู่ดี
    if (lastVel && e.velocity) { e.velocity.x = lastVel.x; e.velocity.y = lastVel.y; e.velocity.z = lastVel.z }
    softFixes++
  }

  function toServerTypes() {
    return bot && bot.registry && bot.registry.protocol && bot.registry.protocol.play && bot.registry.protocol.play.toServer && bot.registry.protocol.play.toServer.types
  }
  function hasPacket(n) { const t = toServerTypes(); return !!(t && t['packet_' + n]) }
  function firstPacket(names) { return names.find(hasPacket) }
  const pullsRecent = (ms) => { const n = Date.now(); return pullTimes.filter(t => n - t <= ms).length }

  // log การถูกเซิร์ฟเวอร์ดึงตำแหน่งกลับ — เฉพาะตอนกำลังเดินเอง (สูงสุด 12 ครั้งต่อการกดเดิน 1 รอบ)
  function logPull(dtPull, outSince) {
    if (pullLogN >= 12 || !bot || !bot.entity || !moveBeat || Date.now() - moveBeat > 4000) return
    pullLogN++
    const n = bot.entity.position, o = lastPhys
    const dxz = o ? Math.hypot(n.x - o.x, n.z - o.z) : 0
    const dy = o ? n.y - o.y : 0
    let hint = ''
    if (o) hint = (dxz < 0.05 && Math.abs(dy) < 0.05) ? ' · ตำแหน่งเดิมซ้ำ' : dxz < 0.8 ? ' · ดึงสั้น ๆ (ความเร็ว/สถานะวิ่งของบอทไม่ตรงเซิร์ฟเวอร์ หรือเซิร์ฟเวอร์จำกัดการเดิน)' : ' · ดึงไกล'
    pushLog(state, `[CTRL] 🔎 ถูกดึงกลับ #${pullLogN}: บอทคิดว่าอยู่ ${o ? fmt3(o) : '?'} → เซิร์ฟเวอร์สั่ง ${fmt3(n)}${o ? ' (ห่าง ' + dxz.toFixed(2) + ' · สูงต่าง ' + dy.toFixed(2) + ')' : ''} · ห่างครั้งก่อน ${dtPull < 0 ? '-' : dtPull + 'ms'} · บอทส่งแพ็กเก็ตเดิน +${outSince} · 10 วิล่าสุด ${pullTimes.length} ครั้ง${hint}`)
  }
  const fmt3 = (p) => `${(+p.x).toFixed(2)} ${(+p.y).toFixed(2)} ${(+p.z).toFixed(2)}`

  // ตอนเข้า play state (รวมรอบที่กลับมาจาก configuration หลัง PIN): ไคลเอนต์จริงส่ง player_loaded / settings ทุกครั้ง
  function schedulePlayEntryChecks() {
    const b = bot
    const token = ++entryToken
    sentLoaded = false
    setTimeout(() => { try { ensureEntryPackets(b, token) } catch (e) { pushLog(state, `[CTRL] ตรวจแพ็กเก็ตตอนเข้าโลกไม่สำเร็จ: ${e.message}`) } }, token > 1 ? 700 : 2500)
  }
  function ensureEntryPackets(b, token) {
    if (!bot || b !== bot || token !== entryToken) return
    const c = bot._client
    if (!c || c.state !== 'play') return
    const fixed = []
    if (!sentLoaded && hasPacket('player_loaded')) { sendPlayerLoadedIfMissing(); fixed.push('player_loaded') }
    if (!settingsAny && (hasPacket('settings') || hasPacket('client_information'))) {
      try { bot.setSettings({}); fixed.push('settings') } catch (e) { pushLog(state, `[CTRL] ส่ง settings ไม่สำเร็จ: ${e.message}`) }
    }
    if (fixed.length) pushLog(state, `[CTRL] 🔧 เข้าโลกแล้วบอทยังไม่ได้ส่ง ${fixed.join(', ')} — ส่งให้เอง`)
  }

  // ดูแพ็กเก็ตขาเข้าที่ "ต้องตอบ" แล้วเช็คว่า mineflayer ตอบจริงไหม (handler ของ mineflayer อาจพังเงียบ ๆ เพราะ guardPacketHandlers กลืน error)
  // ถ้าไม่ตอบภายใน 120ms เราตอบแทน — ถ้า mineflayer ตอบแล้วจะไม่ส่งซ้ำ
  function watchInbound(c, data, meta) {
    const n = meta.name
    const alive = () => bot && bot._client === c && c.state === 'play'
    if (data && data.teleportId !== undefined && /^(position|player_position|position_look|sync_player_position)$/.test(n)) {
      const id = String(data.teleportId)
      tpSeenIn++
      setTimeout(() => {
        if (!alive() || tpConfirmed.has(id)) return
        const out = firstPacket(['teleport_confirm', 'accept_teleportation'])
        if (!out) return
        try {
          c.write(out, { teleportId: data.teleportId })
          tpForced++
          if (tpForced <= 5) pushLog(state, `[CTRL] 🔧 mineflayer ไม่ได้ตอบ teleport #${id} — ส่ง ${out} แทน (ครั้งที่ ${tpForced})`)
        } catch (e) { pushLog(state, `[CTRL] ส่ง ${out} ไม่สำเร็จ: ${e.message}`) }
      }, 120)
    } else if (n === 'chunk_batch_finished') {
      const want = ++chunkBatchesIn
      setTimeout(() => {
        if (!alive() || chunkAcksOut >= want || !hasPacket('chunk_batch_received')) return
        try {
          c.write('chunk_batch_received', { chunksPerTick: 20 })
          chunkAcksForced++
          if (chunkAcksForced <= 3) pushLog(state, `[CTRL] 🔧 mineflayer ไม่ได้ตอบ chunk batch — ส่ง chunk_batch_received แทน (ครั้งที่ ${chunkAcksForced})`)
        } catch (e) { pushLog(state, `[CTRL] ส่ง chunk_batch_received ไม่สำเร็จ: ${e.message}`) }
      }, 120)
    } else if (n === 'ping' && data && data.id !== undefined) {
      const id = String(data.id)
      setTimeout(() => {
        if (!alive() || pongSent.has(id) || !hasPacket('pong')) return
        try {
          c.write('pong', { id: data.id })
          pongForced++
          if (pongForced <= 3) pushLog(state, `[CTRL] 🔧 ไม่มีใครตอบ ping #${id} — ส่ง pong แทน (ครั้งที่ ${pongForced})`)
        } catch (e) { pushLog(state, `[CTRL] ส่ง pong ไม่สำเร็จ: ${e.message}`) }
      }, 120)
    }
  }

  // รายงานครั้งเดียวหลังเริ่มเดินครั้งแรก (รอ 2.5 วิให้แพ็กเก็ตเดินถูกส่งก่อน): เวอร์ชัน/ความเร็ว/แพ็กเก็ตที่ขาด
  function walkDiag(b) {
    if (!bot || b !== bot) return
    const L = (m) => pushLog(state, '[CTRL] 🔎 ' + m)
    let rv = '?', proto = '?'
    try { rv = bot.registry.version.minecraftVersion || bot.registry.version.version || '?'; proto = bot.registry.version.version !== undefined ? bot.registry.version.version : '?' } catch {}
    const cfg = serverConfig.version || '(อัตโนมัติ)'
    L(`เวอร์ชัน: bot.version=${bot.version} · registry=${rv} · protocol=${proto} · ตั้งค่าไว้=${cfg}`)
    if (serverConfig.version && String(bot.version) !== String(serverConfig.version)) L(`⚠️ เวอร์ชันที่ใช้จริงไม่ตรงกับที่ตั้งไว้ — ฟิสิกส์อาจไม่ตรงเซิร์ฟเวอร์`)
    let spd = ''
    try {
      const at = bot.entity.attributes || {}
      const k = Object.keys(at).find(x => /movement_speed/i.test(x))
      spd = k ? `${k}=${at[k].value}` : `ไม่พบ attribute movement_speed (มี ${Object.keys(at).length} ตัว) — ฟิสิกส์ใช้ความเร็วเริ่มต้น อาจไม่ตรงเซิร์ฟเวอร์`
    } catch { spd = '?' }
    L(`ความเร็ว: ${spd}`)
    L('แพ็กเก็ตที่บอทส่ง (play): ' + (Object.keys(outSeen).map(k => `${k}×${outSeen[k]}`).join(' ').slice(0, 600) || '(ไม่มีเลย)'))
    const cand = ['teleport_confirm', 'player_loaded', 'tick_end', 'player_input', 'player_command', 'entity_action', 'chunk_batch_received', 'pong']
    const never = cand.filter(n => hasPacket(n) && !outSeen[n])
    if (!settingsAny && (hasPacket('settings') || hasPacket('client_information'))) never.push('settings')
    L('โปรโตคอลมีแต่บอทยังไม่เคยส่ง: ' + (never.join(', ') || '(ไม่มี)') + ' — บางตัวส่งเฉพาะตอนมีเหตุการณ์ (เช่น teleport_confirm/pong/player_command) ไม่ได้แปลว่าผิดเสมอไป')
    L(`ตอบแทนเซิร์ฟเวอร์: teleport ${tpSeenIn} ครั้ง (เราตอบแทน ${tpForced}) · chunk batch ${chunkBatchesIn} (แทน ${chunkAcksForced}) · tick_end ที่บอทส่ง ${tickEndOut} (แทน ${tickEndForced}) · pong แทน ${pongForced}`)
  }

  // 1.21.4+: เซิร์ฟเวอร์ไม่รับการโต้ตอบ (คลิก NPC/บล็อก) จนกว่าไคลเอนต์จะส่ง player_loaded — mineflayer ส่งตอนได้ update_health
  // ถ้า event spawn ไม่ยิง (fallback) แพ็กเก็ตนี้จึงไม่ถูกส่ง ส่งเองให้เฉพาะเมื่อโปรโตคอลมีแพ็กเก็ตนี้จริงและยังไม่เคยส่ง
  function sendPlayerLoadedIfMissing() {
    try {
      if (!bot || sentLoaded) return
      const types = bot.registry && bot.registry.protocol && bot.registry.protocol.play && bot.registry.protocol.play.toServer && bot.registry.protocol.play.toServer.types
      if (!types || !types.packet_player_loaded) return
      bot._client.write('player_loaded', {})
      pushLog(state, '[TRACE] ส่ง player_loaded ให้เอง (mineflayer ไม่ได้ส่งเพราะ event spawn ไม่ยิง)')
    } catch (e) { pushLog(state, `[TRACE] ส่ง player_loaded ไม่สำเร็จ: ${e.message}`) }
  }

  // เดินเอง: o = { keys: ['forward','left',...], sprint: bool, sneak: bool } = ปุ่มที่ "กดค้างอยู่ตอนนี้" (ว่าง = ปล่อยทุกปุ่ม)
  function manualMove(o) {
    o = o || {}
    const keys = Array.isArray(o.keys) ? o.keys.filter(k => MOVE_KEYS.includes(k)) : []
    if (!keys.length) { releaseAllKeys(); stopMoveTimer(); return { ok: true } }
    autoWalkCancel('คุณกดเดินเอง')
    const why = controlReady()
    if (why) { releaseAllKeys(); stopMoveTimer(); return { ok: false, error: why } }
    ensurePhysics()
    MOVE_KEYS.forEach(k => setCtl(k, keys.includes(k)))
    setCtl('sprint', !!o.sprint && keys.includes('forward'))
    setCtl('sneak', !!o.sneak)
    moveBeat = Date.now()
    if (!moveTimer) {
      pullLogN = 0
      moveTimer = setInterval(() => {
        if (!bot || Date.now() - moveBeat > MOVE_DEADMAN_MS) { releaseAllKeys(); stopMoveTimer() }
      }, 200)
    }
    if (!walkDiagDone) {
      walkDiagDone = true
      const b = bot
      setTimeout(() => { try { walkDiag(b) } catch (e) { pushLog(state, `[CTRL] วินิจฉัยไม่สำเร็จ: ${e.message}`) } }, 2500)
    }
    return { ok: true }
  }

  function manualStop() {
    autoWalkCancel()
    releaseAllKeys()
    stopMoveTimer()
    pushLog(state, '[CTRL] หยุดทุกการเคลื่อนไหว')
    return { ok: true }
  }


  // หัน: face=N/E/S/W | dyaw/dpitch = หมุนเพิ่ม (องศา, dyaw + = เลี้ยวขวา, dpitch + = เงย) | yaw/pitch = ค่าแบบ F3 | entity = หันหา entity id
  async function manualLook(o) {
    const why = controlReady()
    if (why) return { ok: false, error: why }
    o = o || {}
    const e = bot.entity
    let yaw = e.yaw, pitch = e.pitch
    const eid = numOrNull(o.entity)
    if (eid !== null) {
      const t = bot.entities && bot.entities[eid]
      if (!t || !t.position) return { ok: false, error: 'ไม่พบ entity นี้แล้ว (หลุดจากระยะ)' }
      await withTimeout(bot.lookAt(t.position.offset(0, (t.height || 1.5) * 0.6, 0), true), 1500)
      return { ok: true }
    }
    if (typeof o.face === 'string') {
      const faces = { N: 0, W: Math.PI / 2, S: Math.PI, E: 3 * Math.PI / 2 }
      if (!has(faces, o.face)) return { ok: false, error: 'ทิศไม่ถูกต้อง' }
      yaw = faces[o.face]
    }
    const ay = numOrNull(o.yaw), ap = numOrNull(o.pitch), dy = numOrNull(o.dyaw), dp = numOrNull(o.dpitch)
    if (ay !== null) yaw = (180 - ay) * D2R   // F3 yaw -> mineflayer yaw
    if (ap !== null) pitch = -ap * D2R        // F3 pitch (+ = ก้ม) -> mineflayer pitch (+ = เงย)
    if (dy !== null) yaw -= dy * D2R
    if (dp !== null) pitch += dp * D2R
    pitch = Math.max(-1.5, Math.min(1.5, pitch))
    await withTimeout(bot.look(yaw, pitch, true), 800)
    return { ok: true }
  }

  function entLabel(e) { return String(e.name || e.displayName || e.username || e.entityType || e.type || '').toLowerCase() }

  // entity ใกล้ตัว (ไม่รวมของที่ตกพื้น/แพ็กเก็ตตกแต่ง) เรียงตามระยะ
  function nearbyEntities(radius, limit) {
    if (!bot || !bot.entity || !bot.entity.position) return []
    const me = bot.entity.position
    const myYaw = wrap180(180 - bot.entity.yaw / D2R)
    const out = []
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || !e.position) continue
      const label = entLabel(e)
      if (NPC_SKIP.test(label)) continue
      const d = me.distanceTo(e.position)
      if (d > radius) continue
      const bearing = wrap180(-Math.atan2(e.position.x - me.x, e.position.z - me.z) / D2R)   // ทิศแบบ F3 จากบอทไปหา entity
      out.push({
        id: e.id, label: label || '?', type: String(e.type || ''), d: Math.round(d * 10) / 10,
        x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1),
        dir: compass(bearing), rel: Math.round(wrap180(bearing - myYaw))                       // rel + = อยู่ทางขวาของที่บอทหัน
      })
    }
    out.sort((a, b) => a.d - b.d)
    return out.slice(0, limit)
  }

  // ---- คลิกขวา entity: สร้างแพ็กเก็ตตาม schema ของโปรโตคอลที่ใช้อยู่จริง ----
  // เวอร์ชันใหม่ (26.x) เปลี่ยนรูปแบบแพ็กเก็ต use_entity/interact (ต้องมีตำแหน่งที่คลิก) ทำให้ bot.activateEntity ของ mineflayer
  // serialize ไม่ได้ ("Cannot read properties of undefined (reading 'x')") และ error นั้นเคยทำให้บอทหลุด
  function buildInteractParams(types, packetName, npc, hit, sneaking, action) {
    const resolve = (t) => (typeof t === 'string' && types[t] && types[t] !== 'native') ? types[t] : t
    // action: 'interact' (คลิกขวา, ค่าเดิม) | 'attack' (คลิกซ้าย: ช่อง mouse/type = 1)
    const num = (name) => (/entity|target|^id$/i.test(String(name || '')) ? npc.id : (action === 'attack' && /^(mouse|action|type|use_type)$/i.test(String(name || '')) ? 1 : 0))
    const fill = (type, name, parent) => {
      type = resolve(type)
      if (typeof type === 'string') {
        if (type === 'bool') return /sneak|secondary|shift/i.test(name) ? !!sneaking : false
        if (/^(vec3|lpvec3|position)/i.test(type)) return { x: hit.x, y: hit.y, z: hit.z }
        if (type === 'f32' || type === 'f64') return /y$/i.test(name) ? hit.y : /z$/i.test(name) ? hit.z : hit.x
        if (/^(varint|varlong|i8|u8|i16|u16|i32|u32|i64|u64|li32|lu32)$/.test(type)) return num(name)
        return undefined
      }
      if (!Array.isArray(type)) return undefined
      const kind = type[0], arg = type[1]
      if (kind === 'container') {
        const o = {}
        for (const f of arg) {
          const v = fill(f.type, f.name || '', o)
          if (f.anon) { if (v && typeof v === 'object') Object.assign(o, v) } else if (v !== undefined) o[f.name] = v
        }
        return o
      }
      if (kind === 'switch') {
        const key = String(arg.compareTo || '').split('/').pop()
        const val = parent ? parent[key] : undefined
        const t = (arg.fields && arg.fields[String(val)] !== undefined) ? arg.fields[String(val)] : arg.default
        return t === undefined ? undefined : fill(t, name, parent)
      }
      if (kind === 'option') return fill(arg, name, parent)
      if (kind === 'mapper') {
        const m = arg.mappings || {}
        const k = Object.keys(m).find(x => (action === 'attack' ? /^attack$/i : /^interact$/i).test(String(m[x])))
        return k !== undefined ? Number(k) : fill(arg.type, name, parent)
      }
      return undefined
    }
    return fill(types['packet_' + packetName], '', null)
  }

  function interactNpc(npc, action) {
    const c = bot && bot._client
    const types = bot && bot.registry && bot.registry.protocol && bot.registry.protocol.play && bot.registry.protocol.play.toServer && bot.registry.protocol.play.toServer.types
    if (!c || !types) throw new Error('อ่าน schema ของโปรโตคอลไม่ได้')
    const names = ['use_entity', 'interact', 'interact_entity'].filter(n => types['packet_' + n])
    if (!names.length) throw new Error('ไม่พบแพ็กเก็ตคลิก entity ใน protocol (ลองดู log ถัดไป)')
    const hit = { x: 0, y: (npc.height || 1) / 2, z: 0 }
    const sneaking = !!(bot.getControlState && bot.getControlState('sneak'))
    const errs = []
    for (const name of names) {
      try {
        const params = buildInteractParams(types, name, npc, hit, sneaking, action)
        c.serializer.createPacketBuffer({ name, params }) // ลอง serialize ก่อน — ถ้าผิดรูปจะ throw ตรงนี้ (ไม่ทำให้ client error)
        c.write(name, params)
        return `${name} ${JSON.stringify(params)}`
      } catch (e) { errs.push(`${name}: ${e.message}`) }
    }
    try { pushLog(state, `[CTRL] schema ${names[0]}: ${JSON.stringify(types['packet_' + names[0]]).slice(0, 500)}`) } catch {}
    throw new Error('สร้างแพ็กเก็ตคลิกไม่ได้ — ' + errs.join(' | '))
  }

  function waitForJoinEvidence(ms) {
    const b = bot
    return new Promise(resolve => {
      let done = false
      const onWin = () => fin('เมนูเปิดขึ้น')
      const onResp = () => fin('respawn/ย้ายโลก')
      const onEnd = () => fin('การเชื่อมต่อถูกตัด (อาจถูกส่งไปเซิร์ฟเวอร์อื่น)')
      const onMsg = (m) => {
        let t = ''; try { t = stringifyMsg(m) } catch {}
        if (/connect|เชื่อมต่อ|กำลังส่ง|กำลังเข้า|sending|joining|teleporting/i.test(t)) fin('แชท: ' + t.slice(0, 80))
      }
      const timer = setTimeout(() => fin(null), ms)
      function fin(why) {
        if (done) return
        done = true
        clearTimeout(timer)
        try { b.removeListener('windowOpen', onWin); b.removeListener('respawn', onResp); b.removeListener('end', onEnd); b.removeListener('message', onMsg) } catch {}
        resolve(why)
      }
      b.once('windowOpen', onWin); b.once('respawn', onResp); b.once('end', onEnd); b.on('message', onMsg)
    })
  }

  // คลิกขวา entity (เช่น NPC เลือกเซิร์ฟ) — หันหน้าหา entity ก่อนแล้วค่อยคลิก; ผลที่เซิร์ฟเวอร์ตอบจะขึ้นใน log
  async function manualInteract(id) {
    const why = controlReady()
    if (why) return { ok: false, error: why }
    const npc = bot.entities && bot.entities[id]
    if (!npc || !npc.position) return { ok: false, error: 'ไม่พบ entity นี้แล้ว (หลุดจากระยะ) — รอรายการอัปเดตแล้วลองใหม่' }
    const reach = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(npc.position.offset(0, (npc.height || 1.5) / 2, 0))
    const dist = reach()
    if (dist > 6) return { ok: false, error: `ไกลเกินไป (${dist.toFixed(1)} บล็อก) — เดินเข้าไปใกล้ก่อน (ต้องห่างไม่เกิน ~6 บล็อก)` }
    await withTimeout(bot.lookAt(npc.position.offset(0, (npc.height || 1.5) * 0.6, 0), true), 1500)
    await sleep(150)
    const evidence = waitForJoinEvidence(5000)
    let what
    try { what = interactNpc(npc) } catch (e) { pushLog(state, `[CTRL] คลิกไม่สำเร็จ: ${e.message}`); return { ok: false, error: e.message } }
    pushLog(state, `[CTRL] คลิกขวา ${entLabel(npc)} (id ${npc.id}, ห่าง ${dist.toFixed(1)}) → ${what}`)
    evidence.then(w => pushLog(state, w ? `[CTRL] ✅ เซิร์ฟเวอร์ตอบสนอง: ${w}` : '[CTRL] ยังไม่เห็นการตอบสนองจากเซิร์ฟเวอร์ใน 5 วิ'))
    return { ok: true }
  }

  function manualUse() {
    const why = controlReady()
    if (why) return { ok: false, error: why }
    try {
      activateItemSafe()
      pushLog(state, `[CTRL] คลิกขวาของในมือ: ${bot.heldItem ? bot.heldItem.name : '(มือเปล่า)'}`)
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  }

  function manualDismount() {
    if (!bot) return { ok: false, error: 'บอทยังไม่ออนไลน์' }
    if (!bot.vehicle) return { ok: false, error: 'บอทไม่ได้นั่งยานพาหนะ' }
    try { bot.dismount(); pushLog(state, '[CTRL] ลงจากยานพาหนะ'); return { ok: true } } catch (e) { return { ok: false, error: e.message } }
  }

  /* ===========================
     AUTO-ATTACK — ตีคลิกซ้าย "ไปข้างหน้าเฉย ๆ" ตามทิศที่บอทหันอยู่ ตั้งดีเลย์ได้ (state.attackDelay, หน่วย ms)
       - ไม่เลือกเป้าหมาย ไม่หันตามใคร: แกว่งแขนทุกครั้ง และถ้ามี entity อยู่ตรงเป้าเล็งในระยะ ATTACK_REACH ก็ส่งแพ็กเก็ตตีใส่ตัวนั้น
  =========================== */
  const ATTACK_REACH = 3.2
  let atkLoopOn = false
  let atkHits = 0                // จำนวนครั้งที่แกว่ง
  let atkLanded = 0              // จำนวนครั้งที่มี entity อยู่ตรงหน้าและส่งแพ็กเก็ตตี
  let atkNote = ''
  let atkLastLog = 0

  function attackForward() {
    let t = null
    try { t = bot.entityAtCursor(ATTACK_REACH) } catch {}
    if (t && t.position) {
      try { interactNpc(t, 'attack'); atkLanded++ } catch (e) { try { bot.attack(t); atkLanded++ } catch {} }
    }
    try { bot.swingArm('right') } catch {}
    return t
  }

  async function attackLoop() {
    if (atkLoopOn) return
    atkLoopOn = true
    try {
      while (state.autoAttack && bots.get(state.id) === managed) {
        const t0 = Date.now()
        try {
          if (controlReady()) atkNote = 'บอทยังไม่พร้อม (ออฟไลน์/ยังไม่เข้าโลก)'
          else {
            const t = attackForward()
            atkHits++
            atkNote = t ? `ตี ${entLabel(t)} (id ${t.id}) ตรงหน้า` : 'ตีไปข้างหน้า (ไม่มี entity ตรงเป้าเล็ง)'
            if (atkHits === 1 || Date.now() - atkLastLog > 15000) {
              atkLastLog = Date.now()
              pushLog(state, `[ATTACK] คลิกซ้ายไปข้างหน้า · ดีเลย์ ${state.attackDelay}ms · แกว่ง ${atkHits} ครั้ง · โดน entity ${atkLanded} ครั้ง`)
            }
          }
        } catch (e) {
          atkNote = 'ผิดพลาด: ' + e.message
          if (Date.now() - atkLastLog > 10000) { atkLastLog = Date.now(); pushLog(state, `[ATTACK] error: ${e.message}`) }
        }
        await sleep(Math.max(10, state.attackDelay - (Date.now() - t0)))
      }
    } finally {
      atkLoopOn = false
      atkNote = ''
    }
  }

  // o = { on?: bool, delay?: ms }
  function setAutoAttack(o) {
    o = o || {}
    if (o.delay !== undefined) state.attackDelay = clampAttackDelay(o.delay)
    if (o.on !== undefined) state.autoAttack = !!o.on
    scheduleSaveBots()
    pushLog(state, `[ATTACK] ตีคลิกซ้ายไปข้างหน้าอัตโนมัติ: ${state.autoAttack ? 'เปิด' : 'ปิด'} · ดีเลย์ ${state.attackDelay}ms`)
    if (state.autoAttack) attackLoop().catch(e => pushLog(state, `[ATTACK] error: ${e.message}`))
    return { ok: true, on: state.autoAttack, delay: state.attackDelay }
  }

  function setAutoClick(on) {
    state.autoClick = !!on
    scheduleSaveBots()
    pushLog(state, `[WALK] คลิกขวา NPC อัตโนมัติเมื่อเดินถึง: ${on ? 'เปิด' : 'ปิด'}`)
    return { ok: true, on: !!on }
  }
  /* ---- end AUTO-ATTACK ---- */

  /* ===========================
     AUTO-WALK — เดินไปหา NPC เองหลังใส่ PIN เสร็จ แล้วคลิกขวาให้เอง (ปิดได้ที่แท็บ Control) · ถูกเซิร์ฟเวอร์ดึงกลับ = หยุดรอ 5 วิ แล้ววิ่งต่อทันที วนไปจนกว่าจะถึง (ไม่มีหมดเวลา/ไม่เลิกเพราะติด)
       - ใช้ปุ่มควบคุมแบบเดียวกับเดินเอง (ไม่ใช้ pathfinder) หันหา NPC + เดินหน้า + กระโดดเมื่อติด
       - กด "หยุดทุกอย่าง" หรือกดเดินเอง = ยกเลิกทันที
  =========================== */
  const WALK_STOP_DIST = 2.0     // หยุดเมื่อห่าง NPC (แนวนอน) ไม่เกินนี้
  const WALK_PULL_WAIT_MS = 5000 // ถูกดึงกลับ = หยุดรอเท่านี้แล้วเดินต่อ
  let walkRun = null             // { token, label, startedAt, target, d }
  let walkToken = 0
  let walkArmed = true           // เดินหลัง PIN ครั้งเดียวต่อการเชื่อมต่อ

  function autoWalkCancel(why) {
    if (!walkRun) return
    walkToken++
    walkRun = null
    if (why) pushLog(state, `[WALK] ยกเลิกการเดินอัตโนมัติ — ${why}`)
  }

  // เลือกเป้าหมาย: allay ก่อน → ไม่ใช่ผู้เล่น → อะไรก็ได้ที่ใกล้สุด
  function pickWalkTarget() {
    const list = nearbyEntities(64, 40)
    return list.find(e => /allay/.test(e.label)) || list.find(e => e.type !== 'player' && e.label !== 'player') || list[0] || null
  }

  function startWalk(label) {
    const why = controlReady()
    if (why) return { ok: false, error: why }
    autoWalkCancel()
    const token = ++walkToken
    walkRun = { token, label, startedAt: Date.now(), target: '', d: null }
    runWalk(token).catch(e => {
      pushLog(state, `[WALK] error: ${e.message}`)
      if (walkToken === token) { releaseAllKeys(); walkRun = null }
    })
    return { ok: true }
  }

  async function runWalk(token) {
    const b = bot
    const alive = () => bot === b && walkToken === token && b && b.entity && b.entity.position
    pushLog(state, `[WALK] เริ่มหา NPC (${walkRun.label})`)
    let tgtId = null, tgtLabel = ''
    const findUntil = Date.now() + 15000
    while (alive() && Date.now() < findUntil) {
      const t = pickWalkTarget()
      if (t) { tgtId = t.id; tgtLabel = t.label; break }
      await sleep(500)
    }
    if (!alive()) return
    if (tgtId === null) { pushLog(state, '[WALK] ไม่เจอ NPC/entity ในรัศมี 64 บล็อกภายใน 15 วิ — ไม่เดิน'); walkRun = null; return }
    walkRun.target = tgtLabel
    pushLog(state, `[WALK] เป้าหมาย: ${tgtLabel} (id ${tgtId})`)
    ensurePhysics()

    const startAt = Date.now()
    let lastPos = b.entity.position.clone(), lastCheck = Date.now()
    let stuckN = 0, jumpUntil = 0, sideUntil = 0, sideKey = 'left'
    let result = '', arrived = false, lastD = null
    let pullSeen = lastPullAt, pullWaits = 0, lostSince = 0
    while (alive()) {
      // ถูกเซิร์ฟเวอร์ดึงกลับ -> หยุดรอ 5 วิ แล้วเดินต่อ (วนแบบนี้จนกว่าจะถึง)
      if (lastPullAt > pullSeen) {
        pullWaits++
        releaseAllKeys()
        pushLog(state, `[WALK] ⏸ ถูกดึงกลับ (ครั้งที่ ${pullWaits}) — หยุดรอ ${WALK_PULL_WAIT_MS / 1000} วิ แล้วเดินต่อ`)
        const waitFrom = Date.now()
        while (alive() && Date.now() - waitFrom < WALK_PULL_WAIT_MS) await sleep(100)
        if (!alive()) break
        pullSeen = lastPullAt // การดึงที่เกิดระหว่างรอ ถือว่าจัดการแล้ว
        if (b.entity && b.entity.position) lastPos = b.entity.position.clone()
        lastCheck = Date.now(); stuckN = 0; jumpUntil = 0; sideUntil = 0
        ensurePhysics()
        // ครบ 5 วิ = ออกวิ่งทันที (กดปุ่มก่อนวนรอบถัดไป ไม่ปล่อยให้ยืนนิ่ง)
        setCtl('sprint', true); setCtl('back', false); setCtl('forward', true)
        pushLog(state, '[WALK] ▶ ครบ 5 วิ — วิ่งต่อ')
      }
      const why = controlReady()
      if (why) { setCtl('forward', false); await sleep(500); continue } // ยังไม่พร้อมชั่วคราว (เช่น state ยังไม่ใช่ play) — รอแล้วลองใหม่ ไม่เลิกเดิน
      let t = b.entities && b.entities[tgtId]
      if (!t || !t.position) {
        // NPC หลุดจากระยะ/เปลี่ยน id — ไม่เลิก: รอสักพักแล้วหาเป้าหมายใหม่ต่อ
        setCtl('forward', false)
        if (!lostSince) lostSince = Date.now()
        if (Date.now() - lostSince > 3000) {
          const nt = pickWalkTarget()
          if (nt) { tgtId = nt.id; tgtLabel = nt.label; walkRun.target = tgtLabel; lostSince = 0; pushLog(state, `[WALK] เป้าหมายหาย — เปลี่ยนไปเดินหา ${tgtLabel} (id ${tgtId})`) }
          else lostSince = Date.now()
        }
        await sleep(150); continue
      }
      lostSince = 0
      const me = b.entity.position
      const dx = t.position.x - me.x, dz = t.position.z - me.z
      const d = Math.hypot(dx, dz)
      lastD = d
      walkRun.d = Math.round(d * 10) / 10
      if (d <= WALK_STOP_DIST) { arrived = true; break }
      await withTimeout(b.lookAt(me.offset(dx, 1.62, dz), true), 300)
      const now = Date.now()
      if (now - lastCheck >= 700) {
        const moved = Math.hypot(me.x - lastPos.x, me.z - lastPos.z)
        lastPos = me.clone(); lastCheck = now
        if (moved < 0.15) {
          stuckN++
          jumpUntil = now + 400
          if (stuckN >= 3 && stuckN % 2 === 1) { sideKey = sideKey === 'left' ? 'right' : 'left'; sideUntil = now + 500 }
          if (stuckN === 3) pushLog(state, '[WALK] ติดอะไรอยู่ — ลองกระโดด/เบี่ยงข้าง')
        } else stuckN = 0
      }
      setCtl('sprint', true) // เซิร์ฟเวอร์นี้ดึงกลับถ้าเดินธรรมดา แต่ถ้าวิ่งไม่โดน
      setCtl('back', false)
      setCtl('forward', true)
      setCtl('jump', now < jumpUntil)
      setCtl('left', now < sideUntil && sideKey === 'left')
      setCtl('right', now < sideUntil && sideKey === 'right')
      await sleep(80)
    }
    if (walkToken !== token) return // ถูกยกเลิก/แทนที่ — คนที่ยกเลิกจัดการปุ่มเอง
    releaseAllKeys()
    walkRun = null
    if (arrived) {
      if (state.autoClick) {
        pushLog(state, `[WALK] ✅ ถึงแล้ว ห่าง ${lastD.toFixed(1)} บล็อก — คลิกขวา NPC ให้อัตโนมัติ`)
        try {
          await sleep(300) // ให้ตัวบอทหยุดนิ่งก่อนคลิก
          if (bot !== b) return
          const r = await manualInteract(tgtId)
          if (r && !r.ok) pushLog(state, `[WALK] คลิกขวาอัตโนมัติไม่สำเร็จ: ${r.error}`)
        } catch (e) { pushLog(state, `[WALK] คลิกขวาอัตโนมัติ error: ${e.message}`) }
      } else {
        pushLog(state, `[WALK] ✅ ถึงแล้ว ห่าง ${lastD.toFixed(1)} บล็อก — กด 🖱 คลิกขวา ที่แท็บ Control ได้เลย`)
        try { await withTimeout(b.lookAt(b.entities[tgtId].position.offset(0, ((b.entities[tgtId].height || 1.5) * 0.6), 0), true), 500) } catch {}
      }
    } else {
      pushLog(state, `[WALK] หยุดเดิน: ${result || 'ไม่ทราบสาเหตุ'}${lastD !== null ? ` (ยังห่าง ${lastD.toFixed(1)} บล็อก)` : ''}`)
    }
  }

  // PIN ผ่านแล้ว = เซิร์ฟเวอร์ปิดหน้า PIN (clear_dialog) → รอกลับเข้าโลก/ไม่มีหน้า PIN เด้งใหม่ → เดิน
  async function waitPinThenWalk(b) {
    const clearedAt = pinClearedAt
    const notPassed = () => pinSeenAt > clearedAt || pinBlockedAt > clearedAt
    const giveUp = (m) => { pushLog(state, `[WALK] ${m}`); walkArmed = true }
    const until = Date.now() + 40000
    while (bot === b && Date.now() < until) {
      if (notPassed()) return giveUp('PIN ยังไม่ผ่าน — ไม่เดิน (จะลองใหม่เมื่อเซิร์ฟเวอร์ปิดหน้า PIN อีกครั้ง)')
      if (!controlReady() && Date.now() - clearedAt >= 3000) break
      await sleep(500)
    }
    if (bot !== b || controlReady()) return giveUp('รอเข้าโลกนานเกิน 40 วิ — ไม่เดิน (กดปุ่ม "เดินไปหา NPC ตอนนี้" ที่แท็บ Control ได้)')
    await sleep(1500) // เผื่อเซิร์ฟเวอร์ตอบ "กรุณากรอกรหัส PIN" ช้า
    if (bot !== b) return
    if (notPassed()) return giveUp('PIN ยังไม่ผ่าน — ไม่เดิน')
    if (!state.autoWalk) return
    const r = startWalk('หลังใส่ PIN เสร็จ')
    if (!r.ok) giveUp(`เดินไม่ได้: ${r.error}`)
  }

  function setupAutoWalk(b) {
    const c = b && b._client
    if (!c) return
    walkArmed = true
    autoWalkCancel()
    c.on('packet', (data, meta) => {
      if (!meta || meta.name !== 'clear_dialog') return
      if (!pinSeenAt || !walkArmed || !state.autoWalk) return
      walkArmed = false
      pushLog(state, '[WALK] เซิร์ฟเวอร์ปิดหน้า PIN — ถ้า PIN ผ่านและเข้าโลกแล้ว จะเดินไปหา NPC เอง')
      waitPinThenWalk(b).catch(e => pushLog(state, `[WALK] error: ${e.message}`))
    })
  }

  function setAutoWalk(on) {
    state.autoWalk = !!on
    if (!on) autoWalkCancel('ปิดระบบ')
    scheduleSaveBots()
    pushLog(state, `[WALK] เดินไปหา NPC อัตโนมัติหลังใส่ PIN: ${on ? 'เปิด' : 'ปิด'}`)
    return { ok: true, on: !!on }
  }
  /* ---- end AUTO-WALK ---- */

  /* ===========================
     RESOURCE PACK — ตอบรับอัตโนมัติ (ไม่ดาวน์โหลดไฟล์จริง)
       เซิร์ฟเวอร์ส่ง add_resource_pack (1.20.3+) หรือ resource_pack_send (เก่ากว่า) มา ทั้งใน configuration และ play
       บอทตอบ accepted → downloaded → loaded เหมือนไคลเอนต์ที่โหลดเสร็จ เซิร์ฟที่บังคับ resource pack จะปล่อยให้เข้า
  =========================== */
  function setupResourcePack(b) {
    const c = b && b._client
    if (!c) return
    c.on('packet', (data, meta) => {
      if (!meta) return
      if (meta.name === 'remove_resource_pack') return
      if (meta.name !== 'add_resource_pack' && meta.name !== 'resource_pack_send') return
      const st = meta.state || c.state
      const uuid = data && data.uuid
      let url = ''; try { url = String((data && data.url) || '').slice(0, 120) } catch {}
      const forced = data && data.forced !== undefined ? ` · บังคับ=${!!data.forced}` : ''
      pushLog(state, `[RP] เซิร์ฟเวอร์ส่ง resource pack (${st}/${meta.name}${forced}) ${url} — ตอบรับให้อัตโนมัติ (ไม่โหลดไฟล์จริง)`)
      // 3 = accepted, 4 = downloaded (มีเฉพาะ 1.20.3+ ที่มี uuid), 0 = loaded สำเร็จ
      const steps = uuid !== undefined && uuid !== null ? [[3, 50], [4, 400], [0, 800]] : [[3, 50], [0, 600]]
      steps.forEach(([result, delay]) => {
        setTimeout(() => {
          try {
            if (bot !== b || c.destroyed || c.state !== st) return
            const params = { result }
            if (uuid !== undefined && uuid !== null) params.uuid = uuid
            c.write('resource_pack_receive', params)
            if (result === 0) pushLog(state, '[RP] ✅ ตอบว่าโหลด resource pack สำเร็จแล้ว')
          } catch (e) { pushLog(state, `[RP] ตอบไม่สำเร็จ (result ${result}): ${e.message}`) }
        }, delay)
      })
    })
  }
  /* ---- end RESOURCE PACK ---- */

  function compass(f3yaw) {
    const names = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE']
    return names[Math.round((((f3yaw % 360) + 360) % 360) / 45) % 8]
  }

  // สถานะให้แท็บ Control (poll ทุก ~600ms)
  function controlState() {
    const why = controlReady()
    const out = { ts: Date.now(), ready: !why, why: why || '', status: state.status, forced: forcedMoves, ticks: physTicks, gfalse: groundFalse, softFixes, pulls10: pullsRecent(10000), pos: null, entities: [] }
    try {
      if (bot && bot.entity && bot.entity.position) {
        const p = bot.entity.position
        const yaw = wrap180(180 - bot.entity.yaw / D2R)
        out.pos = { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) }
        out.yaw = +yaw.toFixed(1)
        out.pitch = +(-bot.entity.pitch / D2R).toFixed(1)
        out.dir = compass(yaw)
        out.onGround = !!bot.entity.onGround
        out.vehicle = bot.vehicle ? String(bot.vehicle.name || bot.vehicle.type || 'มี') : ''
        if (!why) out.entities = nearbyEntities(32, 20)
      }
    } catch (e) { out.error = e.message }
    out.autoWalk = !!state.autoWalk
    out.autoClick = !!state.autoClick
    out.attack = { on: !!state.autoAttack, delay: state.attackDelay, hits: atkHits, landed: atkLanded, note: atkNote }
    out.walk = walkRun ? { running: true, target: walkRun.target, d: walkRun.d } : { running: false }
    return out
  }
  /* ---- end MANUAL CONTROL ---- */

  /* ---- Auto-eat: keep the bot fed without interrupting whatever it's doing ---- */

  let eatingNow = false
  async function tryAutoEat() {
    if (!bot || !state.autoEat || eatingNow) return
    if (typeof bot.food !== 'number') return
    if (bot.food >= 18) return
    let foodItem = null
    const items = bot.inventory.items()
    for (const name of FOOD_PRIORITY) {
      foodItem = items.find(i => i.name === name)
      if (foodItem) break
    }
    if (!foodItem) {
      foodItem = items.find(i => !FOOD_AVOID.includes(i.name) && /^(cooked_|baked_)/.test(i.name))
    }
    if (!foodItem) {
      if (bot.food <= 6) pushLog(state, '[AUTO-EAT] Hungry but no food in inventory!')
      return
    }
    eatingNow = true
    const prevHeld = bot.heldItem
    try {
      await bot.equip(foodItem, 'hand')
      await bot.consume()
      pushLog(state, `[AUTO-EAT] Ate ${foodItem.name} (food: ${bot.food}/20)`)
      if (prevHeld) { try { await bot.equip(prevHeld, 'hand') } catch {} }
    } catch (e) {
      pushLog(state, `[AUTO-EAT] Failed to eat: ${e.message}`)
    } finally {
      eatingNow = false
    }
  }

  /* ---- Server UI (dashboard): แสดง dialog/หน้าต่างของเซิร์ฟเวอร์ให้กดเอง ---- */
  // แปลงค่าอะไรก็ได้ (string / JSON string / NBT / chat component) เป็นข้อความล้วน
  function nameFromAny(v) {
    try {
      let n = nbtToPlain(v)
      if (typeof n === 'string') {
        const q = n.trim()
        if (q[0] === '{' || q[0] === '[' || q[0] === '"') { try { n = JSON.parse(q) } catch {} }
      }
      const t = typeof n === 'string' ? n : (textOf(n) || collectTexts(n, []).join(''))
      return String(t || '').replace(/§./g, '').trim()
    } catch { return '' }
  }

  function uiWinTitle(w) {
    let t = w && w.title
    if (t && typeof t === 'object') {
      let str = ''
      try { if (typeof t.toString === 'function' && t.toString !== Object.prototype.toString) str = String(t.toString()) } catch {}
      if (!str || str === '[object Object]') str = nameFromAny(t) // เดิมขึ้น "[object Object]" เมื่อ title เป็น object
      t = str
    }
    if (typeof t === 'string') {
      const q = t.trim()
      if (q[0] === '{' || q[0] === '[' || q[0] === '"') { try { t = textOf(JSON.parse(q)) } catch {} }
    } else t = textOf(t)
    const out = String(t || '').replace(/§./g, '').trim()
    return out === '[object Object]' ? '' : out
  }

  function itemLabel(it) {
    try {
      let n = it.customName
      if (n) {
        if (typeof n === 'string') {
          const q = n.trim()
          if (q[0] === '{' || q[0] === '[' || q[0] === '"') { try { n = textOf(JSON.parse(q)) } catch {} }
        } else n = textOf(n)
        n = String(n).replace(/§./g, '').trim()
        if (n) return n
      }
    } catch {}
    // ไคลเอนต์ 1.20.5+: ชื่ออยู่ใน components (custom_name / item_name) ไม่ใช่ customName
    try {
      if (Array.isArray(it.components)) {
        for (const cn of ['custom_name', 'item_name']) {
          const c = it.components.find(x => x && x.type === cn)
          if (c && c.data !== undefined) { const n = nameFromAny(c.data); if (n) return n }
        }
      }
    } catch {}
    return String(it.displayName || it.name || '?')
  }

  // log รายการช่องในหน้าต่าง (ไม่รวมกระจก) — ดูว่าเซิร์ฟเวอร์ใช้ชื่อหรือจำนวนไอเทมเป็นตัวเลข
  function logWindowSlots(w) {
    if (!w || Date.now() - winDumpAt < 3000) return
    winDumpAt = Date.now()
    const end = typeof w.inventoryStart === 'number' ? w.inventoryStart : (w.slots || []).length
    const rows = []
    for (let i = 0; i < end; i++) {
      const it = w.slots[i]
      if (!it || /glass_pane/.test(String(it.name))) continue
      let comps = ''
      try { if (Array.isArray(it.components)) comps = ' comps=' + it.components.map(x => x && x.type).filter(Boolean).join(',') } catch {}
      rows.push(`#${i} ${it.name} x${it.count || 1} "${itemLabel(it)}"${comps}`)
    }
    pushLog(state, `[UI] ช่องในหน้าต่าง "${uiWinTitle(w)}" (ไม่รวมกระจก): ${rows.join(' | ') || '(ว่าง)'}`)
  }

  function buildUiDialog(c, stateName, dlg, plain) {
    uiEverShown = true
    const pieces = (node) => collectTexts(node, []).map(t => String(t).replace(/§./g, '')).join('')
    let text = ''
    try {
      const parts = []
      if (dlg.title) parts.push(pieces(dlg.title))
      const body = Array.isArray(dlg.body) ? dlg.body : (dlg.body ? [dlg.body] : [])
      body.forEach(b => parts.push(pieces(b)))
      text = parts.map(x => x.trim()).filter(Boolean).join('\n')
    } catch {}
    if (!text) text = collectTexts(plain, []).map(t => String(t).replace(/§./g, '')).join('').trim()
    return { at: Date.now(), c, stateName, buttons: collectButtons(dlg), text, left: remainingAttempts(plain), dots: parseDots(plain), clickedAt: 0, closedAt: 0 }
  }

  function uiState() {
    const out = { ts: Date.now(), dialog: null, window: null }
    try {
      // dialog ที่เซิร์ฟเวอร์เพิ่งปิด (clear_dialog) ค้างไว้โชว์ ~2.5 วิ — เซิร์ฟเวอร์มักปิดแล้วส่งหน้าใหม่ตามมาทันที
      // เดิมตั้ง null ทันที แผงจึง "หายวับ" แล้วโผล่กลับมาทุกครั้งที่กดเลข
      if (uiDialog && uiDialog.closedAt && Date.now() - uiDialog.closedAt > 2500) uiDialog = null
      if (uiDialog && Date.now() - uiDialog.at < 120000) {
        out.dialog = {
          text: uiDialog.text, left: uiDialog.left, dots: uiDialog.dots ? uiDialog.dots.text : '',
          closed: !!uiDialog.closedAt, held: Date.now() < pinManualUntil,
          buttons: uiDialog.buttons.map((b, i) => ({ i, role: b.role, label: b.label }))
        }
      }
      const w = bot && bot.currentWindow
      if (w) {
        const end = typeof w.inventoryStart === 'number' ? w.inventoryStart : (w.slots || []).length
        const type = String(w.type || '')
        const cols = /hopper/.test(type) ? 5 : /3x3/.test(type) ? 3 : 9
        const slots = []
        for (let i = 0; i < end; i++) {
          const it = w.slots[i]
          slots.push(it ? { s: i, label: itemLabel(it), n: it.count || 1, id: String(it.name || '') } : { s: i, label: '' })
        }
        out.window = { title: uiWinTitle(w), type, cols, slots, empty: !slots.some(x => x.label) }
      }
      // ยังไม่มีหน้า PIN ขึ้นมาให้กด → ให้แดชบอร์ดโชว์หน้าโหลดรอ (เฉพาะช่วงเพิ่งเชื่อมต่อ ไม่เกิน 60 วิ และยังไม่เคยมีหน้าของเซิร์ฟเวอร์ขึ้น)
      if (!out.dialog && !out.window && bot && !uiEverShown && !pinSeenAt && !pinClearedAt && (state.autoPin || state.loginPin)
          && connectBeganAt && Date.now() - connectBeganAt < 60000 && (state.status === 'connecting' || state.status === 'online')) {
        out.loading = { text: 'กำลังรอหน้า PIN จากเซิร์ฟเวอร์…' }
      }
    } catch (e) { out.error = e.message }
    return out
  }

  // รอ dialog ที่ "ยังกดได้" (ไม่ได้ปิด และยังไม่ถูกกดไป — ปุ่มของ Paper ใช้ได้ครั้งเดียว ต้องรอหน้าชุดใหม่)
  // ถ้าหน้านี้ถูกกดไปแล้วเกิน 2.5 วิแต่เซิร์ฟเวอร์ไม่ส่งหน้าใหม่ ก็ยอมให้ลองกดซ้ำ
  async function waitDialogReady(ms) {
    const t0 = Date.now()
    for (;;) {
      const d = uiDialog
      if (!d) return null
      if (!d.closedAt && (!d.clickedAt || Date.now() - d.clickedAt > 2500)) return d
      if (Date.now() - t0 >= ms) return null
      await sleep(40)
    }
  }

  // กดปุ่มจากแดชบอร์ด: เข้าคิว (กดรัว ๆ ได้ ลำดับเลขไม่เพี้ยน) — เดิมกดถี่เกินไปจะโดนปฏิเสธแล้วเลขตกหล่น
  // ปุ่มเลือกจาก "ข้อความบนปุ่ม" ในหน้าล่าสุด ไม่ใช่ตำแหน่ง (id/ลำดับของปุ่มเปลี่ยนทุกหน้า)
  let uiClickChain = Promise.resolve()
  function uiDialogClick(i, label) {
    if (!bot || !uiDialog) return Promise.resolve({ ok: false, error: 'ตอนนี้เซิร์ฟเวอร์ไม่ได้เปิดหน้าต่างให้กด' })
    pinManualUntil = Date.now() + 40000 // คนกดแล้ว — บอทเลิกกด PIN อัตโนมัติทันที (กันกดชนกันจนเลขมั่ว/โดนล็อก)
    if (pinRun) { pinRun.active = false; pinRun.settling = false; if (pinRun.wake) pinRun.wake() }
    const job = uiClickChain.then(() => uiDialogClickNow(i, label))
    uiClickChain = job.catch(() => {})
    return job
  }

  async function uiDialogClickNow(i, label) {
    const d = await waitDialogReady(3500)
    if (!bot || !d) return { ok: false, error: 'เซิร์ฟเวอร์ยังไม่ส่งหน้าใหม่มา (หรือปิดหน้านี้แล้ว) — ลองกดอีกครั้ง' }
    const want = (label === undefined || label === null) ? '' : String(label)
    let b = null
    if (want) b = d.buttons.find(x => x.label === want)
    else { const cand = d.buttons[i]; b = (cand && cand.label === '') ? cand : d.buttons.find(x => x.label === '') }
    if (!b) return { ok: false, error: 'ไม่พบปุ่มนี้แล้ว (หน้าเปลี่ยน) ลองกดใหม่' }
    try {
      const what = pressButton(d.c, b)
      d.clickedAt = Date.now()
      pinManualUntil = Date.now() + 40000
      pushLog(state, `[PIN] (กดมือ) ${/^[0-9]$/.test(b.label) ? 'ปุ่มเลข' : `ปุ่ม "${b.label}"`} → ${what}`)
      return { ok: true }
    } catch (e) {
      pushLog(state, `[PIN] (กดมือ) ล้มเหลว: ${e.message}`)
      return { ok: false, error: e.message }
    }
  }

  // คลิกช่องในหน้าต่าง: ถ้าส่งข้อความบนปุ่มมาด้วย จะหาช่องที่ข้อความตรงในหน้าต่าง "ตอนนี้" (เซิร์ฟเวอร์บางเจ้าสลับตำแหน่งเลขทุกครั้งที่กด)
  async function uiWindowClick(slot, label) {
    const w = bot && bot.currentWindow
    if (!w) return { ok: false, error: 'ไม่มีหน้าต่างเปิดอยู่' }
    pinManualUntil = Date.now() + 40000
    let s = Number(slot)
    const want = (label === undefined || label === null) ? '' : String(label)
    if (want) {
      const end = typeof w.inventoryStart === 'number' ? w.inventoryStart : (w.slots || []).length
      const cur = w.slots[s]
      if (!cur || itemLabel(cur) !== want) {
        s = -1
        for (let k = 0; k < end; k++) { if (w.slots[k] && itemLabel(w.slots[k]) === want) { s = k; break } }
        if (s < 0) return { ok: false, error: 'หน้าต่างเปลี่ยนแล้ว ไม่พบช่องนี้ ลองกดใหม่' }
      }
    }
    try { await withTimeout(bot.clickWindow(s, 0, 0), 3000) } catch {}
    pushLog(state, `[UI] (กดมือ) คลิกช่อง ${s}${want ? ` "${want}"` : ''} ในหน้าต่าง`)
    return { ok: true }
  }

  function uiWindowClose() {
    const w = bot && bot.currentWindow
    if (!w) return { ok: false, error: 'ไม่มีหน้าต่างเปิดอยู่' }
    try { bot.closeWindow(w) } catch (e) { return { ok: false, error: e.message } }
    return { ok: true }
  }

  function pinHold(ms) {
    pinManualUntil = Date.now() + (ms || 300000)
    if (pinRun) { pinRun.active = false; pinRun.settling = false; if (pinRun.wake) pinRun.wake() }
    pushLog(state, `[PIN] พักการกด PIN อัตโนมัติ ${Math.round((ms || 300000) / 1000)} วินาที — ใส่เองที่แดชบอร์ด`)
    return { ok: true }
  }
  function pinResume() {
    pinManualUntil = 0
    pushLog(state, '[PIN] ให้บอทกลับมากด PIN อัตโนมัติได้แล้ว')
    return { ok: true }
  }
  /* ---- end Server UI ---- */

  /* ---- PIN แบบ "หน้าต่างหีบ" (chest) — เดิมมีแต่ log ไม่มีโค้ดกดให้ ทำให้โหมดอัตโนมัติไม่ใส่ PIN ---- */
  let winPinTimer = null, winPinRunning = false, winPinCoolUntil = 0
  function winPadMap(w) {
    const map = {}
    try {
      const end = typeof w.inventoryStart === 'number' ? w.inventoryStart : (w.slots || []).length
      const byName = {}
      for (let i = 0; i < end; i++) {
        const it = w.slots[i]
        if (!it || /glass_pane|barrier/.test(String(it.name))) continue
        const label = String(itemLabel(it) || '').replace(/§./g, '').trim()
        let d = null
        if (/^[0-9]$/.test(label)) d = label
        else if (!/ล้าง|clear|reset|ลบ|back|del/i.test(label)) {
          const m = label.match(/(?:^|[^0-9])([0-9])(?:[^0-9]|$)/)
          if (m) d = m[1]
        }
        if (d !== null) { if (map[d] === undefined) map[d] = i; continue }
        ;(byName[it.name] = byName[it.name] || []).push({ i, n: it.count || 1 })
      }
      // เซิร์ฟเวอร์ที่ใช้ไอเทมซ้ำ (เช่น Name Tag) แล้วใช้ "จำนวน" เป็นตัวเลข: x1..x9 = 1..9, x10 = 0
      if (Object.keys(map).length < 10) {
        for (const k of Object.keys(byName)) {
          const m2 = {}
          for (const e of byName[k]) {
            const d = e.n === 10 ? '0' : (e.n >= 1 && e.n <= 9 ? String(e.n) : null)
            if (d !== null && m2[d] === undefined) m2[d] = e.i
          }
          if (Object.keys(m2).length === 10) return m2
        }
      }
    } catch {}
    return map
  }
  function winPadOk() { try { const w = bot && bot.currentWindow; return !!w && Object.keys(winPadMap(w)).length === 10 } catch { return false } }
  function pinBusy() { return !!(state.autoPin && Date.now() >= pinManualUntil && !pinWrong && pinSubmits < 2) }

  function scheduleWindowPin(w) {
    if (winPinRunning || Date.now() < winPinCoolUntil) return
    if (winPinTimer) { clearTimeout(winPinTimer); winPinTimer = null }
    if (!state.autoPin) return
    // ไอเทมในหีบมักมาหลังแพ็กเก็ต open — รออย่างน้อย 1 วิ + ดีเลย์ที่ตั้งไว้
    winPinTimer = setTimeout(() => {
      winPinTimer = null
      runWindowPin().catch(e => { winPinRunning = false; pushLog(state, `[PIN] (หน้าต่าง) error: ${e.message}`) })
    }, 1000 + (state.pinDelay || 0))
  }

  async function runWindowPin() {
    if (winPinRunning || !bot || !state.autoPin || Date.now() < pinManualUntil) return
    let w = bot.currentWindow
    if (!w) return
    const pin = String(state.loginPin || '')
    if (!/^[0-9]{4,8}$/.test(pin)) { pushLog(state, '[PIN] เซิร์ฟเวอร์เปิดหน้าต่าง แต่ยังไม่ได้ตั้ง PIN (ตัวเลข 4-8 หลัก) — ใส่ที่ Settings > PIN แล้วกด Save'); return }
    if (pinWrong) { pushLog(state, '[PIN] PIN ที่บันทึกไว้ถูกปฏิเสธแล้ว — ไม่กดซ้ำ (แก้ PIN แล้วกด Save)'); return }
    if (pinSubmits >= 2) { pushLog(state, '[PIN] กรอก PIN ไปแล้ว 2 รอบแต่ยังไม่ผ่าน — หยุดเพื่อกันโดนล็อก (เช็ค PIN → Save → กด "รีเซ็ตล็อก")'); return }
    let map = winPadMap(w)
    if (Object.keys(map).length < 10) { await sleep(1500); w = bot && bot.currentWindow; if (!w) return; map = winPadMap(w) }
    if (Object.keys(map).length < 10) {
      pushLog(state, `[PIN] หน้าต่าง "${uiWinTitle(w)}" ยังอ่านแป้นเลข 0-9 ไม่ครบ (เจอ ${Object.keys(map).length}/10) — ไม่กดมั่ว (ส่งบรรทัด [UI] ช่องในหน้าต่าง มาให้ปรับโค้ด)`)
      logWindowSlots(w)
      return
    }
    winPinRunning = true
    try {
      pushLog(state, `[PIN] (หน้าต่าง "${uiWinTitle(w)}") เจอแป้นเลข 0-9 แล้ว → เริ่มกด PIN ${pin.length} หลัก · ช่อง ${Object.keys(map).sort().map(k => k + '→#' + map[k]).join(' ')}`)
      for (let idx = 0; idx < pin.length; idx++) {
        if (!bot || Date.now() < pinManualUntil) { pushLog(state, '[PIN] (หน้าต่าง) หยุด — ผู้ใช้กดเองอยู่/บอทหลุด'); return }
        let cw = bot.currentWindow
        for (let t = 0; !cw && t < 20; t++) { await sleep(150); cw = bot && bot.currentWindow } // เซิร์ฟเวอร์อาจปิด-เปิดหน้าใหม่ทุกครั้งที่กด
        if (!cw) { pushLog(state, '[PIN] (หน้าต่าง) หน้าต่างปิดไปก่อนกดครบ'); return }
        const m = winPadMap(cw)
        const slot = m[pin[idx]]
        if (slot === undefined) { pushLog(state, `[PIN] (หน้าต่าง) ไม่พบปุ่มเลข ${pin[idx]} ในหน้าล่าสุด — หยุด`); return }
        try { await withTimeout(bot.clickWindow(slot, 0, 0), 3000) } catch {}
        pushLog(state, `[PIN] (หน้าต่าง) กดหลักที่ ${idx + 1}/${pin.length} (ช่อง #${slot})`)
        await sleep(500)
      }
      pinSubmits++
      pushLog(state, `[PIN] (หน้าต่าง) กดครบ ${pin.length} หลักแล้ว (รอบที่ ${pinSubmits}/2) — รอผลจากเซิร์ฟเวอร์`)
      await sleep(2500)
      const still = bot && bot.currentWindow && winPadMap(bot.currentWindow)
      if (still && Object.keys(still).length === 10) {
        pushLog(state, `[PIN] (หน้าต่าง) แป้นยังค้างอยู่หลังกดครบ — อาจ PIN ผิดหรือคลิกไม่เข้า (${pinSubmits}/2)`)
      } else pushLog(state, '[PIN] (หน้าต่าง) แป้นหายไปแล้ว — น่าจะผ่าน')
    } finally {
      winPinRunning = false
      winPinCoolUntil = Date.now() + 4000
    }
  }

  /* ---- TPA: มีคนขอเทเลพอร์ต (/tpa /tpahere) — มาได้ทั้งแบบ "หน้าต่าง" (ช่อง ยอมรับ/ปฏิเสธ) และแบบข้อความแชท ---- */
  let tpaPending = null, tpaLast = null, tpaWinTimer = null
  function tpaMake(from, kind, text, extra) {
    const now = Date.now()
    const token = require('crypto').randomBytes(12).toString('hex')
    tpaPending = Object.assign({ token, from, kind, text: String(text || '').slice(0, 300), at: now, status: 'pending' }, extra || {})
    actTokens.set(token, { type: 'tpa', botId: state.id, exp: now + 130000 })
    return tpaPending
  }
  function tpaWindowInfo(w) {
    const end = typeof w.inventoryStart === 'number' ? w.inventoryStart : (w.slots || []).length
    let acc = -1, den = -1, from = ''
    for (let i = 0; i < end; i++) {
      const it = w.slots[i]
      if (!it || /glass_pane|barrier/.test(String(it.name))) continue
      const l = String(itemLabel(it) || '').replace(/§./g, '').trim()
      if (acc < 0 && /ยอมรับ|accept/i.test(l)) { acc = i; continue }
      if (den < 0 && /ปฏิเสธ|deny|decline|reject/i.test(l)) { den = i; continue }
      if (!from && l) from = l // หัวผู้เล่น = ชื่อคนขอ
    }
    return (acc >= 0 && den >= 0) ? { acc, den, from, title: uiWinTitle(w) } : null
  }
  function scheduleTpaWindow() {
    if (tpaWinTimer) clearTimeout(tpaWinTimer)
    tpaWinTimer = setTimeout(() => {
      tpaWinTimer = null
      try { detectTpaWindow() } catch (e) { pushLog(state, `[TPA] error: ${e.message}`) }
    }, 700) // ไอเทมในหน้าต่างมาหลังแพ็กเก็ต open
  }
  function detectTpaWindow() {
    const w = bot && bot.currentWindow
    if (!w) return
    const info = tpaWindowInfo(w)
    if (!info) return
    const now = Date.now()
    if (tpaPending && tpaPending.via === 'window' && now - tpaPending.at < 5000) return
    const kind = /ไปหา|here/i.test(info.title) ? 'here' : 'to'
    const p = tpaMake(info.from, kind, `หน้าต่าง "${info.title}"`, { via: 'window' })
    pushLog(state, `[TPA] 📨 ${info.from || 'ผู้เล่น'} ${kind === 'here' ? 'ขอให้บอทไปหา (tpahere)' : 'ขอเทเลพอร์ตมาหาบอท'} — หน้าต่าง "${info.title}" ${state.autoTpa ? '→ ยอมรับอัตโนมัติ' : '→ รอเลือกที่เว็บ/Discord'}`)
    if (state.autoTpa) tpaRespond(p.token, true, true).catch(() => {})
  }
  function detectTpa(text) {
    const t = String(text).replace(/§./g, '').trim()
    if (!t || t.length > 500 || t[0] === '/') return
    const hereRe = /tpahere|tpa\s*here|teleport(?:ing)?\s+(?:you\s+)?to\s+(?:them|him|her)|wants?\s+you\s+to\s+teleport|ให้(?:คุณ|เรา|บอท)?\s*(?:วาป|เทเลพอร์ต|เทเล)\s*(?:ไป)?หา|ขอให้.{0,30}(?:วาป|เทเลพอร์ต)/i
    const toRe = /teleport\s+to\s+you|\btpa\b|ขอ\s*(?:วาป|เทเลพอร์ต)|(?:วาป|เทเลพอร์ต)\s*มา\s*หา/i
    const hintRe = /\/?(?:tpaccept|tpyes|tpdeny|tpno|tpcancel)\b/i
    const isHere = hereRe.test(t)
    const hint = hintRe.test(t)
    if (!isHere && !(toRe.test(t) && hint) && !(hint && /teleport|เทเลพอร์ต|วาป|request|คำขอ/i.test(t))) return
    let from = ''
    const mm = t.match(/([A-Za-z0-9_.]{3,16})\s+(?:has\s+requested|requested|wants|is\s+requesting|requests|ขอ|ส่งคำขอ|ต้องการ)/i)
      || t.match(/(?:from|จาก|by|โดย)\s*:?\s*([A-Za-z0-9_.]{3,16})/i)
    if (mm) from = mm[1]
    else {
      const stop = /^(tpa|tpahere|tpaccept|tpdeny|teleport|request|requested|you|them|type|use|click|to|accept|deny|has|from|server|the|your)$/i
      from = (t.match(/[A-Za-z0-9_]{3,16}/g) || []).find(x => !stop.test(x)) || ''
    }
    const now = Date.now()
    if (tpaPending && now - tpaPending.at < 8000 && (!from || tpaPending.from === from)) return // ซ้ำกับที่เพิ่งจับได้ (เช่นมาทั้งหน้าต่างและแชท)
    const p = tpaMake(from, isHere ? 'here' : 'to', t, { via: 'chat' })
    pushLog(state, `[TPA] ${isHere ? '📨 /tpahere' : '📨 คำขอเทเลพอร์ต'} จาก ${from || '?'} — "${t.slice(0, 120)}" ${state.autoTpa ? '→ ยอมรับอัตโนมัติ' : '→ รอเลือกที่เว็บ/Discord'}`)
    if (state.autoTpa) tpaRespond(p.token, true, true).catch(() => {})
  }
  function tpaState() {
    const out = { pending: null, last: (tpaLast && Date.now() - tpaLast.at < 120000) ? tpaLast : null }
    const p = tpaPending
    if (p && p.status === 'pending') {
      const left = Math.round((p.at + 120000 - Date.now()) / 1000)
      if (left <= 0) p.status = 'expired'
      else out.pending = { token: p.token, from: p.from, kind: p.kind, text: p.text, left }
    }
    return out
  }
  async function tpaRespond(token, accept, auto) {
    const p = tpaPending
    if (!p || p.token !== token) return { ok: false, error: 'คำขอนี้หมดอายุหรือถูกตอบไปแล้ว' }
    if (p.status !== 'pending') return { ok: false, error: p.status === 'accepted' ? 'ยอมรับไปแล้ว' : (p.status === 'denied' ? 'ปฏิเสธไปแล้ว' : 'คำขอหมดอายุแล้ว') }
    if (Date.now() - p.at > 125000) { p.status = 'expired'; return { ok: false, error: 'คำขอหมดอายุแล้ว' } }
    if (!bot || state.status !== 'online') return { ok: false, error: 'บอทไม่ได้ออนไลน์' }
    if (p.via === 'window') {
      const w = bot.currentWindow
      const info = w && tpaWindowInfo(w)
      if (!info) return { ok: false, error: 'หน้าต่างคำขอปิดไปแล้ว' }
      try { await withTimeout(bot.clickWindow(accept ? info.acc : info.den, 0, 0), 3000) } catch {}
    } else {
      try { bot.chat(accept ? TPA_ACCEPT_CMD : TPA_DENY_CMD) } catch (e) { return { ok: false, error: e.message } }
    }
    p.status = accept ? 'accepted' : 'denied'
    tpaLast = { from: p.from, status: p.status, auto: !!auto, at: Date.now() }
    pushLog(state, `[TPA] ${accept ? '✅ ยอมรับ' : '❌ ไม่ยอมรับ'}${auto ? 'อัตโนมัติ' : ''} คำขอจาก ${p.from || '?'}`)
    return { ok: true, accepted: !!accept }
  }

  /* ---- กรอก PIN ตามที่สั่ง (ใช้กับคำสั่ง Discord /hub pin) ---- */
  async function pinEnter(code) {
    const pin = String(code || state.loginPin || '').replace(/\D/g, '')
    if (!pin) return { ok: false, error: 'ไม่มี PIN — ใส่ code มาด้วย หรือบันทึก PIN ไว้ที่ Settings' }
    if (!bot || state.status !== 'online') return { ok: false, error: 'บอทไม่ได้ออนไลน์' }
    pinManualUntil = Date.now() + 60000 // กันบอทกดอัตโนมัติชนกับที่สั่ง
    if (pinRun) { pinRun.active = false; pinRun.settling = false; if (pinRun.wake) pinRun.wake() }
    if (winPinTimer) { clearTimeout(winPinTimer); winPinTimer = null }
    let done = 0
    for (const d of pin) {
      if (uiDialog && !uiDialog.closedAt) {
        const r = await uiDialogClick(0, d)
        if (!r || !r.ok) return { ok: false, error: `กดเลข ${d} ไม่สำเร็จ (กดไปแล้ว ${done}/${pin.length}): ${(r && r.error) || '?'}` }
      } else if (bot.currentWindow) {
        let map = winPadMap(bot.currentWindow)
        if (map[d] === undefined) { await sleep(700); map = bot.currentWindow ? winPadMap(bot.currentWindow) : {} }
        if (map[d] === undefined) return { ok: false, error: `ไม่พบปุ่มเลข ${d} ในหน้าต่าง (กดไปแล้ว ${done}/${pin.length})` }
        try { await withTimeout(bot.clickWindow(map[d], 0, 0), 3000) } catch {}
        await sleep(500)
      } else return { ok: false, error: done ? `หน้าต่างปิดไปแล้ว (กดไปแล้ว ${done}/${pin.length})` : 'ตอนนี้ไม่มีแป้น PIN ให้กด' }
      done++
    }
    pushLog(state, `[PIN] (สั่งจาก Discord) กดครบ ${pin.length} หลัก`)
    return { ok: true, count: pin.length }
  }

  const managed = {
    tpaState, tpaRespond, winPadOk, pinBusy, pinEnter,
    uiState,
    uiDialogClick,
    uiWindowClick,
    uiWindowClose,
    pinHold,
    state,
    manualMove, manualLook, manualStop, manualInteract, manualUse, manualDismount, controlState,
    startWalkNow: () => startWalk('กดปุ่มเอง'), setAutoWalk, setAutoClick, setAutoAttack,
    pinResume,
    resetPin: () => { if (pinWaitTimer) { clearTimeout(pinWaitTimer); pinWaitTimer = null }; pinManualLogged = false; pinSubmits = 0; pinCooldownUntil = 0; pinLatest = null; pinSoftFails = 0; pinWrong = false; if (pinRun) { pinRun.active = false; pinRun.settling = false; if (pinRun.wake) pinRun.wake() } },
    connect: () => {
      reconnectAttempts = 0
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
        reconnectTimeout = null
      }
      if (STOPPED_STATES.has(state.status)) {
        state.status = 'starting'
      }
      connect()
    },
    stop: () => {
      msa = null
      state.status = 'stopped'
      state.connectedAt = null
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
        reconnectTimeout = null
      }
      cleanupBot()
      pushLog(state, 'Bot stopped')
    },
    sendChat: (msg) => {
      if (bot && state.status === 'online') {
        const trimmed = msg.trim().substring(0, 256)
        if (trimmed) {
          bot.chat(trimmed)
          pushLog(state, `> ${trimmed}`)
        }
      } else {
        pushLog(state, `[FAILED] Bot offline, cannot send: ${msg}`)
      }
    },
    get bot() { return bot }
  }

  bots.set(state.id, managed)
  connect()
  if (state.autoAttack) attackLoop().catch(e => pushLog(state, `[ATTACK] error: ${e.message}`))
  scheduleSaveBots()
  return managed
}

/* ===========================
   WEB API & ROUTES
=========================== */

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    bots: bots.size
  })
})

app.get('/api/status/:id', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' })
  const managed = bots.get(id)
  if (!managed) return res.status(404).json({ error: 'Bot not found' })
  const { state, bot } = managed
  let inventory = []
  try {
    if (bot?.inventory && state.status === 'online') {
      const rawItems = bot.inventory.items()
      for (let i = 0; i < rawItems.length; i++) {
        const item = rawItems[i]
        if (item) {
          inventory.push({
            name: item.displayName || item.name || 'Unknown',
            count: item.count || 1
          })
        }
      }
    }
  } catch (err) {}
  res.json({
    id: state.id,
    status: state.status,
    uptime: getUptime(state),
    lastMessage: state.lastMessage,
    logs: state.logs.slice(0, 50),
    chat: (state.chat || []).slice(0, 60),
    ...(req.query && req.query.tech === '1' ? { tech: (state.tech || []).slice(0, 80) } : {}),
    ui: managed.uiState(),
    health: bot?.health ?? 0,
    food: bot?.food ?? 0,
    inventory,
    autoLogin: state.autoLogin,
    loginPassword: state.loginPassword ? '********' : '',
    autoPin: state.autoPin,
    pinDelay: state.pinDelay,
    webhookOn: state.webhookOn !== false,
    webhookOwn: !!state.webhookUrl,
    loginPin: state.loginPin ? '****' : '',
    autoCommands: state.autoCommands,
    autoServerSelect: state.autoServerSelect,
    serverSelectItem: state.serverSelectItem,
    autoEat: state.autoEat
  })
})

app.post('/bot/:id/command', async (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' })
  const managed = bots.get(id)
  if (!managed) return res.status(404).json({ error: 'Bot not found' })
  const cmd = req.body.cmd?.trim()
  if (!cmd) return res.status(400).json({ error: 'Empty command' })
  managed.sendChat(cmd)
  res.json({ success: true })
})

app.post('/add-bot', (req, res) => {
  const username = req.body.username?.trim()
  if (!username) {
    if (req.accepts('html')) return res.redirect('/?error=Username+required')
    return res.status(400).json({ error: 'Username required' })
  }
  const isPremium = req.body.accountType === 'premium'
  // Microsoft (ไอดีแท้): เก็บอีเมล/ชื่อบัญชีตามที่กรอก (ใช้เป็นคีย์แคช login) — Offline: ตัดเหลือชื่อในเกม 3-16 ตัวเหมือนเดิม
  const sanitized = isPremium
    ? username.replace(/[^a-zA-Z0-9_.@+\-]/g, '').substring(0, 100)
    : username.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').substring(0, 16)
  if (!sanitized) {
    if (req.accepts('html')) return res.redirect('/?error=Invalid+username')
    return res.status(400).json({ error: 'Invalid username' })
  }
  createManagedBot({
    username: sanitized,
    accountType: isPremium ? 'premium' : 'offline',
    autoLogin: false,
    loginPassword: '',
    autoCommands: []
  })
  if (req.accepts('html')) return res.redirect('/')
  res.json({ success: true })
})

app.post('/bot/:id/start', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (managed) managed.connect()
  res.redirect(`/bot/${id}`)
})

app.post('/bot/:id/stop', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (managed) managed.stop()
  res.redirect(`/bot/${id}`)
})

const uiRoute = (fn) => async (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (!managed) return res.sendStatus(404)
  try { res.json(await fn(managed, req.body || {})) } catch (e) { res.json({ ok: false, error: e.message }) }
}
app.post('/bot/:id/ui-dialog-click', uiRoute((m, b) => m.uiDialogClick(Number(b.i), b.label)))
app.post('/bot/:id/ui-window-click', uiRoute((m, b) => m.uiWindowClick(Number(b.slot), b.label)))
app.post('/bot/:id/ui-window-close', uiRoute((m) => m.uiWindowClose()))
app.post('/bot/:id/pin-hold', uiRoute((m) => m.pinHold(300000)))
app.post('/bot/:id/pin-resume', uiRoute((m) => m.pinResume()))
app.post('/bot/:id/pin-reset', uiRoute((m) => { m.resetPin(); pushLog(m.state, '[PIN] รีเซ็ตตัวนับ/ล็อกของ PIN แล้ว — บอทกดอัตโนมัติได้อีกครั้งในการเชื่อมต่อถัดไป (หรือตอนเซิร์ฟเวอร์ขอ PIN ครั้งหน้า)'); return { ok: true } }))
app.post('/bot/:id/webhook-test', uiRoute(async (m) => {
  const url = whUrlFor(m.state)
  if (!url) return { ok: false, error: 'ยังไม่ได้ตั้ง Webhook (ใส่ตัวรวมที่หน้า /config หรือใส่ของบอทตัวนี้)' }
  const r = await whEnqueue(url, () => whRequest('POST', url, whPayload({ color: WH_COLORS.info, title: '🔔 ทดสอบ webhook — ' + whLabel(m.state), description: 'ถ้าเห็นข้อความนี้ แปลว่า webhook ของบอทตัวนี้ทำงานปกติ' })))
  if (m.state._wh) m.state._wh.lastCard = 0
  return { ok: r.status >= 200 && r.status < 300, status: r.status, error: r.error }
}))
app.post('/bot/:id/webhook-clear', uiRoute((m) => { m.state.webhookUrl = ''; m.state.webhookMsgId = null; m.state.webhookMsgUrl = ''; scheduleSaveBots(); return { ok: true } }))

// ---- Manual control (แท็บ Control) ----
const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1'
app.post('/bot/:id/ctrl-move', uiRoute((m, b) => m.manualMove(b)))
app.post('/bot/:id/ctrl-look', uiRoute((m, b) => m.manualLook(b)))
app.post('/bot/:id/ctrl-stop', uiRoute((m) => m.manualStop()))
app.post('/bot/:id/ctrl-interact', uiRoute((m, b) => m.manualInteract(Number(b.id))))
app.post('/bot/:id/ctrl-use', uiRoute((m) => m.manualUse()))
app.post('/bot/:id/ctrl-dismount', uiRoute((m) => m.manualDismount()))
app.post('/bot/:id/ctrl-walk-npc', uiRoute((m) => m.startWalkNow()))
app.post('/bot/:id/tpa-respond', uiRoute((m, b) => m.tpaRespond(String(b.token || ''), truthy(b.accept))))
app.get('/api/tpa/:id', (req, res) => {
  const m = bots.get(Number(req.params.id))
  if (!m) return res.sendStatus(404)
  res.json(m.tpaState())
})
app.post('/bot/:id/auto-walk', uiRoute((m, b) => m.setAutoWalk(truthy(b.on))))
app.post('/bot/:id/auto-click', uiRoute((m, b) => m.setAutoClick(truthy(b.on))))
app.post('/bot/:id/auto-attack', uiRoute((m, b) => {
  const o = {}
  if (b.on !== undefined) o.on = truthy(b.on)
  if (b.delay !== undefined) o.delay = b.delay
  return m.setAutoAttack(o)
}))

// poll เบา ๆ สำหรับแผง Server UI (PIN) และแท็บ Control
app.get('/api/ui/:id', (req, res) => {
  const managed = bots.get(Number(req.params.id))
  if (!managed) return res.status(404).json({ error: 'Bot not found' })
  res.json(managed.uiState())
})
app.get('/api/ctrl/:id', (req, res) => {
  const managed = bots.get(Number(req.params.id))
  if (!managed) return res.status(404).json({ error: 'Bot not found' })
  res.json(managed.controlState())
})

app.post('/bot/:id/delete', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (managed) {
    managed.stop()
    bots.delete(id)
    saveBots()
  }
  if (req.accepts('html')) return res.redirect('/')
  res.json({ success: true })
})

app.post('/bot/:id/theme', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (!managed || !req.body.theme) return res.sendStatus(404)
  if (THEMES[req.body.theme]) {
    managed.state.theme = req.body.theme
    scheduleSaveBots()
    res.json({ success: true })
  } else {
    res.status(400).json({ error: 'Invalid theme' })
  }
})

app.post('/bot/:id/settings', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.sendStatus(400)
  const managed = bots.get(id)
  if (!managed) return res.sendStatus(404)
  const { autoLogin, loginPassword, loginPin, autoCommands, autoServerSelect, serverSelectItem, autoEat, pinMode, pinDelay, autoTpa, webhookOn, webhookUrl } = req.body
  // pinMode: 'auto' = บอทกด PIN เองหลังแป้นขึ้น · 'manual' = ผู้ใช้กดเองที่ Server UI (ยังรับค่า autoPin แบบเก่าด้วย)
  const autoPin = pinMode !== undefined ? (pinMode === 'auto') : req.body.autoPin
  let newWhUrl = null
  let warn = ''
  if (typeof webhookUrl === 'string' && webhookUrl.trim()) {
    newWhUrl = whNormalize(webhookUrl)
    // เดิม: webhook ผิดแล้ว return 400 ก่อนบันทึกอะไรเลย (รวมถึง PIN/ดีเลย์) แต่หน้าเว็บยังขึ้น "Saved" → ค่ากลับเป็นเดิมเอง
    if (!newWhUrl) warn = 'Webhook URL ไม่ถูกต้อง (ต้องเป็นลิงก์ webhook ของ Discord) — ข้ามช่องนี้ ส่วนค่าอื่นบันทึกแล้ว'
  }
  managed.state.autoLogin = autoLogin === 'true' || autoLogin === true || autoLogin === '1'
  managed.state.loginPassword = typeof loginPassword === 'string' ? loginPassword : ''
  if (autoPin !== undefined || loginPin !== undefined) {
    const newPin = typeof loginPin === 'string' ? loginPin.replace(/[^0-9]/g, '').slice(0, 8) : managed.state.loginPin
    const newAuto = autoPin === undefined ? managed.state.autoPin : (autoPin === 'true' || autoPin === true || autoPin === '1')
    if (newPin !== managed.state.loginPin || newAuto !== managed.state.autoPin) managed.resetPin() // เปลี่ยน PIN/เปิดใหม่ -> เริ่มนับครั้งที่กรอกใหม่
    managed.state.loginPin = newPin
    managed.state.autoPin = newAuto
  }
  if (pinDelay !== undefined && String(pinDelay).trim() !== '') managed.state.pinDelay = clampPinDelay(pinDelay) // ช่องว่าง = คงค่าเดิม (เดิมกลายเป็น 1500)
  if (autoTpa !== undefined) managed.state.autoTpa = autoTpa === true || autoTpa === 'true' || autoTpa === '1'
  if (webhookOn !== undefined) managed.state.webhookOn = webhookOn === true || webhookOn === 'true' || webhookOn === '1'
  if (newWhUrl && newWhUrl !== managed.state.webhookUrl) {
    managed.state.webhookUrl = newWhUrl
    managed.state.webhookMsgId = null
    if (managed.state._wh) managed.state._wh.lastCard = 0
  }
  managed.state.autoServerSelect = autoServerSelect === 'true' || autoServerSelect === true || autoServerSelect === '1'
  if (autoEat !== undefined) {
    managed.state.autoEat = autoEat === 'true' || autoEat === true || autoEat === '1'
  }
  if (typeof serverSelectItem === 'string' && serverSelectItem.trim()) {
    managed.state.serverSelectItem = serverSelectItem.trim().toLowerCase()
  }
  try {
    let parsed = autoCommands
    if (typeof autoCommands === 'string') {
      parsed = JSON.parse(autoCommands)
    }
    if (Array.isArray(parsed)) {
      managed.state.autoCommands = parsed
        .filter(cmd => cmd && typeof cmd.cmd === 'string' && cmd.cmd.trim())
        .map(cmd => ({
          delay: Math.max(0, Number(cmd.delay) || 2000),
          cmd: cmd.cmd.trim()
        }))
    } else {
      managed.state.autoCommands = []
    }
  } catch {
    managed.state.autoCommands = []
  }
  scheduleSaveBots()
  saveBots() // เขียนไฟล์ทันที ไม่รอ 1 วิ
  res.json({ success: true, warn })
})

app.get('/api/bots', (req, res) => {
  const summary = Array.from(bots.values()).map(({ state }) => ({
    id: state.id,
    username: state.originalUsername,
    status: state.status,
    uptime: getUptime(state),
    theme: state.theme
  }))
  res.json(summary)
})

// ✅ ข้อ 4: หน้าและ API สำหรับตั้งค่า Server
app.get('/config', (req, res) => {
  const escapedHost = escapeHtml(serverConfig.host)
  const escapedUser = escapeHtml(serverConfig.defaultUsername)
  const escapedVersion = escapeHtml(serverConfig.version || '')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Server Config – Galaxy Hub</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  ${BG_SCRIPT}${THEME_FX_SCRIPT}
  <nav class="navbar">
    <a href="/" class="back-link">← HUB</a>
    <div class="navbar-brand">⚙️ Server Configuration</div>
  </nav>
  <div class="page-wrap">
    <div class="glow-line"></div>
    <div class="panel" style="max-width:500px;margin:20px auto;">
      <div class="section-title">🌐 Minecraft Server</div>
      <form method="POST" action="/api/config" style="display:flex;flex-direction:column;gap:12px;">
        <div class="form-group">
          <label>Host / IP</label>
          <input class="input" name="host" value="${escapedHost}" required>
        </div>
        <div class="form-group">
          <label>Port</label>
          <input class="input" type="number" name="port" value="${serverConfig.port}" min="1" max="65535" required>
        </div>
        <div class="form-group">
          <label>Default Username</label>
          <input class="input" name="defaultUsername" value="${escapedUser}" maxlength="16">
        </div>
        <div class="form-group">
          <label>Game Version (ว่าง = auto, เช่น 26.2)</label>
          <input class="input" name="version" value="${escapedVersion}" maxlength="16" placeholder="auto">
        </div>
        <button class="btn btn-primary" type="submit">💾 Save & Reconnect All</button>
      </form>
      <div style="font-size:12px;color:var(--text-dim);margin-top:12px;">
        ⚠️ Saving will disconnect all bots and reconnect them to the new address.
      </div>
    </div>
    <div class="panel" style="max-width:500px;margin:20px auto;">
      <div class="section-title">📡 Self-Ping (กันเซิร์ฟเวอร์หลับ) — ทุก 5 นาที</div>
      <div class="form-group">
        <label>ลิงก์ที่ให้ยิงเอง (ว่าง = ใช้ค่าเริ่มต้น)</label>
        <input class="input" id="ka-url" placeholder="https://your-app.onrender.com" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="300">
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" type="button" id="ka-save">💾 บันทึก</button>
        <button class="btn btn-primary" type="button" id="ka-ping">⚡ ยิงทดสอบตอนนี้</button>
      </div>
      <div id="ka-info" style="font-size:12px;color:var(--text-dim);margin-top:12px;line-height:1.7;word-break:break-all;"></div>
      <div style="font-size:12px;color:var(--text-dim);margin-top:8px;">ใส่แค่โดเมน = ยิงไปที่ /health ให้เอง · ใส่ลิงก์เต็มก็ได้ · บันทึกแล้วไม่รีคอนเน็กต์บอท</div>
    </div>
    <div class="panel" style="max-width:500px;margin:20px auto;">
      <div class="section-title">💬 Discord Webhook — แจ้งสถานะบอท</div>
      <div class="form-group">
        <label>Webhook URL ตัวรวม (ใช้กับบอททุกตัวที่ไม่ได้ตั้งของตัวเอง)</label>
        <input class="input" id="wh-url" type="password" placeholder="https://discord.com/api/webhooks/..." autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="300">
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" type="button" id="wh-save">💾 บันทึก</button>
        <button class="btn btn-primary" type="button" id="wh-test">🧪 ทดสอบ</button>
        <button class="btn btn-warning" type="button" id="wh-clear">🗑 ลบ</button>
      </div>
      <div id="wh-info" style="font-size:12px;color:var(--text-dim);margin-top:12px;line-height:1.7;word-break:break-all;"></div>
      <div style="font-size:12px;color:var(--text-dim);margin-top:8px;line-height:1.7;">ส่งให้ <b>แยกบอทแต่ละตัว</b>: การ์ดสถานะ 1 ใบต่อบอท (แก้ข้อความเดิม ไม่ส่งซ้ำรัว ๆ) + แจ้งออนไลน์ / ออฟไลน์ / reconnect (แนบ log 10 บรรทัดล่าสุด) / โดนแบน / ล็อกอินไม่ผ่าน / โค้ด Microsoft · เปิด-ปิดและตั้ง webhook แยกรายบอทได้ที่ Settings ของบอทนั้น</div>
    </div>
    <script>
    (function(){
      function $(i){return document.getElementById(i)}
      function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
      function post(url,body){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})}
      function render(d){
        var h='ตัวรวม: <b>'+(d.set?esc(d.masked):'ยังไม่ได้ตั้ง')+'</b>';
        (d.bots||[]).forEach(function(b){
          var src=!b.on?'ปิดแจ้งเตือน':(b.source==='own'?'webhook ของบอทเอง':(b.source==='global'?'ใช้ตัวรวม':'ยังไม่มี webhook'));
          h+='<br>• '+esc(b.name)+' ['+esc(b.status)+'] — '+src;
        });
        $('wh-info').innerHTML=h;
      }
      function load(){fetch('/api/webhook').then(function(r){return r.json()}).then(render).catch(function(){})}
      $('wh-save').onclick=function(){
        post('/api/webhook',{url:$('wh-url').value}).then(function(x){
          if(!x.ok){alert(x.j.error||'บันทึกไม่สำเร็จ');return}
          $('wh-url').value='';load();
        }).catch(function(){alert('บันทึกไม่สำเร็จ')});
      };
      $('wh-test').onclick=function(){
        post('/api/webhook/test',{url:$('wh-url').value}).then(function(x){
          alert(x.j.ok?'ส่งทดสอบแล้ว ดูใน Discord':(x.j.error||('ส่งไม่สำเร็จ (HTTP '+x.j.status+')')));load();
        }).catch(function(){alert('ส่งไม่สำเร็จ')});
      };
      $('wh-clear').onclick=function(){
        if(!confirm('ลบ webhook ตัวรวม?'))return;
        post('/api/webhook',{clear:true}).then(function(){$('wh-url').value='';load()});
      };
      load();
    })();
    </script>
    <script>
    (function(){
      function $(i){return document.getElementById(i)}
      function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
      function render(d){
        var l=d.last||{};
        var t=l.at?new Date(l.at).toLocaleTimeString():'-';
        var st=l.status!=null?('HTTP '+l.status):(l.error?('ผิดพลาด: '+l.error):'ยังไม่เคยยิง');
        $('ka-info').innerHTML='ลิงก์ที่ใช้อยู่: <b>'+esc(d.effective)+'</b><br>ครั้งล่าสุด: '+esc(t)+' — '+esc(st)+'<br>ความถี่: ทุก '+esc(d.everyMin)+' นาที (ทำงานต่อเนื่องแม้ปิดหน้านี้)';
      }
      function load(first){
        fetch('/api/keepalive').then(function(r){return r.json()}).then(function(d){ if(first) $('ka-url').value=d.url||''; render(d) }).catch(function(){});
      }
      function ping(){
        return fetch('/api/keepalive/ping',{method:'POST'}).then(function(){ load(false) }).catch(function(){});
      }
      $('ka-save').onclick=function(){
        var b=$('ka-save'); b.disabled=true;
        fetch('/api/keepalive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:$('ka-url').value})})
          .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
          .then(function(x){
            if(!x.ok){ alert(x.j.error||'บันทึกไม่สำเร็จ'); return }
            $('ka-url').value=x.j.url||'';
            return ping();
          })
          .catch(function(){ alert('บันทึกไม่สำเร็จ') })
          .then(function(){ b.disabled=false });
      };
      $('ka-ping').onclick=function(){
        var b=$('ka-ping'); b.disabled=true;
        ping().then(function(){ b.disabled=false });
      };
      load(true);
    })();
    </script>
  </div>
</body>
</html>`)
})

app.post('/api/config', (req, res) => {
  const { host, port, defaultUsername, version } = req.body
  if (!host || !port) {
    return res.status(400).send('Host and port are required')
  }
  serverConfig.host = String(host).trim()
  serverConfig.port = Number(port) || 25565
  if (defaultUsername) serverConfig.defaultUsername = String(defaultUsername).trim()
  if (version !== undefined) serverConfig.version = String(version).trim()
  saveServerConfig()

  // Reconnect all bots
  bots.forEach(managed => {
    managed.stop()
    managed.connect()
  })

  if (req.accepts('html')) return res.redirect('/')
  res.json({ success: true })
})

/* ===========================
   THEME DEFINITIONS
=========================== */

// ธีม: ฝั่ง JS เก็บเฉพาะที่ใช้ทำปุ่ม/การ์ดแบบ inline (ชื่อ + สีเน้น). สีทั้งหมดของแต่ละธีม (พื้นหลัง/แผง/ขอบ/ตัวอักษร)
// อยู่ใน styles.css เป็น html[data-theme="<key>"] — เพิ่มธีมใหม่ต้องเพิ่มทั้งตรงนี้และใน styles.css
const THEMES = {
  galaxy: { name: '🌌 Galaxy', accent1: '#a855f7', accent2: '#3b82f6', glow: '#a855f7' },
  nebula: { name: '🔴 Nebula', accent1: '#f43f5e', accent2: '#fb923c', glow: '#f43f5e' },
  matrix: { name: '💚 Matrix', accent1: '#00ff41', accent2: '#00cc33', glow: '#00ff41' },
  ocean: { name: '🌊 Ocean', accent1: '#06b6d4', accent2: '#0ea5e9', glow: '#06b6d4' },
  gold: { name: '👑 Gold', accent1: '#f59e0b', accent2: '#fcd34d', glow: '#f59e0b' },
  pixel: { name: '👾 Pixel 18-bit', accent1: '#60b89c', accent2: '#7888dc', glow: '#60b89c' },
  forest: { name: '🍃 Forest', accent1: '#2fbf71', accent2: '#f4a259', glow: '#52b788' },
  cyber: { name: '⚡ Cyber Pixel', accent1: '#22d3ee', accent2: '#e879f9', glow: '#22d3ee' }
}




const ITEM_ICONS = {
  sword: '⚔️', axe: '🪓', pickaxe: '⛏️', shovel: '🔧', hoe: '🌾',
  bow: '🏹', crossbow: '🏹', trident: '🔱', shield: '🛡️',
  helmet: '⛑️', chestplate: '🦺', leggings: '👖', boots: '👢',
  apple: '🍎', bread: '🍞', steak: '🥩', chicken: '🍗', fish: '🐟',
  salmon: '🐟', cod: '🐟', carrot: '🥕', potato: '🥔',
  mushroom: '🍄', cake: '🎂', cookie: '🍪', melon: '🍉', pumpkin: '🎃',
  diamond: '💎', emerald: '💚', gold: '🟡', iron: '🔩', coal: '🪨',
  netherite: '🖤', wood: '🪵', log: '🪵', plank: '🪵', stick: '🥢',
  stone: '🪨', cobblestone: '🪨', gravel: '🪨', sand: '🏖️',
  glass: '🔮', wool: '🧶', leather: '🟫',
  torch: '🔦', lantern: '🏮', chest: '📦', book: '📚',
  enchanted_book: '✨', paper: '📄', feather: '🪶', ink: '🖊️',
  arrow: '➶', flint: '💠', string: '🧵', slimeball: '🟢',
  blaze_rod: '🔥', ender_pearl: '🔮', eye_of_ender: '👁️',
  nether_star: '⭐', beacon: '🔆', compass: '🧭', clock: '🕐',
  map: '🗺️', bucket: '🪣', water_bucket: '💧', lava_bucket: '🌋',
  potion: '🧪', splash_potion: '💥', lingering_potion: '🌀',
  experience_bottle: '✨', golden_apple: '🍎', totem: '🗿',
  elytra: '🦋', firework: '🎆', egg: '🥚', snowball: '❄️',
  bone: '🦴', gunpowder: '💣', tnt: '💣', redstone: '🔴',
  glowstone: '💡', quartz: '🔷', prismarine: '🔵',
  default: '📦'
}

const SORTED_ITEM_KEYS = Object.keys(ITEM_ICONS)
  .filter(k => k !== 'default')
  .sort((a, b) => b.length - a.length)

function getItemIcon(itemName) {
  if (!itemName) return ITEM_ICONS.default
  const lower = itemName.toLowerCase()
  for (let i = 0; i < SORTED_ITEM_KEYS.length; i++) {
    if (lower.includes(SORTED_ITEM_KEYS[i])) return ITEM_ICONS[SORTED_ITEM_KEYS[i]]
  }
  return ITEM_ICONS.default
}

/* ===========================
   HTML TEMPLATE PARTS
=========================== */

const BG_SCRIPT = `
<canvas id="stars-canvas" style="position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;opacity:var(--show-stars,1);"></canvas>
<script>
(function(){
  var c = document.getElementById('stars-canvas');
  if (!c) return;
  var ctx = c.getContext('2d');
  var W, H;
  function resize(){ W = c.width = window.innerWidth; H = c.height = window.innerHeight; }
  resize(); window.addEventListener('resize', resize);
  var stars = [];
  for (var i = 0; i < 120; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.5 + 0.2,
      a: Math.random() * 0.7 + 0.1,
      s: Math.random() * 0.003 + 0.001
    });
  }
  var then = Date.now();
  function draw() {
    var now = Date.now();
    then = now;
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.a += Math.sin(now * s.s) * 0.002;
      s.a = s.a < 0.05 ? 0.05 : (s.a > 0.8 ? 0.8 : s.a);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + s.a + ')';
      ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  draw();
})();
</script>
`

const THEME_FX_SCRIPT = String.raw`
<script>
(function(){
  var theme = document.documentElement.getAttribute('data-theme');
  if (theme !== 'forest' && theme !== 'cyber') return;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var AC = window.AudioContext || window.webkitAudioContext, ctx = null, master = null, muted = false, lastSnd = -1;
  try { muted = localStorage.getItem('fxMuted') === '1'; } catch (e) {}
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function audio() {
    if (!AC || muted) return null;
    if (!ctx) {
      try { ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination); }
      catch (e) { AC = null; return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(type, f0, f1, t, dur, peak, dest, attack) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || master);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(t, dur, peak, type, f0, f1, q) {
    var n = Math.floor(ctx.sampleRate * dur), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    var s = ctx.createBufferSource(); s.buffer = buf;
    var f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    f.Q.value = q || 1;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.04, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t); s.stop(t + dur + 0.02);
  }

  /* ---- เสียงธีม Forest: นก / น้ำ / ลม / เหยียบใบไม้ (สุ่มทุกครั้งที่กด) ---- */
  function bird() {
    var t = ctx.currentTime, n = 2 + Math.floor(Math.random() * 3), base = rnd(2300, 3600);
    for (var i = 0; i < n; i++) {
      var st = t + i * rnd(0.09, 0.14), up = Math.random() < 0.5;
      var a = up ? base : base * 1.35, b = up ? base * 1.35 : base * 0.9;
      tone('sine', a, b, st, 0.09, 0.13, null, 0.015);
      tone('sine', a * 2, b * 2, st, 0.07, 0.025, null, 0.01);
    }
  }
  function water() {
    var t = ctx.currentTime;
    tone('sine', 420, 1300, t, 0.14, 0.2, null, 0.01);
    tone('sine', 520, 1500, t + rnd(0.1, 0.18), 0.11, 0.11, null, 0.01);
    noise(t, 0.18, 0.04, 'bandpass', 2400, 1800, 2);
  }
  function wind() {
    noise(ctx.currentTime, rnd(0.45, 0.7), 0.16, 'bandpass', rnd(250, 400), rnd(700, 1100), 0.8);
  }
  function leaf() {
    var t = ctx.currentTime, n = 4 + Math.floor(Math.random() * 4);
    for (var i = 0; i < n; i++) noise(t + i * rnd(0.02, 0.05), rnd(0.02, 0.05), rnd(0.12, 0.25), 'highpass', rnd(2500, 5000), 0, 0.7);
  }
  /* ---- เสียงธีม Cyber: โน้ตนุ่ม ๆ สไตล์ซินธ์ (เพนทาโทนิก ฟังไม่แสบหู) ---- */
  var SCALE = [523.25, 587.33, 659.25, 783.99, 880, 987.77, 1174.66];
  function cyber() {
    var t = ctx.currentTime, f = pick(SCALE);
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2800; lp.connect(master);
    tone('triangle', f, f * 1.04, t, 0.2, 0.16, lp, 0.006);
    tone('sine', f * 2, f * 2, t + 0.05, 0.22, 0.06, lp, 0.01);
    tone('sine', f * 1.5, f * 1.5, t + 0.1, 0.25, 0.04, lp, 0.01);
    noise(t, 0.03, 0.03, 'highpass', 6000, 0, 0.7);
  }
  var SOUNDS = theme === 'forest' ? [bird, water, wind, leaf] : [cyber];
  function play() {
    if (!audio()) return;
    var i = Math.floor(Math.random() * SOUNDS.length);
    if (SOUNDS.length > 1 && i === lastSnd) i = (i + 1) % SOUNDS.length;
    lastSnd = i;
    try { SOUNDS[i](); } catch (e) {}
  }

  /* ---- เอฟเฟกต์ตอนกด: ใบไม้ปลิว (forest) / พิกเซลแตก (cyber) ---- */
  var LEAVES = ['🍃', '🌿', '🍀', '🍂'];
  function burst(x, y) {
    if (reduce) return;
    var n = theme === 'forest' ? 6 : 12;
    for (var i = 0; i < n; i++) {
      var el = document.createElement('span');
      el.className = theme === 'forest' ? 'fx-leaf' : 'fx-px';
      if (theme === 'forest') el.textContent = pick(LEAVES);
      else el.style.background = pick(['#22d3ee', '#e879f9', '#a3e635', '#f8fafc']);
      var ang = rnd(0, Math.PI * 2), dist = rnd(30, 80);
      el.style.left = x + 'px'; el.style.top = y + 'px';
      el.style.setProperty('--dx', (Math.cos(ang) * dist) + 'px');
      el.style.setProperty('--dy', (Math.sin(ang) * dist + (theme === 'forest' ? 30 : 0)) + 'px');
      el.style.setProperty('--rot', rnd(-200, 200) + 'deg');
      document.body.appendChild(el);
      setTimeout((function(e){ return function(){ if (e.parentNode) e.parentNode.removeChild(e); }; })(el), 800);
    }
  }
  var SEL = 'button, .btn, .tab-btn, .theme-btn, .kp-btn, .ctl-btn, .btn-manage, .bot-card, select, .toggle-slider, input[type=checkbox]';
  document.addEventListener('pointerdown', function(e) {
    var el = e.target && e.target.closest ? e.target.closest(SEL) : null;
    if (!el || el.disabled || el.id === 'fx-mute') return;
    play(); burst(e.clientX, e.clientY);
    el.classList.remove('fx-press'); void el.offsetWidth; el.classList.add('fx-press');
    setTimeout(function(){ el.classList.remove('fx-press'); }, 360);
  }, true);

  function init() {
    var b = document.body; if (!b) return;
    if (theme === 'forest' && !reduce) {
      for (var i = 0; i < 12; i++) {
        var s = document.createElement('span'); s.className = 'fx-fall'; s.textContent = pick(LEAVES);
        s.style.left = rnd(0, 100) + 'vw'; s.style.fontSize = rnd(16, 28) + 'px';
        s.style.animationDuration = rnd(11, 22) + 's'; s.style.animationDelay = (-rnd(0, 20)) + 's';
        s.style.setProperty('--sway', rnd(-80, 80) + 'px');
        b.appendChild(s);
      }
    }
    if (theme === 'cyber') { var sc = document.createElement('div'); sc.className = 'fx-scan'; b.appendChild(sc); }
    var m = document.createElement('button'); m.id = 'fx-mute'; m.type = 'button'; m.title = 'เปิด/ปิดเสียงเอฟเฟกต์';
    m.textContent = muted ? '🔇' : '🔊';
    m.addEventListener('click', function() {
      muted = !muted; m.textContent = muted ? '🔇' : '🔊';
      try { localStorage.setItem('fxMuted', muted ? '1' : '0'); } catch (e) {}
      if (!muted && audio()) { try { SOUNDS[0](); } catch (e) {} }
    });
    b.appendChild(m);
  }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
</script>
`

// Home page
app.get('/', (req, res) => {
  const allBots = [...bots.values()]
  const online = allBots.filter(b => b.state.status === 'online').length
  const total = allBots.length

  const cardParts = []
  for (let i = 0; i < allBots.length; i++) {
    const { state } = allBots[i]
    const t = THEMES[state.theme] || THEMES.galaxy
    const escapedName = escapeHtml(state.username)
    const escapedMsg = escapeHtml(state.lastMessage || '-')
    const shortMsg = escapedMsg.length > 24 ? escapedMsg.substring(0, 24) + '…' : escapedMsg
    const uptime = getUptime(state)

    cardParts.push(`
    <div class="bot-card" id="bot-card-${state.id}" style="--glow: ${t.glow}; --glow-dim: ${t.glow}22;">
      <div class="bot-card-header">
        <div class="bot-avatar" style="background: linear-gradient(135deg, ${t.accent1}44 0%, ${t.accent2}22 50%, ${t.accent1}33 100%); --glow: ${t.glow};">🤖</div>
        <div>
          <div class="bot-name">${escapedName}</div>
          <div class="bot-type">${state.accountType === 'premium' ? '🔑 Microsoft' : '🔓 Offline'}</div>
        </div>
        <div style="margin-left:auto;">
          <div id="badge-${state.id}" class="badge badge-${state.status}">${state.status}</div>
        </div>
      </div>
      <div class="bot-card-body">
        <div class="stat-row"><span>⏱ Uptime</span><strong id="uptime-${state.id}">${uptime}</strong></div>
        <div class="stat-row"><span>💬 Last msg</span><strong style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapedMsg}">${shortMsg}</strong></div>
        <div class="stat-row" style="margin-top:4px;">
          <span style="font-size:10px;color:${t.accent1};opacity:0.7;">● ${t.name}</span>
          <span style="font-size:10px;color:var(--text-dim);">${state.autoLogin ? '🔐 auto-login' : ''}${state.autoCommands && state.autoCommands.length ? ' ⚡'+state.autoCommands.length+' cmds' : ''}</span>
        </div>
      </div>
      <div class="bot-card-footer">
        <a href="/bot/${state.id}" class="btn-manage" style="background:linear-gradient(135deg,${t.accent2},${t.accent1});">MANAGE CONTROL →</a>
        <button class="btn-delete-card" onclick="confirmDelete(${state.id},'${escapedName}')">🗑 DELETE BOT</button>
      </div>
    </div>`)
  }
  const cards = cardParts.join('')

  // ✅ ข้อ 4: ลิงก์ไป Server Config
  const serverConfigLink = `<a href="/config" style="margin-left:12px;font-size:13px;color:var(--accent1);">⚙️ Server</a>`

  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>🌌 Galaxy AFK Hub</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  ${BG_SCRIPT}${THEME_FX_SCRIPT}
  
  <div class="modal-overlay" id="delete-modal">
    <div class="modal-box">
      <h3>🗑 Delete Bot?</h3>
      <p id="modal-msg">Are you sure you want to delete this bot?<br>This action cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-danger" id="modal-confirm-btn">Delete</button>
        <button class="btn btn-success" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  </div>

  <nav class="navbar">
    <div class="navbar-brand">🌌 GALAXY AFK HUB</div>
    <div class="navbar-stats">
      <div>Bots: <span>${total}</span></div>
      <div>Online: <span>${online}</span></div>
      ${serverConfigLink}
    </div>
  </nav>

  <div class="page-wrap">
    <div class="glow-line"></div>

    <div class="panel" style="margin-bottom:20px;">
      <div class="section-title">⊕ ADD NEW BOT</div>
      <form method="POST" action="/add-bot">
        <div class="add-form">
          <div class="form-group">
            <label>Username / Email</label>
            <input class="input" name="username" placeholder="Offline: ชื่อ 3-16 ตัว · Microsoft: อีเมล" required maxlength="100" autocomplete="off" autocapitalize="none" spellcheck="false" />
          </div>
          <div class="form-group">
            <label>Account Type</label>
            <select class="input select" name="accountType">
              <option value="offline">🔓 Offline</option>
              <option value="premium">🔑 Microsoft</option>
            </select>
          </div>
          <div class="form-group" style="justify-content:flex-end;">
            <button class="btn btn-primary" type="submit">ADD BOT</button>
          </div>
        </div>
      </form>
    </div>

    <div class="section-title">🤖 ACTIVE BOTS</div>
    <div class="bot-grid" id="bot-grid">
      ${cards || '<div style="color:var(--text-dim);font-size:14px;padding:20px 0;">No bots found. Add one above.</div>'}
    </div>
  </div>

  <script>
    var deleteTarget = null;
    function confirmDelete(id,name) {
      deleteTarget = id;
      document.getElementById('modal-msg').innerHTML = 'Delete <strong>' + name + '</strong>?<br>This cannot be undone.';
      document.getElementById('delete-modal').classList.add('open');
      document.getElementById('modal-confirm-btn').onclick = function() {
        if (deleteTarget) fetch('/bot/'+deleteTarget+'/delete',{method:'POST'}).then(function(){location.reload()});
        closeModal();
      };
    }
    function closeModal() {
      document.getElementById('delete-modal').classList.remove('open');
      deleteTarget = null;
    }
    document.getElementById('delete-modal').addEventListener('click',function(e) {
      if (e.target === this) closeModal();
    });

    var pollTimer = null;
    function pollStatus() {
      fetch('/api/bots')
        .then(function(r){ return r.json() })
        .then(function(bots){
          for (var i = 0; i < bots.length; i++) {
            var b = bots[i];
            var badge = document.getElementById('badge-' + b.id);
            if (badge) { badge.textContent = b.status; badge.className = 'badge badge-' + b.status; }
            var uptime = document.getElementById('uptime-' + b.id);
            if (uptime) uptime.textContent = b.uptime;
          }
        })
        .catch(function(){});
      pollTimer = setTimeout(pollStatus, 3000);
    }
    pollStatus();
  </script>
</body></html>`)
})

// ==================== BOT DETAIL PAGE WITH TABS (PROPERLY WORKING) ====================
app.get('/bot/:id', (req, res) => {
  const id = Number(req.params.id)
  if (isNaN(id)) return res.redirect('/')
  
  const managed = bots.get(id)
  if (!managed) return res.redirect('/')
  
  const { state } = managed
  const t = THEMES[state.theme] || THEMES.galaxy
  const escapedName = escapeHtml(state.username)
  const escapedPass = escapeHtml(state.loginPassword)
  const escapedPin = escapeHtml(state.loginPin || '')

  const themeKeys = Object.keys(THEMES)
  const themeButtonParts = []
  for (let i = 0; i < themeKeys.length; i++) {
    const key = themeKeys[i]
    const th = THEMES[key]
    const isActive = key === state.theme
    themeButtonParts.push(`<button class="theme-btn ${isActive ? 'active' : ''}" onclick="setTheme('${key}')" style="background:linear-gradient(135deg,${th.accent1}22,${th.accent2}22);color:${th.accent1};border-color:${isActive ? th.accent1 : 'transparent'};">${th.name}</button>`)
  }
  const themeButtons = themeButtonParts.join('')

  const initCmds = JSON.stringify(state.autoCommands || [])
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')

  res.send(`<!DOCTYPE html>
<html lang="th" data-theme="${state.theme in THEMES ? state.theme : 'galaxy'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${escapedName} – Galaxy Hub</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="page-bot">
  ${BG_SCRIPT}${THEME_FX_SCRIPT}

  <div class="modal-overlay" id="delete-modal">
    <div class="modal-box">
      <h3>🗑 Delete Bot?</h3>
      <p>Delete <strong>${escapedName}</strong>?<br>This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-danger" onclick="deleteBotNow()">Delete</button>
        <button class="btn btn-success" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast">✅ Settings Saved</div>

  <nav class="navbar">
    <a href="/" class="back-link">← HUB</a>
    <div class="navbar-brand" style="font-size:clamp(12px,2.5vw,18px);">${escapedName}</div>
    <div id="nav-badge" class="badge badge-${state.status}">${state.status}</div>
  </nav>

  <div class="page-wrap">
    <div class="glow-line"></div>
    
    <!-- Info Header (always visible) -->
    <div class="panel bot-info-panel" style="margin-bottom: 20px;">
      <div class="bot-info-header">
        <div class="bot-avatar bot-avatar-lg" style="background:linear-gradient(135deg,${t.accent1}44 0%,${t.accent2}22 50%,${t.accent1}33 100%);--glow:${t.glow};">🤖</div>
        <div class="bot-info-details">
          <div class="bot-info-name">${escapedName}</div>
          <div class="bot-info-type">${state.accountType === 'premium' ? '🔑 Microsoft Account' : '🔓 Offline Mode'}</div>
          <div style="font-size:12px;color:var(--text-dim);margin-top:4px;">${escapeHtml(serverConfig.host)}:${serverConfig.port}</div>
        </div>
        <div id="nav-badge-lg" class="badge badge-${state.status}" style="align-self:flex-start;margin-left:auto;">${state.status}</div>
      </div>
      <div class="divider"></div>
      <div class="info-stats-row">
        <div class="info-stat">
          <div class="info-stat-label">⏱ Uptime</div>
          <div class="info-stat-value" id="stat-uptime">-</div>
        </div>
        <div class="info-stat">
          <div class="info-stat-label">❤️ Health</div>
          <div class="info-stat-value hp-color" id="stat-hp">0</div>
        </div>
        <div class="info-stat">
          <div class="info-stat-label">🍖 Food</div>
          <div class="info-stat-value food-color" id="stat-food">0</div>
        </div>
      </div>
    </div>

    <!-- Tab Navigation -->
    <div class="tab-nav" id="tab-nav">
      <button class="tab-btn active" data-tab="dashboard">📊 Dashboard</button>
      <button class="tab-btn" data-tab="control">🕹 Control</button>
      <button class="tab-btn" data-tab="chat">💬 Chat</button>
      <button class="tab-btn" data-tab="inventory">🎒 Inventory</button>
      <button class="tab-btn" data-tab="settings">⚙️ Settings</button>
    </div>

    <!-- Tab Contents -->
    <div class="tab-content active" id="tab-dashboard">
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="panel" id="tpa-panel" style="display:none;border-color:rgba(56,189,248,0.6);">
          <div class="section-title" style="font-size:13px;">📨 มีคำขอเทเลพอร์ต</div>
          <div id="tpa-text" style="font-size:14px;margin-bottom:6px;"></div>
          <div id="tpa-raw" style="font-size:11px;color:var(--text-dim);word-break:break-word;margin-bottom:10px;"></div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-success" style="flex:1;" onclick="tpaAnswer(true)">✅ ยอมรับ</button>
            <button class="btn btn-danger" style="flex:1;" onclick="tpaAnswer(false)">❌ ไม่ยอมรับ</button>
          </div>
        </div>

        <div class="panel" id="ui-panel" style="display:none;border-color:rgba(250,204,21,0.45);">
          <div class="section-title" style="font-size:13px;">🔐 SERVER UI — กดเองได้ (PIN / เมนู)</div>
          <div id="ui-loading-box" style="display:none;text-align:center;padding:6px 0 10px;">
            <div class="ui-spin"></div>
            <div id="ui-loading-text" class="ui-text"></div>
            <button id="ui-showpad" type="button" class="kp-hold" style="display:none;">แสดงแป้นเดิม (ถ้าหน้าจริงไม่ขึ้น)</button>
          </div>
          <div id="ui-dialog-box" style="display:none;">
            <div id="ui-text" class="ui-text"></div>
            <div id="ui-dots" class="ui-dots" style="display:none;"></div>
            <div id="ui-left" class="ui-left" style="display:none;"></div>
            <div id="kp-grid" class="kp-grid" style="display:none;"></div>
            <div id="ui-extra" class="kp-grid" style="display:none;"></div>
            <button id="ui-exit" type="button" class="kp-exit" style="display:none;"></button>
            <button id="ui-hold" type="button" class="kp-hold"></button>
          </div>
          <div id="ui-window-box" style="display:none;"></div>
        </div>

        <div class="panel">
          <div class="section-title" style="font-size:13px;">⚡ QUICK CONTROLS</div>
          <form method="POST" action="/bot/${state.id}/start" style="margin-bottom:10px;">
            <button class="btn btn-success btn-block" type="submit">▶ START BOT</button>
          </form>
          <form method="POST" action="/bot/${state.id}/stop" style="margin-bottom:10px;">
            <button class="btn btn-danger btn-block" type="submit">⏹ STOP BOT</button>
          </form>
        </div>

        <div class="panel">
          <div class="section-title" style="font-size:13px;">🎨 THEME</div>
          <div class="theme-picker" id="theme-picker">${themeButtons}</div>
        </div>

        <div class="panel" style="background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);">
          <button class="btn btn-block" onclick="document.getElementById('delete-modal').classList.add('open')" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444;font-size:13px;">🗑 DELETE THIS BOT</button>
        </div>
      </div>
    </div>

    <div class="tab-content" id="tab-control">
      <div class="panel">
        <div class="section-title">🎮 CONTROL (บังคับเอง)</div>
        <div id="ctl-status" style="font-size:13px;margin-bottom:4px;">กำลังโหลด…</div>
        <div id="ctl-pos" style="font-size:12px;color:var(--text-dim);margin-bottom:12px;word-break:break-word;"></div>

        <div class="ctl-sub">🚶 เดิน (กดค้าง = เดิน · ปล่อย = หยุด · คีย์บอร์ด W A S D / Space)</div>
        <div class="mv-pad">
          <span></span>
          <button type="button" class="btn mv-btn" data-mv="forward">▲ <small>W</small></button>
          <span></span>
          <button type="button" class="btn mv-btn" data-mv="left">◀ <small>A</small></button>
          <button type="button" class="btn mv-btn" data-mv="back">▼ <small>S</small></button>
          <button type="button" class="btn mv-btn" data-mv="right">▶ <small>D</small></button>
          <button type="button" class="btn mv-btn" onclick="toggleMv('sprint', this)">วิ่ง</button>
          <button type="button" class="btn mv-btn" data-mv="jump">กระโดด</button>
          <button type="button" class="btn mv-btn" onclick="toggleMv('sneak', this)">ย่อ</button>
        </div>
        <button type="button" class="btn btn-sm" style="background:rgba(239,68,68,0.25);width:100%;max-width:320px;margin-bottom:14px;" onclick="ctrlStop()">■ หยุดทุกอย่าง</button>
        <div class="ctl-sub">🤖 เดินไปหา NPC อัตโนมัติ (หลังใส่ PIN เสร็จ)</div>
        <div class="ctl-row">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" id="autowalk-on" ${state.autoWalk ? 'checked' : ''} onchange="setAutoWalk(this.checked)"> เปิดใช้</label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" id="autoclick-on" ${state.autoClick ? 'checked' : ''} onchange="setAutoClick(this.checked)"> คลิกขวา NPC เองเมื่อเดินถึง</label>
          <button type="button" class="btn btn-sm btn-primary" onclick="ctrlPost('/ctrl-walk-npc', {})">เดินไปหา NPC ตอนนี้</button>
        </div>
        <div id="walk-status" style="font-size:11px;color:var(--text-dim);margin-bottom:14px;"></div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:14px;">วิ่งทำงานตอนกดเดินหน้า · ถ้าเน็ตหลุด/ปิดหน้านี้ บอทจะหยุดเดินเองภายใน ~1 วิ · ผลขึ้นในแท็บ Chat (บรรทัด [CTRL])</div>

        <div class="ctl-sub">⚔️ ตีคลิกซ้ายอัตโนมัติ (ตีไปข้างหน้าตามที่บอทหันอยู่)</div>
        <div class="ctl-row">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" id="atk-on" ${state.autoAttack ? 'checked' : ''} onchange="saveAttack()"> เปิดใช้</label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;">ดีเลย์ <input type="number" id="atk-delay" class="input input-sm" min="50" max="60000" step="50" value="${state.attackDelay}" style="width:90px;" onchange="saveAttack()"> ms</label>
        </div>
        <div id="atk-status" style="font-size:11px;color:var(--text-dim);margin-bottom:14px;">ตีไปข้างหน้าเฉย ๆ ไม่เลือกเป้าหมาย — หันบอทไปทางที่ต้องการเองด้วยปุ่มในส่วน 👀 หัน</div>

        <div class="ctl-sub">👀 หัน (ปรับเอง)</div>
        <div class="ctl-row">
          <button type="button" class="btn btn-sm" onclick="ctrlLook({dyaw:-lookStep()})">◀</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({dyaw:lookStep()})">▶</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({dpitch:lookStep()})">▲</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({dpitch:-lookStep()})">▼</button>
          <select id="look-step" class="input input-sm"><option value="5">5°</option><option value="15" selected>15°</option><option value="45">45°</option><option value="90">90°</option></select>
        </div>
        <div class="ctl-row">
          <button type="button" class="btn btn-sm" onclick="ctrlLook({face:'N'})">N เหนือ</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({face:'E'})">E ตะวันออก</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({face:'S'})">S ใต้</button>
          <button type="button" class="btn btn-sm" onclick="ctrlLook({face:'W'})">W ตะวันตก</button>
        </div>

        <div class="ctl-sub">🖱 คลิกขวา</div>
        <div class="ctl-row">
          <button type="button" class="btn btn-sm" onclick="ctrlUse()">ของในมือ</button>
          <button type="button" class="btn btn-sm" onclick="ctrlDismount()">ลงจากพาหนะ</button>
        </div>
      </div>

      <div class="panel" style="margin-top:16px;">
        <div class="section-title">🧍 NPC / ENTITY ใกล้ตัว (พร้อมตำแหน่ง)</div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;">ใต้ชื่อแต่ละตัวคือพิกัด X Y Z + ทิศ/องศาเทียบกับที่บอทหันอยู่ (เดินไปหาเองแล้วกด 🖱 คลิกขวาเมื่อห่างไม่เกิน ~6 บล็อก) — ผลที่เซิร์ฟเวอร์ตอบจะขึ้นในแท็บ Chat (บรรทัด [CTRL]) และเมนูที่เปิดจะโผล่ในแผง SERVER UI ที่แท็บ Dashboard</div>
        <div id="ent-list"></div>
      </div>
    </div>

    <div class="tab-content" id="tab-chat">
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div class="section-title" style="margin-bottom:0;">💬 CHAT</div>
          <div id="lv-switch" style="display:flex;gap:6px;">
            <button type="button" class="lv-btn active" data-v="chat">💬 แชท</button>
            <button type="button" class="lv-btn" data-v="sys">📋 Log</button>
            <button type="button" class="lv-btn" data-v="tech">🔧 เทคนิค</button>
          </div>
        </div>
        <style>.lv-btn{padding:4px 10px;font-size:12px;border-radius:8px;cursor:pointer;color:inherit;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18)}.lv-btn.active{background:rgba(124,92,255,0.35);border-color:rgba(124,92,255,0.85)}</style>
        <div class="chat-container">
          <div class="chat-viewport" id="log-box">
            <div class="chat-msg placeholder" style="color:var(--text-dim);text-align:center;padding:40px 20px;">
              <span style="font-size:24px;display:block;margin-bottom:8px;">📡</span>
              <span>Bot is Offline</span><br>
              <span style="font-size:11px;">Start the bot to connect to chat</span>
            </div>
          </div>
          <div class="chat-viewport" id="sys-box" style="display:none;"></div>
          <div class="chat-viewport" id="tech-box" style="display:none;"></div>
        </div>
        <div class="chat-input-wrap">
          <input id="cmd-in" class="input" placeholder="Send chat or command (prefix with /)" maxlength="256" />
          <button class="btn btn-primary btn-icon-send" onclick="sendCmd()">SEND</button>
        </div>
      </div>
    </div>

    <div class="tab-content" id="tab-inventory">
      <div class="panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div class="section-title" style="margin-bottom:0;">🎒 INVENTORY</div>
          <div class="inv-stat-chip" id="inv-count-chip">Items: <span id="inv-count">0</span></div>
        </div>
        <div class="inv-stats-bar" id="inv-stats-bar"></div>
        <div class="inv-panel">
          <div class="inv-grid" id="inv-grid">
            <div class="inv-empty-msg" style="grid-column:1/-1;">
              <span class="inv-empty-icon">🎒</span>
              Loading inventory...
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="tab-content" id="tab-settings">
      <div class="panel">
        <div class="section-title">⚙️ SETTINGS</div>

        <div style="margin-bottom:16px;">
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">🔐 Server Login (password screen)</div>
          <div class="toggle-wrap" style="margin-bottom:10px;">
            <label class="toggle">
              <input type="checkbox" id="toggle-autologin" ${state.autoLogin ? 'checked' : ''} onchange="onToggleLogin(this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label" id="autologin-label">${state.autoLogin ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div id="login-pass-wrap" style="display:${state.autoLogin ? 'flex' : 'none'};gap:8px;align-items:center;">
            <input class="input input-sm" id="login-password" type="password" placeholder="Server password..." value="${escapedPass}" style="flex:1;" />
            <button class="btn btn-sm btn-primary" onclick="saveSettings()">Save</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">When the server opens its password dialog (text box + confirm button), the bot fills in this password and presses confirm automatically. Max 3 tries per connection.</div>
        </div>

        <div class="divider"></div>

        <div style="margin-bottom:16px;">
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">🔢 PIN (หน้าแป้นตัวเลข 0-9)</div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
            <select class="input input-sm" id="pin-mode" onchange="onPinMode(this.value)" style="flex:1;">
              <option value="manual" ${state.autoPin ? '' : 'selected'}>✋ ใส่เอง — บอทไม่กดให้ (กดที่แท็บ Server UI)</option>
              <option value="auto" ${state.autoPin ? 'selected' : ''}>🤖 ใส่อัตโนมัติ — รอแป้นขึ้นก่อนแล้วค่อยกด</option>
            </select>
          </div>
          <div id="login-pin-wrap" style="display:${state.autoPin ? 'flex' : 'none'};flex-direction:column;gap:8px;">
            <div style="display:flex;gap:8px;align-items:center;">
              <input class="input input-sm" id="login-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="PIN 4-8 หลัก..." value="${escapedPin}" style="flex:1;" />
              <button class="btn btn-sm btn-primary" onclick="saveSettings()">Save</button>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
              <span style="font-size:12px;color:var(--text-dim);white-space:nowrap;">รอหลังแป้นขึ้น (ms)</span>
              <input class="input input-sm" id="pin-delay" onchange="saveSettings()" type="number" min="0" max="15000" step="100" value="${state.pinDelay}" style="flex:1;" />
              <button class="btn btn-sm btn-warning" onclick="resetPinLock()" title="ล้างตัวนับที่ทำให้บอทหยุดกดเอง">รีเซ็ตล็อก</button>
            </div>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">ใส่เอง = บอทแค่แสดงแป้นให้กดเองที่ Server UI · ใส่อัตโนมัติ = พอเซิร์ฟเวอร์ส่งแป้นขึ้นมา บอทจะรอตามเวลาด้านบนให้หน้าจอพร้อมก่อน แล้วค่อยกดเลข PIN ทีละหลัก · บอทหยุดกดเองถ้าใส่ครบ 2 รอบแล้วยังไม่ผ่าน เพื่อไม่ให้เสียโอกาสจนโดนล็อก (กด "รีเซ็ตล็อก" หลังแก้ PIN)</div>
        </div>

        <div class="divider"></div>

        <div style="margin-bottom:16px;">
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">📨 คำขอเทเลพอร์ต (TPA / TPAHERE)</div>
          <select class="input input-sm" id="tpa-mode" onchange="saveSettings()">
            <option value="manual" ${state.autoTpa !== true ? 'selected' : ''}>✋ ให้ฉันเลือกเอง — แจ้งที่เว็บ/Discord แล้วกดยอมรับ/ไม่ยอมรับ</option>
            <option value="auto" ${state.autoTpa === true ? 'selected' : ''}>🤖 ยอมรับอัตโนมัติ — มีคนขอแล้วบอทกด ยอมรับ ให้เลย</option>
          </select>
        </div>

        <div class="divider"></div>

        <div style="margin-bottom:16px;">
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">🚪 Auto-Join Server (right-click menu)</div>
          <div class="toggle-wrap" style="margin-bottom:10px;">
            <label class="toggle">
              <input type="checkbox" id="toggle-serverselect" ${state.autoServerSelect ? 'checked' : ''} onchange="onToggleServerSelect(this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label" id="serverselect-label">${state.autoServerSelect ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div id="serverselect-item-wrap" style="display:${state.autoServerSelect ? 'flex' : 'none'};gap:8px;align-items:center;">
            <input class="input input-sm" id="serverselect-item" type="text" placeholder="Item to click, e.g. grass_block" value="${escapeHtml(state.serverSelectItem || 'grass_block')}" style="flex:1;" />
            <button class="btn btn-sm btn-primary" onclick="saveSettings()">Save</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">After login, the bot right-clicks its held item to open the server-selector menu, then clicks the slot whose item name contains the text above.</div>
        </div>

        <div class="divider"></div>

        <div style="margin-bottom:16px;">
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">🍗 Auto-Eat</div>
          <div class="toggle-wrap" style="margin-bottom:6px;">
            <label class="toggle">
              <input type="checkbox" id="toggle-autoeat" ${state.autoEat ? 'checked' : ''} onchange="onToggleAutoEat(this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label" id="autoeat-label">${state.autoEat ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div style="font-size:11px;color:var(--text-dim);">Eats the best food it's carrying whenever hunger drops below 18/20. Works in the background.</div>
        </div>

        <div class="divider"></div>

        <div style="margin-bottom:16px;">
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">🔔 Discord Webhook (แจ้งสถานะบอทตัวนี้)</div>
          <div class="toggle-wrap" style="margin-bottom:10px;">
            <label class="toggle">
              <input type="checkbox" id="toggle-webhook" ${state.webhookOn !== false ? 'checked' : ''} onchange="onToggleWebhook(this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label" id="webhook-label">${state.webhookOn !== false ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
            <input class="input input-sm" id="wh-url" type="password" autocomplete="new-password" placeholder="${state.webhookUrl ? 'ตั้ง webhook เฉพาะบอทนี้ไว้แล้ว (เว้นว่าง = ไม่เปลี่ยน)' : 'Webhook เฉพาะบอทตัวนี้ (เว้นว่าง = ใช้ตัวรวมที่หน้า /config)'}" style="flex:1;" />
            <button class="btn btn-sm btn-primary" onclick="saveSettings()">Save</button>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-sm btn-primary" onclick="testWebhook()">🧪 ทดสอบ</button>
            <button class="btn btn-sm btn-warning" onclick="clearWebhook()">🗑 ลบ webhook เฉพาะบอทนี้</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">ส่งการ์ดสถานะของบอทตัวนี้ (แก้ข้อความเดิมอัตโนมัติ) + แจ้งตอนออนไลน์ / หลุด / reconnect พร้อม log 10 บรรทัดล่าสุด / โดนแบน / ล็อกอินไม่ผ่าน / ต้องกรอกโค้ด Microsoft</div>
        </div>

        <div class="divider"></div>

        <div>
          <div style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">⚡ Auto Commands</div>
          <div class="autocmd-list" id="autocmd-list"></div>
          <button class="btn-icon-add" onclick="addCmdRow()">+ Add Command</button>
          <div style="margin-top:12px;display:flex;gap:8px;">
            <button class="btn btn-sm btn-primary" style="flex:1;" onclick="saveSettings()">💾 Save Settings</button>
            <button class="btn btn-sm btn-warning" onclick="saveAndReconnect()">💾 + Reconnect</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    var STATE = {
      id: ${state.id},
      autoCommands: ${initCmds || '[]'},
      autoLoginOn: ${state.autoLogin},
      autoPinOn: ${state.autoPin},
      webhookOn: ${state.webhookOn !== false},
      autoServerSelectOn: ${state.autoServerSelect},
      autoEatOn: ${state.autoEat},
      lastLogHash: '',
      lastChatHash: '',
      lastTechHash: '',
      logView: 'chat',
      chat: [],
      logs: [],
      tech: [],
      toastTimer: null
    };

    // Tab switching
    (function() {
      var tabNav = document.getElementById('tab-nav');
      if (tabNav) {
        tabNav.addEventListener('click', function(e) {
          var btn = e.target.closest('.tab-btn');
          if (!btn) return;
          var tabName = btn.getAttribute('data-tab');
          if (!tabName) return;
          
          document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          
          document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
          var target = document.getElementById('tab-' + tabName);
          if (target) target.classList.add('active');
          
          if (typeof onTabChange === 'function') onTabChange(tabName);
          if (tabName === 'chat') {
            var logBox = document.getElementById('log-box');
            if (logBox) logBox.scrollTop = 0;
          }
        });
      }
    })();

    // ✅ แก้ XSS: ใช้ DOM API สร้าง element
    function renderCmds() {
      var list = document.getElementById('autocmd-list');
      list.innerHTML = '';
      STATE.autoCommands.forEach(function(row, idx) {
        var div = document.createElement('div');
        div.className = 'autocmd-row';

        var delayInput = document.createElement('input');
        delayInput.className = 'input input-sm autocmd-delay';
        delayInput.type = 'number';
        delayInput.min = '0';
        delayInput.step = '500';
        delayInput.value = row.delay || 2000;
        delayInput.addEventListener('input', function() {
          STATE.autoCommands[idx].delay = Number(this.value);
        });

        var cmdInput = document.createElement('input');
        cmdInput.className = 'input input-sm';
        cmdInput.type = 'text';
        cmdInput.placeholder = '/command...';
        cmdInput.value = row.cmd || '';
        cmdInput.addEventListener('input', function() {
          STATE.autoCommands[idx].cmd = this.value;
        });

        var removeBtn = document.createElement('button');
        removeBtn.className = 'btn-icon';
        removeBtn.textContent = '×';
        removeBtn.title = 'Remove';
        removeBtn.onclick = function() { removeCmdRow(idx); };

        div.appendChild(delayInput);
        div.appendChild(cmdInput);
        div.appendChild(removeBtn);
        list.appendChild(div);
      });
    }

    function addCmdRow() { STATE.autoCommands.push({delay:2000,cmd:''}); renderCmds(); }
    function removeCmdRow(i) { STATE.autoCommands.splice(i,1); renderCmds(); }

    function onToggleLogin(checked) {
      STATE.autoLoginOn = checked;
      document.getElementById('autologin-label').textContent = checked ? 'Enabled' : 'Disabled';
      document.getElementById('login-pass-wrap').style.display = checked ? 'flex' : 'none';
    }

    function onToggleServerSelect(checked) {
      STATE.autoServerSelectOn = checked;
      document.getElementById('serverselect-label').textContent = checked ? 'Enabled' : 'Disabled';
      document.getElementById('serverselect-item-wrap').style.display = checked ? 'flex' : 'none';
    }

    function onToggleAutoEat(checked) {
      STATE.autoEatOn = checked;
      document.getElementById('autoeat-label').textContent = checked ? 'Enabled' : 'Disabled';
    }

    function onPinMode(v) {
      STATE.autoPinOn = (v === 'auto');
      document.getElementById('login-pin-wrap').style.display = STATE.autoPinOn ? 'flex' : 'none';
    }

    function resetPinLock() {
      fetch('/bot/' + STATE.id + '/pin-reset', {method:'POST'}).then(function(){ showToast('✅ รีเซ็ตล็อก PIN แล้ว'); });
    }

    function onToggleWebhook(checked) {
      STATE.webhookOn = checked;
      document.getElementById('webhook-label').textContent = checked ? 'Enabled' : 'Disabled';
    }

    function testWebhook() {
      fetch('/bot/' + STATE.id + '/webhook-test', {method:'POST'}).then(function(r){ return r.json(); }).then(function(j){
        showToast(j.ok ? '✅ ส่งทดสอบแล้ว ดูใน Discord' : '❌ ' + (j.error || ('ส่งไม่สำเร็จ (HTTP ' + j.status + ')')));
      }).catch(function(){ showToast('❌ ส่งไม่สำเร็จ'); });
    }

    function clearWebhook() {
      fetch('/bot/' + STATE.id + '/webhook-clear', {method:'POST'}).then(function(){ showToast('✅ ลบ webhook เฉพาะบอทนี้แล้ว'); setTimeout(function(){ location.reload(); }, 800); });
    }

    function saveSettings() {
      var password = document.getElementById('login-password').value;
      var pinVal = document.getElementById('login-pin').value.replace(/[^0-9]/g, '');
      var whUrlEl = document.getElementById('wh-url');
      var pinDelayEl = document.getElementById('pin-delay');
      var serverSelectItem = document.getElementById('serverselect-item').value;
      fetch('/bot/' + STATE.id + '/settings', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({autoLogin:STATE.autoLoginOn,loginPassword:password,pinMode:(STATE.autoPinOn ? 'auto' : 'manual'),pinDelay:(pinDelayEl ? pinDelayEl.value : undefined),webhookOn:STATE.webhookOn,webhookUrl:(whUrlEl ? whUrlEl.value : ''),loginPin:pinVal,autoCommands:STATE.autoCommands,autoServerSelect:STATE.autoServerSelectOn,serverSelectItem:serverSelectItem,autoEat:STATE.autoEatOn,autoTpa:(document.getElementById('tpa-mode') ? document.getElementById('tpa-mode').value === 'auto' : undefined)})
      }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return {ok: r.ok, j: j}; }); }).then(function(x){
        if (!x.ok) showToast('❌ บันทึกไม่สำเร็จ: ' + ((x.j && x.j.error) || 'ลองใหม่'));
        else if (x.j && x.j.warn) showToast('⚠️ ' + x.j.warn);
        else showToast('✅ Settings Saved');
      }).catch(function(){ showToast('❌ บันทึกไม่สำเร็จ (เชื่อมต่อเซิร์ฟเวอร์ไม่ได้)'); });
    }

    function saveAndReconnect() {
      saveSettings();
      fetch('/bot/' + STATE.id + '/start', {method:'POST'}).then(function(){
        showToast('✅ Reconnecting...');
        setTimeout(function(){location.reload();},1200);
      });
    }

    function showToast(msg) {
      var t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      if (STATE.toastTimer) clearTimeout(STATE.toastTimer);
      STATE.toastTimer = setTimeout(function(){t.classList.remove('show');},2500);
    }

    function closeModal() { document.getElementById('delete-modal').classList.remove('open'); }
    function deleteBotNow() {
      fetch('/bot/' + STATE.id + '/delete', {method:'POST'}).then(function(){window.location.href='/';});
    }
    document.getElementById('delete-modal').addEventListener('click',function(e){if(e.target===this)closeModal();});

    function escLog(t) {
      return String(t).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
    }
    function parseLogs(logs, emptyText) {
      if (!logs || !logs.length) return '<div class="chat-msg placeholder" style="color:var(--text-dim);text-align:center;">' + escLog(emptyText || 'No messages yet') + '</div>';
      var parts = [];
      var limit = Math.min(logs.length, 60);
      for (var i = 0; i < limit; i++) {
        var raw = String(logs[i]);
        var ts = '', text = raw;
        if (raw.charAt(0) === '[') {
          var end = raw.indexOf(']');
          if (end > 0 && end <= 10) { ts = raw.slice(0, end + 1); text = raw.slice(end + 1).trim(); }
        }
        if (ts) parts.push('<div class="chat-msg"><span class="chat-ts">' + escLog(ts) + '</span><span class="chat-text">' + escLog(text) + '</span></div>');
        else parts.push('<div class="chat-msg"><span class="chat-text">' + escLog(text) + '</span></div>');
      }
      return parts.join('');
    }

    function lvHash(a) { return (a ? a.length : 0) + '|' + (a && a[0] ? a[0] : ''); }
    function renderLogView(force) {
      var v = STATE.logView, arr, boxId, key, empty;
      if (v === 'sys') { arr = STATE.logs; boxId = 'sys-box'; key = 'lastLogHash'; empty = 'ยังไม่มี log'; }
      else if (v === 'tech') { arr = STATE.tech; boxId = 'tech-box'; key = 'lastTechHash'; empty = 'ยังไม่มีบรรทัดเทคนิค (TRACE / PERF / DROP)'; }
      else { arr = STATE.chat; boxId = 'log-box'; key = 'lastChatHash'; empty = 'ยังไม่มีข้อความแชท'; }
      var h = lvHash(arr);
      if (!force && h === STATE[key]) return;
      STATE[key] = h;
      var box = document.getElementById(boxId);
      if (!box) return;
      box.innerHTML = parseLogs(arr || [], empty);
      box.scrollTop = 0;
    }
    function setLogView(v) {
      STATE.logView = v;
      var ids = { chat: 'log-box', sys: 'sys-box', tech: 'tech-box' };
      for (var k in ids) { var el = document.getElementById(ids[k]); if (el) el.style.display = (k === v) ? '' : 'none'; }
      var btns = document.querySelectorAll('#lv-switch .lv-btn');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-v') === v);
      renderLogView(true);
      update();
    }
    (function() {
      var sw = document.getElementById('lv-switch');
      if (sw) sw.addEventListener('click', function(e) {
        var b = e.target && e.target.closest ? e.target.closest('.lv-btn') : null;
        if (b) setLogView(b.getAttribute('data-v'));
      });
    })();

    function renderInventory(items) {
      var grid = document.getElementById('inv-grid');
      var countEl = document.getElementById('inv-count');
      var statsBar = document.getElementById('inv-stats-bar');

      if (!items || !items.length) {
        grid.innerHTML = '<div class="inv-empty-msg" style="grid-column:1/-1;"><span class="inv-empty-icon">🎒</span>Empty Inventory</div>';
        countEl.textContent = '0';
        statsBar.innerHTML = '';
        return;
      }

      countEl.textContent = items.length;
      var totalCount = 0;
      for (var i = 0; i < items.length; i++) totalCount += (items[i].count || 1);
      
      statsBar.innerHTML = '<div class="inv-stat-chip">Types: <span>' + items.length + '</span></div>' +
        '<div class="inv-stat-chip">Total: <span>' + totalCount + '</span></div>';

      var maxSlots = Math.min(36, Math.max(items.length, 9));
      var htmlParts = [];
      for (var i = 0; i < maxSlots; i++) {
        var item = items[i];
        if (item) {
          var icon = getItemIcon(item.name);
          var displayName = item.name.replace(/_/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2');
          htmlParts.push('<div class="inv-slot filled" title="' + item.name + ' x' + item.count + '">' +
            '<div class="inv-icon">' + icon + '</div>' +
            '<div class="inv-name">' + displayName + '</div>' +
            (item.count > 1 ? '<div class="inv-count">' + item.count + '</div>' : '') +
            '</div>');
        } else {
          htmlParts.push('<div class="inv-slot inv-empty-slot"><div class="inv-icon">▪</div></div>');
        }
      }
      grid.innerHTML = htmlParts.join('');
    }

    var _iconKeys = ['netherite','enchanted_book','experience_bottle','water_bucket','lava_bucket','splash_potion','lingering_potion','golden_apple','cobblestone','blaze_rod','ender_pearl','eye_of_ender','nether_star','glowstone','prismarine','firework','snowball','gunpowder','redstone','quartz','compass','diamond','emerald','crossbow','trident','chestplate','leggings','chicken','mushroom','pumpkin','leather','feather','string','totem','elytra','beacon','sword','axe','pickaxe','shovel','hoe','bow','shield','helmet','boots','apple','bread','steak','fish','salmon','cod','carrot','potato','cake','cookie','melon','gold','iron','coal','wood','log','plank','stick','stone','gravel','sand','glass','wool','torch','lantern','chest','book','paper','arrow','flint','potion','totem','bone','tnt','clock','map','bucket','egg','bow'];
    var _iconMap = {sword:'⚔️',axe:'🪓',pickaxe:'⛏️',shovel:'🔧',hoe:'🌾',bow:'🏹',crossbow:'🏹',trident:'🔱',shield:'🛡️',helmet:'⛑️',chestplate:'🦺',leggings:'👖',boots:'👢',apple:'🍎',bread:'🍞',steak:'🥩',chicken:'🍗',fish:'🐟',salmon:'🐟',cod:'🐟',carrot:'🥕',potato:'🥔',mushroom:'🍄',cake:'🎂',cookie:'🍪',melon:'🍉',pumpkin:'🎃',diamond:'💎',emerald:'💚',gold:'🟡',iron:'🔩',coal:'🪨',netherite:'🖤',wood:'🪵',log:'🪵',plank:'🪵',stick:'🥢',stone:'🪨',cobblestone:'🪨',gravel:'🪨',sand:'🏖️',glass:'🔮',wool:'🧶',leather:'🟫',torch:'🔦',lantern:'🏮',chest:'📦',book:'📚',enchanted_book:'✨',paper:'📄',feather:'🪶',arrow:'➶',flint:'💠',string:'🧵',slimeball:'🟢',blaze_rod:'🔥',ender_pearl:'🔮',eye_of_ender:'👁️',nether_star:'⭐',beacon:'🔆',compass:'🧭',clock:'🕐',map:'🗺️',bucket:'🪣',water_bucket:'💧',lava_bucket:'🌋',potion:'🧪',splash_potion:'💥',lingering_potion:'🌀',experience_bottle:'✨',golden_apple:'🍎',totem:'🗿',elytra:'🦋',firework:'🎆',egg:'🥚',snowball:'❄️',bone:'🦴',gunpowder:'💣',tnt:'💣',redstone:'🔴',glowstone:'💡',quartz:'🔷',prismarine:'🔵'};
    function getItemIcon(name) {
      if (!name) return '📦';
      var lower = name.toLowerCase();
      for (var i = 0; i < _iconKeys.length; i++) {
        if (lower.includes(_iconKeys[i])) return _iconMap[_iconKeys[i]] || '📦';
      }
      return '📦';
    }

    var _lastInvHash = '';
    function invHash(items) {
      if (!items || !items.length) return '';
      var s = '';
      for (var i = 0; i < items.length; i++) s += items[i].name + ':' + items[i].count + ',';
      return s;
    }

    /* ---- Server UI (PIN pad / เมนูเซิร์ฟเวอร์) ----
       แก้อาการ "ปุ่มสลับมั่ว/หาย":
       1) แป้นเลขสร้างครั้งเดียว ตำแหน่งตายตัวแบบโทรศัพท์ (1-9 / ล้าง 0 ลบ) ไม่ตามลำดับที่เซิร์ฟเวอร์ส่งมา และไม่ rebuild ตอนข้อมูลอัปเดต
       2) ส่งคำสั่งด้วย "ข้อความบนปุ่ม" ไม่ใช่ตำแหน่ง — เซิร์ฟเวอร์เลือกปุ่มจากหน้าล่าสุดเอง (id ปุ่มเปลี่ยนทุกหน้า)
       3) ผลตอบกลับที่มาช้า/สลับลำดับถูกทิ้ง (เทียบ ts) — เดิมผล poll เก่าเขียนทับหน้าใหม่ได้
       4) หน้า PIN ที่เซิร์ฟเวอร์เพิ่งปิดจะค้างโชว์แบบจางสั้น ๆ แทนที่จะหายวับ */
    var _uiTs = 0, _uiKey = '', _kpBuilt = false, _kpCells = {};
    function $(id) { return document.getElementById(id); }
    function uiMk(tag, text, css) {
      var e = document.createElement(tag);
      if (text) e.textContent = text;
      if (css) e.style.cssText = css;
      return e;
    }
    function uiPost(path, body) {
      return fetch('/bot/' + STATE.id + path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {})})
        .then(function(r){ return r.json(); })
        .then(function(d){ if (d && !d.ok && d.error) showToast('⚠️ ' + d.error); uiPoll(); return d; })
        .catch(function(){ showToast('⚠️ ส่งคำสั่งไม่สำเร็จ'); });
    }
    function uiPoll() {
      fetch('/api/ui/' + STATE.id).then(function(r){ return r.json(); })
        .then(function(u){ if (u && !u.error) renderUI(u); }).catch(function(){});
    }
    function flash(el) { el.classList.add('pressed'); setTimeout(function(){ el.classList.remove('pressed'); }, 160); }
    function tapButton(el) {
      var b = el._btn; if (!b || el.disabled) return;
      flash(el);
      uiPost('/ui-dialog-click', {i: b.i, label: b.label});
    }
    function buildKeypad() {
      if (_kpBuilt) return; _kpBuilt = true;
      var g = $('kp-grid');
      ['1','2','3','4','5','6','7','8','9','L','0','R'].forEach(function(k){
        var el = uiMk('button', '', ''); el.type = 'button'; el.className = 'kp-btn empty';
        el.addEventListener('click', function(){ tapButton(el); });
        g.appendChild(el); _kpCells[k] = el;
      });
      var ex = $('ui-exit');
      ex.addEventListener('click', function(){
        var b = ex._btn; if (!b) return;
        if (!ex._armed) {
          ex._armed = true; ex._label = ex.textContent; ex.textContent = 'แตะอีกครั้งเพื่อยืนยัน: ' + ex._label;
          setTimeout(function(){ if (ex._armed) { ex._armed = false; ex.textContent = ex._label; } }, 3000);
          return;
        }
        ex._armed = false; ex.textContent = ex._label;
        uiPost('/ui-dialog-click', {i: b.i, label: b.label});
      });
      $('ui-hold').addEventListener('click', function(){ uiPost(this._held ? '/pin-resume' : '/pin-hold', {}); });
    }
    function setCell(k, b, closed) {
      var el = _kpCells[k];
      el._btn = b || null;
      if (!b) { el.className = 'kp-btn empty'; el.textContent = ''; el.disabled = true; return; }
      el.className = 'kp-btn'; el.textContent = b.label || '⌫'; el.disabled = !!closed;
    }
    function renderDialog(d) {
      var box = $('ui-dialog-box');
      if (!d) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      buildKeypad();
      $('ui-text').textContent = d.closed ? '⏳ เซิร์ฟเวอร์ปิดหน้านี้แล้ว — รอหน้าใหม่…' : (d.text || '(dialog)');
      var dots = $('ui-dots'); dots.textContent = d.dots || ''; dots.style.display = d.dots ? 'block' : 'none';
      var left = $('ui-left');
      if (d.left !== null && d.left !== undefined) { left.textContent = 'เหลือโอกาสอีก ' + d.left + ' ครั้ง'; left.style.display = 'block'; } else left.style.display = 'none';

      var normal = [], exits = [], digits = {}, nd = 0;
      d.buttons.forEach(function(b){
        if (b.role === 'exit') { exits.push(b); return; }
        normal.push(b);
        if (/^[0-9]$/.test(b.label) && !digits[b.label]) { digits[b.label] = b; nd++; }
      });
      var isPad = nd >= 9;
      $('kp-grid').style.display = isPad ? 'grid' : 'none';
      var rest = normal;
      if (isPad) {
        var clr = null, back = null;
        rest = [];
        normal.forEach(function(b){
          if (digits[b.label] === b) return;
          if (!clr && /ล้าง|clear|reset/i.test(b.label)) clr = b;
          else if (!back && (b.label === '' || /ลบ|back|del|⌫/i.test(b.label))) back = b;
          else rest.push(b);
        });
        for (var k = 0; k <= 9; k++) setCell(String(k), digits[String(k)], d.closed);
        setCell('L', clr, d.closed); setCell('R', back, d.closed);
      }
      var extra = $('ui-extra'); extra.innerHTML = '';
      extra.style.display = rest.length ? 'grid' : 'none';
      rest.forEach(function(b){
        var el = uiMk('button', b.label || '⌫', ''); el.type = 'button'; el.className = 'kp-btn';
        el.style.fontSize = '15px'; el._btn = b; el.disabled = !!d.closed;
        el.addEventListener('click', function(){ tapButton(el); });
        extra.appendChild(el);
      });
      var ex = $('ui-exit');
      ex._armed = false;
      if (exits.length) { ex.style.display = 'block'; ex._btn = exits[0]; ex.textContent = exits[0].label || 'เมนูแบบเก่า'; ex.disabled = !!d.closed; } else { ex.style.display = 'none'; ex._btn = null; }
      var hold = $('ui-hold');
      hold._held = !!d.held;
      hold.textContent = d.held ? '✋ บอทพักกด PIN อยู่ — แตะเพื่อให้บอทกลับมากดเอง' : '✋ ให้บอทพักกด PIN อัตโนมัติ 5 นาที (กันบอทกดแย่ง)';
    }
    function renderLoading(l) {
      var box = $('ui-loading-box');
      if (!l) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      $('ui-loading-text').textContent = l.text || 'กำลังโหลด…';
    }
    function renderWindow(w) {
      var box = $('ui-window-box');
      if (!w) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.style.display = 'block'; box.innerHTML = '';
      var wTitle = w.title || w.type;
      var digitSlots = {}, nd = 0;
      w.slots.forEach(function(sl){ if (/^[0-9]$/.test(sl.label) && !digitSlots[sl.label]) { digitSlots[sl.label] = sl; nd++; } });
      var isPad = !w.empty && nd >= 9;
      if (isPad) box.appendChild(uiMk('div', wTitle, 'font-size:15px;margin:2px 0 10px;font-weight:700;text-align:center;'));
      else box.appendChild(uiMk('div', '🪟 หน้าต่าง: ' + wTitle, 'font-size:14px;margin:4px 0 8px;font-weight:700;'));
      if (w.empty) {
        var ld = uiMk('div', '', 'text-align:center;padding:6px 0 10px;');
        var sp = uiMk('div', '', ''); sp.className = 'ui-spin'; ld.appendChild(sp);
        ld.appendChild(uiMk('div', 'กำลังรอเซิร์ฟเวอร์ส่งปุ่มมา…', 'font-size:14px;'));
        box.appendChild(ld);
        var cl0 = uiMk('button', 'ปิดหน้าต่าง', 'width:100%;margin-top:8px;font-size:14px;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.25);background:transparent;color:inherit;');
        cl0.onclick = function(){ uiPost('/ui-window-close', {}); };
        box.appendChild(cl0);
        return;
      }
      var itemCss = 'min-height:44px;font-size:13px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:inherit;padding:4px;word-break:break-word;';
      function slotBtn(sl) {
        var el = uiMk('button', sl.label + (sl.n > 1 ? ' ×' + sl.n : ''), itemCss);
        el.type = 'button';
        el.onclick = function(){ uiPost('/ui-window-click', {slot: sl.s, label: sl.label}); };
        return el;
      }
      if (isPad) {
        // หน้าต่างแบบแป้นเลข (PIN จริง): ใช้หน้าตาเดียวกับแป้น PIN (kp-grid / kp-btn) — ตำแหน่งตายตัวแบบโทรศัพท์ 1-9 / ล้าง 0 ⌫
        // ไม่โชว์ ×จำนวน (เซิร์ฟเวอร์ใช้จำนวนไอเทมเป็นเลขลำดับ) และซ่อนช่องเติม "-"; คลิกด้วยข้อความบนปุ่มเหมือนเดิม
        var clr = null, back = null, notes = [], extras = [];
        w.slots.forEach(function(sl){
          if (!sl.label || digitSlots[sl.label] === sl || /^[0-9]$/.test(sl.label)) return;
          var lb = sl.label.trim();
          if (lb.replace(/[- ._]/g, '') === '') return;
          if (!clr && /ล้าง|clear|reset/i.test(lb)) clr = sl;
          else if (!back && /ลบ|back|del|⌫/i.test(lb)) back = sl;
          else if (lb.length > 16) notes.push(lb);
          else extras.push(sl);
        });
        var padBtn = function(sl, text) {
          var el = uiMk('button', '', ''); el.type = 'button';
          if (!sl) { el.className = 'kp-btn empty'; el.disabled = true; return el; }
          el.className = 'kp-btn'; el.textContent = text || sl.label;
          el.addEventListener('click', function(){ flash(el); uiPost('/ui-window-click', {slot: sl.s, label: sl.label}); });
          return el;
        };
        var grid = uiMk('div', '', 'max-width:360px;margin:0 auto 8px;'); grid.className = 'kp-grid';
        ['1','2','3','4','5','6','7','8','9'].forEach(function(k){ grid.appendChild(padBtn(digitSlots[k])); });
        grid.appendChild(padBtn(clr, clr ? clr.label : ''));
        grid.appendChild(padBtn(digitSlots['0']));
        grid.appendChild(padBtn(back, '⌫'));
        box.appendChild(grid);
        if (extras.length) {
          var eg = uiMk('div', '', 'max-width:360px;margin:0 auto 8px;'); eg.className = 'kp-grid';
          extras.forEach(function(sl){ var b2 = padBtn(sl); b2.style.fontSize = '15px'; eg.appendChild(b2); });
          box.appendChild(eg);
        }
        notes.forEach(function(t){ var nt = uiMk('div', t, ''); nt.className = 'kp-note'; box.appendChild(nt); });
      } else {
        var wg = uiMk('div', '', 'display:grid;grid-template-columns:repeat(' + w.cols + ',1fr);gap:6px;');
        w.slots.forEach(function(sl){
          if (!sl.label) { wg.appendChild(uiMk('div', '', 'min-height:44px;border-radius:6px;background:rgba(255,255,255,0.03);')); return; }
          wg.appendChild(slotBtn(sl));
        });
        box.appendChild(wg);
      }
      var cl = uiMk('button', 'ปิดหน้าต่าง', isPad ? '' : 'width:100%;margin-top:8px;font-size:14px;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.25);background:transparent;color:inherit;');
      if (isPad) cl.className = 'kp-exit';
      cl.onclick = function(){ uiPost('/ui-window-close', {}); };
      box.appendChild(cl);
    }
    /* หน้า PIN แบบ dialog (ตอน configuration) ขึ้นมาแป๊บเดียวแล้วหาย ก่อนหน้า PIN จริงจะเปิด
       → ระหว่างนั้นโชว์หน้าโหลดแทน (บอทยังกด PIN อัตโนมัติตามปกติ — แก้เฉพาะหน้าจอ ไม่แตะระบบ PIN)
       กันค้าง: ถ้าแป้น dialog ยังอยู่นิ่ง ๆ เกิน 20 วิ หรือผู้ใช้กด "แสดงแป้นเดิม" จะโชว์แป้นให้กดเองได้ */
    var _padSince = 0, _showPad = false;
    function isPadDialog(d) {
      if (!d || !d.buttons) return false;
      var seen = {}, n = 0;
      d.buttons.forEach(function(b){ if (b.role !== 'exit' && /^[0-9]$/.test(b.label) && !seen[b.label]) { seen[b.label] = 1; n++; } });
      return n >= 9;
    }
    /* ---- ป๊อปอัปลอย: หน้าต่างเซิร์ฟเวอร์ (เช่น TPA / เมนู) โผล่ทุกแท็บ กดเองได้ ---- */
    var _fKey = '', _fDismiss = '', _fEl = null;
    function fEnsure() {
      if (_fEl) return _fEl;
      var st = document.createElement('style');
      st.textContent = '#ui-float{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:9999;width:min(94vw,420px);max-height:80vh;overflow:auto;'
        + 'background:#1b1d26;color:#fff;border:1px solid rgba(250,204,21,0.6);border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,0.6);padding:12px;display:none;font-family:inherit;}'
        + '#ui-float .uf-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}'
        + '#ui-float .uf-title{flex:1;font-weight:700;font-size:15px;word-break:break-word;}'
        + '#ui-float .uf-x{border:1px solid rgba(255,255,255,0.25);background:transparent;color:inherit;border-radius:8px;padding:4px 10px;font-size:14px;cursor:pointer;}'
        + '#ui-float .uf-list{display:flex;flex-direction:column;gap:8px;}'
        + '#ui-float .uf-btn{min-height:46px;font-size:15px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.09);color:inherit;padding:8px 10px;cursor:pointer;word-break:break-word;}'
        + '#ui-float .uf-btn.ok{background:rgba(34,197,94,0.28);border-color:rgba(34,197,94,0.7);}'
        + '#ui-float .uf-btn.no{background:rgba(239,68,68,0.28);border-color:rgba(239,68,68,0.7);}'
        + '#ui-float .uf-btn:active{transform:scale(0.97);}'
        + '#ui-float .uf-note{font-size:13px;opacity:0.8;text-align:center;padding:6px 0;}';
      document.head.appendChild(st);
      _fEl = document.createElement('div'); _fEl.id = 'ui-float';
      document.body.appendChild(_fEl);
      return _fEl;
    }
    function renderFloat(ui) {
      var w = ui && ui.window;
      if (!w) { _fDismiss = ''; _fKey = ''; if (_fEl) _fEl.style.display = 'none'; return; }
      // แป้น PIN แบบหน้าต่าง ใช้แผง Server UI เดิมในแท็บ Dashboard (ไม่ซ้ำ)
      var nd = 0, seen = {};
      w.slots.forEach(function(sl){ if (/^[0-9]$/.test(sl.label) && !seen[sl.label]) { seen[sl.label] = 1; nd++; } });
      if (!w.empty && nd >= 9) { if (_fEl) _fEl.style.display = 'none'; return; }
      var sig = (w.title || '') + '|' + (w.type || '');
      if (_fDismiss === sig) { if (_fEl) _fEl.style.display = 'none'; return; }
      var key = JSON.stringify(w);
      var el = fEnsure();
      if (key === _fKey && el.style.display === 'block') return;
      _fKey = key;
      el.innerHTML = '';
      var head = uiMk('div', '', ''); head.className = 'uf-head';
      var t = uiMk('div', '🪟 ' + (w.title || w.type || 'หน้าต่างเซิร์ฟเวอร์'), ''); t.className = 'uf-title';
      var x = uiMk('button', '✕ ซ่อน', ''); x.type = 'button'; x.className = 'uf-x';
      x.onclick = function(){ _fDismiss = sig; el.style.display = 'none'; };
      head.appendChild(t); head.appendChild(x); el.appendChild(head);
      if (w.empty) {
        var n0 = uiMk('div', 'กำลังรอเซิร์ฟเวอร์ส่งปุ่มมา…', ''); n0.className = 'uf-note'; el.appendChild(n0);
      } else {
        var list = uiMk('div', '', ''); list.className = 'uf-list';
        var count = 0;
        w.slots.forEach(function(sl){
          if (!sl.label) return;
          if (/glass_pane/.test(sl.id || '')) return;
          if (sl.label.replace(/[- ._]/g, '') === '') return;
          count++;
          var cls = 'uf-btn';
          if (/ยอมรับ|accept|ตกลง|confirm|yes/i.test(sl.label)) cls += ' ok';
          else if (/ปฏิเสธ|deny|decline|cancel|ยกเลิก|reject|no$/i.test(sl.label)) cls += ' no';
          var b = uiMk('button', sl.label + (sl.n > 1 ? ' ×' + sl.n : ''), ''); b.type = 'button'; b.className = cls;
          b.onclick = function(){ uiPost('/ui-window-click', {slot: sl.s, label: sl.label}); };
          list.appendChild(b);
        });
        if (!count) { var n1 = uiMk('div', '(หน้าต่างนี้ไม่มีปุ่มให้กด)', ''); n1.className = 'uf-note'; el.appendChild(n1); }
        else el.appendChild(list);
        var cl = uiMk('button', 'ปิดหน้าต่าง', ''); cl.type = 'button'; cl.className = 'uf-btn'; cl.style.marginTop = '8px'; cl.style.width = '100%';
        cl.onclick = function(){ uiPost('/ui-window-close', {}); };
        el.appendChild(cl);
      }
      el.style.display = 'block';
    }
    function renderUI(ui) {
      var panel = $('ui-panel');
      if (ui && typeof ui.ts === 'number') { if (ui.ts < _uiTs) return; _uiTs = ui.ts; }
      try { renderFloat(ui); } catch (e) {}
      if (!ui || (!ui.dialog && !ui.window && !ui.loading)) { panel.style.display = 'none'; _uiKey = ''; _padSince = 0; _showPad = false; return; }
      var padDlg = isPadDialog(ui.dialog);
      if (padDlg) { if (!_padSince) _padSince = Date.now(); } else { _padSince = 0; _showPad = false; }
      var hideDlg = padDlg && !_showPad && (Date.now() - _padSince < 20000);
      var key = JSON.stringify({d: ui.dialog, w: ui.window, l: ui.loading, h: hideDlg});
      if (key === _uiKey) return;
      _uiKey = key;
      panel.style.display = 'block';
      var loading = ui.loading;
      if (hideDlg && !ui.window) loading = {text: 'กำลังโหลดหน้าใส่ PIN…'};
      renderLoading((!hideDlg && (ui.dialog || ui.window)) || (hideDlg && ui.window) ? null : loading);
      var sb = $('ui-showpad');
      if (sb) sb.style.display = (hideDlg && !ui.window) ? 'block' : 'none';
      renderDialog(hideDlg ? null : ui.dialog);
      renderWindow(ui.window);
    }

    function update() {
      fetch('/api/status/' + STATE.id + (STATE.logView === 'tech' ? '?tech=1' : ''))
        .then(function(r){return r.json()})
        .then(function(data){
          if (data.error) return;

          document.getElementById('nav-badge').textContent = data.status;
          document.getElementById('nav-badge').className = 'badge badge-' + data.status;
          document.getElementById('nav-badge-lg').textContent = data.status;
          document.getElementById('nav-badge-lg').className = 'badge badge-' + data.status;
          document.getElementById('stat-uptime').textContent = data.uptime;
          document.getElementById('stat-hp').textContent = Math.round(data.health);
          document.getElementById('stat-food').textContent = Math.round(data.food);
          renderUI(data.ui);

          STATE.chat = data.chat || [];
          STATE.logs = data.logs || [];
          if (data.tech) STATE.tech = data.tech;
          renderLogView(false);

          var h = invHash(data.inventory);
          if (h !== _lastInvHash) {
            _lastInvHash = h;
            renderInventory(data.inventory || []);
          }

        })
        .catch(function(){});
    }

    function sendCmd() {
      var cmd = document.getElementById('cmd-in').value.trim();
      if (!cmd) return;
      fetch('/bot/' + STATE.id + '/command', {
        method: 'POST',
        headers: {'Content-Type':'application/x-www-form-urlencoded'},
        body: 'cmd=' + encodeURIComponent(cmd)
      });
      document.getElementById('cmd-in').value = '';
      setTimeout(update, 300);
    }

    document.getElementById('cmd-in').addEventListener('keydown',function(e){if(e.key==='Enter')sendCmd();});

    function setTheme(key) {
      fetch('/bot/' + STATE.id + '/theme', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({theme:key})
      }).then(function(){location.reload();});
    }

    /* ---- เดินเอง + หัน/คลิกเอง (แท็บ Control) ---- */
    var CTRL = { active: false, entKey: '' };
    function ctrlPost(path, body, quiet) {
      return fetch('/bot/' + STATE.id + path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {})})
        .then(function(r){ return r.json(); })
        .then(function(d){ if (d && !d.ok && d.error && !quiet) showToast('⚠️ ' + d.error); return d; })
        .catch(function(){ if (!quiet) showToast('⚠️ ส่งคำสั่งไม่สำเร็จ'); });
    }
    function ctrlStop() { releaseMove(); ctrlPost('/ctrl-stop', {}); }
    function ctrlLook(o) { ctrlPost('/ctrl-look', o); }
    function lookStep() { return Number($('look-step').value) || 15; }
    function ctrlUse() { ctrlPost('/ctrl-use', {}); }
    function setAutoWalk(on) { ctrlPost('/auto-walk', {on: on}); }
    function setAutoClick(on) { ctrlPost('/auto-click', {on: on}); }
    function saveAttack() { ctrlPost('/auto-attack', {on: $('atk-on').checked, delay: Number($('atk-delay').value) || 500}); }
    function ctrlDismount() { ctrlPost('/ctrl-dismount', {}); }

    /* เดินเอง: กดค้าง = เดิน, ปล่อย = หยุด — ส่งชุดปุ่มที่กดอยู่ทุก ~300ms (เซิร์ฟเวอร์หยุดเองถ้าเงียบเกิน 1.2 วิ) */
    var MV = { keys: {}, sprint: false, sneak: false, timer: null };
    function mvList() { return Object.keys(MV.keys).filter(function(k){ return MV.keys[k]; }); }
    function mvSend() {
      fetch('/bot/' + STATE.id + '/ctrl-move', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({keys: mvList(), sprint: MV.sprint, sneak: MV.sneak})}).catch(function(){});
    }
    function mvRefresh() {
      var any = mvList().length > 0;
      document.querySelectorAll('[data-mv]').forEach(function(b){ b.classList.toggle('mv-on', !!MV.keys[b.getAttribute('data-mv')]); });
      if (any && !MV.timer) MV.timer = setInterval(mvSend, 300);
      if (!any && MV.timer) { clearInterval(MV.timer); MV.timer = null; }
    }
    function mvSet(k, on) { if (!!MV.keys[k] === on) return; MV.keys[k] = on; mvRefresh(); mvSend(); }
    function releaseMove() { if (!mvList().length && !MV.timer) return; MV.keys = {}; mvRefresh(); mvSend(); }
    function toggleMv(name, btn) { MV[name] = !MV[name]; btn.classList.toggle('mv-on', MV[name]); if (mvList().length) mvSend(); }
    document.querySelectorAll('[data-mv]').forEach(function(b){
      var k = b.getAttribute('data-mv');
      b.addEventListener('pointerdown', function(e){ e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (x) {} mvSet(k, true); });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function(ev){ b.addEventListener(ev, function(){ mvSet(k, false); }); });
      b.addEventListener('contextmenu', function(e){ e.preventDefault(); });
    });
    var KEYMAP = { w: 'forward', s: 'back', a: 'left', d: 'right', ' ': 'jump' };
    document.addEventListener('keydown', function(e){
      if (!CTRL.active) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      var k = KEYMAP[String(e.key).toLowerCase()];
      if (!k) return;
      e.preventDefault(); mvSet(k, true);
    });
    document.addEventListener('keyup', function(e){ var k = KEYMAP[String(e.key).toLowerCase()]; if (k) mvSet(k, false); });
    window.addEventListener('blur', releaseMove);
    document.addEventListener('visibilitychange', function(){ if (document.hidden) releaseMove(); });

    function entPosText(e) {
      var r = e.rel;
      var side = Math.abs(r) < 8 ? 'ตรงหน้า' : (Math.abs(r) > 150 ? 'อยู่ข้างหลัง' : (r > 0 ? 'ขวา ' : 'ซ้าย ') + Math.round(Math.abs(r)) + '°');
      return '📍 X ' + e.x + '  Y ' + e.y + '  Z ' + e.z + '  ·  🧭 ' + e.dir + ' · ' + side;
    }

    function renderCtrl(st) {
      var s = $('ctl-status');
      if (!st.ready) { s.textContent = '⚠️ ' + (st.why || 'ยังควบคุมไม่ได้'); s.style.color = '#facc15'; }
      else { s.textContent = '🟢 พร้อมควบคุม'; s.style.color = ''; }
      var w = st.walk, ws = $('walk-status');
      if (ws) ws.textContent = (w && w.running)
        ? '🚶 กำลังเดินไป ' + (w.target || 'NPC') + (w.d != null ? ' (เหลือ ' + w.d + ' บล็อก)' : '') + ' — กด ■ หยุดทุกอย่าง เพื่อยกเลิก'
        : (st.autoClick ? 'พอเดินถึง NPC จะคลิกขวาให้เองอัตโนมัติ' : 'เดินอย่างเดียว ไม่คลิกให้ — พอถึงแล้วกด 🖱 คลิกขวา ที่รายการ NPC ด้านล่างเอง');
      var as = $('atk-status');
      if (as && st.attack) {
        var a = st.attack;
        as.textContent = (a.on ? '⚔️ กำลังทำงาน' : '⏸ ปิดอยู่') + ' · ดีเลย์ ' + a.delay + ' ms · แกว่งแล้ว ' + a.hits + ' ครั้ง (โดน entity ' + (a.landed || 0) + ')' + (a.note ? ' · ' + a.note : '');
      }
      var p = st.pos;
      $('ctl-pos').textContent = p
        ? 'ตัวบอท: X ' + p.x + '  Y ' + p.y + '  Z ' + p.z + '  ·  หัน ' + st.dir + ' (yaw ' + st.yaw + ', pitch ' + st.pitch + ')' + (st.onGround ? '' : '  ·  ลอย/ตก') + (st.vehicle ? '  ·  นั่ง ' + st.vehicle : '') + (st.pulls10 ? '  ·  ⚠️ ถูกดึงกลับ ' + st.pulls10 + ' ครั้งใน 10 วิ' : '')
        : 'ยังไม่มีตำแหน่ง';
      var ents = st.entities || [];
      var key = ents.map(function(e){ return e.id + ':' + e.label; }).join('|');
      var box = $('ent-list');
      if (key !== CTRL.entKey) {
        CTRL.entKey = key;
        box.innerHTML = '';
        if (!ents.length) box.appendChild(uiMk('div', st.ready ? 'ไม่มี entity อยู่ใกล้ตัว (รัศมี 32 บล็อก)' : '—', 'font-size:12px;color:var(--text-dim);padding:6px 0;'));
        ents.forEach(function(e){
          var row = uiMk('div', '', ''); row.className = 'ent-row';
          row.appendChild(uiMk('span', e.label + (e.type && e.type !== e.label ? ' (' + e.type + ')' : ''), 'flex:1;word-break:break-word;'));
          var ds = uiMk('span', '', 'color:var(--text-dim);min-width:46px;text-align:right;'); ds.id = 'ent-d-' + e.id; row.appendChild(ds);
          var b1 = uiMk('button', '👀', ''); b1.className = 'btn btn-sm'; b1.title = 'หันหา';
          b1.onclick = function(){ ctrlLook({entity: e.id}); };
          var b2 = uiMk('button', '🖱 คลิกขวา', ''); b2.className = 'btn btn-sm btn-primary';
          b2.onclick = function(){ ctrlPost('/ctrl-interact', {id: e.id}); };
          row.appendChild(b1); row.appendChild(b2);
          var ps = uiMk('div', '', 'width:100%;font-size:11px;color:var(--text-dim);'); ps.id = 'ent-p-' + e.id; row.appendChild(ps);
          box.appendChild(row);
        });
      }
      ents.forEach(function(e){
        var d = $('ent-d-' + e.id); if (d) d.textContent = e.d + 'm';
        var q = $('ent-p-' + e.id); if (q) q.textContent = entPosText(e);
      });
    }
    var _ctrlTs = 0;
    function ctrlTick() {
      if (!CTRL.active) return;
      fetch('/api/ctrl/' + STATE.id).then(function(r){ return r.json(); })
        .then(function(st){ if (!st || st.error) return; if (st.ts < _ctrlTs) return; _ctrlTs = st.ts; renderCtrl(st); }).catch(function(){});
    }
    function onTabChange(name) {
      if (name !== 'control') releaseMove();
      CTRL.active = (name === 'control');
      if (CTRL.active) ctrlTick();
    }
    setInterval(ctrlTick, 600);

    function tpaPoll() {
      if (document.hidden) return;
      fetch('/api/tpa/' + STATE.id).then(function(r){ return r.json(); }).then(function(s){
        var p = $('tpa-panel'); if (!p) return;
        var t = s && s.pending;
        if (!t) { p.style.display = 'none'; p._token = ''; return; }
        p.style.display = 'block'; p._token = t.token;
        $('tpa-text').textContent = '📨 ' + (t.from || 'มีผู้เล่น') + (t.kind === 'here' ? ' ขอให้บอทเทเลพอร์ตไปหา (/tpahere)' : ' ส่งคำขอเทเลพอร์ต') + ' · เหลือ ~' + t.left + ' วิ';
        $('tpa-raw').textContent = t.text || '';
      }).catch(function(){});
    }
    function tpaAnswer(ok) {
      var p = $('tpa-panel'); if (!p || !p._token) return;
      fetch('/bot/' + STATE.id + '/tpa-respond', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({token: p._token, accept: ok})})
        .then(function(r){ return r.json(); }).then(function(j){
          showToast(j && j.ok ? (ok ? '✅ ยอมรับแล้ว' : '❌ ไม่ยอมรับแล้ว') : '⚠️ ' + ((j && j.error) || 'ไม่สำเร็จ'));
          p.style.display = 'none'; p._token = ''; tpaPoll();
        }).catch(function(){ showToast('⚠️ ส่งคำสั่งไม่สำเร็จ'); });
    }
    setInterval(tpaPoll, 1500); tpaPoll();

    renderCmds();
    update();
    setInterval(function(){ if (!document.hidden) update(); }, 2000);
    var _uiSkip = 0;
    setInterval(function(){
      if (document.hidden) return;
      var hot = $('ui-panel').style.display === 'block' || (_fEl && _fEl.style.display === 'block');
      if (hot || ++_uiSkip >= 2) { _uiSkip = 0; uiPoll(); }
    }, 700);
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) { update(); uiPoll(); } });
    (function(){ var sb = $('ui-showpad'); if (sb) sb.addEventListener('click', function(){ _showPad = true; _uiKey = ''; uiPoll(); }); })();
  </script>
</body></html>`)
})

/* ===========================
   ERROR HANDLING & SHUTDOWN
=========================== */

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message)
  console.error(err.stack)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection:', reason?.message || reason)
})

let shuttingDown = false
process.on('SIGINT', async () => {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n[SYSTEM] Shutting down gracefully...')
  bots.forEach(bot => { try { bot.stop() } catch {} })
  saveBots()
  saveServerConfig()
  try { await whShutdown(3500) } catch {}
  try { await ghFlush(6000) } catch {}
  console.log('[SYSTEM] Shutdown complete')
  process.exit(0)
})

process.on('SIGTERM', () => {
  process.emit('SIGINT')
})

/* ===========================
   STARTUP
=========================== */

/* ===========================
   KEEP-ALIVE (self ping)
   Hosting ฟรีบางเจ้า (Replit, Render, Railway ฯลฯ) จะ sleep ตัวเอง
   ถ้าไม่มี request เข้ามานานเกินไป — ฟังก์ชันนี้จะยิง request หา
   ตัวเองเป็นระยะเพื่อให้มี traffic ตลอดเวลา

   ตั้งค่า PUBLIC_URL เป็น URL สาธารณะของแอพ (เช่น
   https://your-app.onrender.com) ผ่าน environment variable
   ถ้าไม่ตั้ง จะ ping แค่ localhost ซึ่งช่วยได้เฉพาะบาง provider
=========================== */
const http = require('http')
const https = require('https')
const PORT = process.env.PORT || 3000

const KEEPALIVE_URL = (process.env.PUBLIC_URL || 'https://galaxy-hub-9c74.onrender.com').replace(/\/$/, '')
const KEEPALIVE_EVERY_MS = 5 * 60 * 1000 // ทุก 5 นาที

const keepaliveLast = { at: 0, target: '', status: null, error: '' }

// รับลิงก์จากผู้ใช้: '' = ใช้ค่าเริ่มต้น · null = ไม่ถูกต้อง · อื่น ๆ = URL ที่จัดรูปแล้ว (ไม่ใส่ http(s):// จะเติม https:// ให้)
function normalizeKeepaliveUrl(raw) {
  const t = String(raw || '').trim()
  if (!t) return ''
  if (t.length > 300) return null
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^https?:\/\//i.test(t)) return null
    const u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch { return null }
}

// ลิงก์ที่จะยิงจริง: ใส่แค่โดเมนเปล่า ๆ → ต่อ /health ให้ · ใส่พาธมาเอง → ใช้ตามนั้น
function keepaliveTarget() {
  const custom = normalizeKeepaliveUrl(serverConfig.keepaliveUrl)
  if (custom) {
    try {
      const u = new URL(custom)
      if (u.pathname === '/' && !u.search) return u.origin + '/health'
    } catch {}
    return custom
  }
  return KEEPALIVE_URL + '/health'
}

function selfPing() {
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve(Object.assign({}, keepaliveLast)) } }
    let target = ''
    try {
      target = keepaliveTarget()
      keepaliveLast.target = target
      keepaliveLast.at = Date.now()
      const lib = target.startsWith('https') ? https : http
      let timedOut = false
      const req = lib.get(target, { timeout: 10000 }, (res) => {
        keepaliveLast.status = res.statusCode
        keepaliveLast.error = ''
        console.log('[KEEPALIVE] ping ' + target + ' -> ' + res.statusCode)
        res.resume()
        finish()
      })
      req.on('error', (e) => {
        keepaliveLast.status = null
        keepaliveLast.error = timedOut ? 'timeout (10s)' : e.message
        console.error('[KEEPALIVE] Ping failed:', keepaliveLast.error)
        finish()
      })
      req.on('timeout', () => { timedOut = true; req.destroy() })
    } catch (e) {
      keepaliveLast.status = null
      keepaliveLast.error = e && e.message ? e.message : String(e)
      console.error('[KEEPALIVE] Ping failed:', keepaliveLast.error)
      finish()
    }
  })
}

// API สำหรับหน้าตั้งค่า (/config) — บันทึกแล้วไม่รีคอนเน็กต์บอท
app.get('/api/keepalive', (req, res) => {
  res.json({ url: serverConfig.keepaliveUrl || '', effective: keepaliveTarget(), everyMin: Math.round(KEEPALIVE_EVERY_MS / 60000), last: keepaliveLast })
})
app.post('/api/keepalive', (req, res) => {
  const raw = String((req.body && req.body.url) || '').trim()
  const norm = normalizeKeepaliveUrl(raw)
  if (norm === null) return res.status(400).json({ error: 'ลิงก์ไม่ถูกต้อง (ต้องเป็น http:// หรือ https:// และยาวไม่เกิน 300 ตัวอักษร)' })
  serverConfig.keepaliveUrl = norm
  saveServerConfig()
  res.json({ ok: true, url: serverConfig.keepaliveUrl, effective: keepaliveTarget() })
})
app.post('/api/keepalive/ping', async (req, res) => {
  try { res.json(await selfPing()) } catch (e) { res.status(500).json({ error: e && e.message }) }
})

/* ---- PERF monitor: บอกว่า "ตัวโปรเซส Node ค้าง/ช้า" หรือเปล่า (สาเหตุหนึ่งของ disconnect.timeout = ตอบ keep_alive ไม่ทัน) ----
   ถ้า event loop ค้างเกิน ~1 วิ จะลง log [PERF] พร้อม CPU% และแรม — ไม่แตะการทำงานของบอท */
{
  let lastT = Date.now(), lastCpu = process.cpuUsage(), tickN = 0
  let lagN = 0, lagMax = 0, cpuMax = 0, lagSince = Date.now(), lastPerfLog = Date.now()
  const t = setInterval(() => {
    try {
      tickN++
      const now = Date.now()
      const lag = now - lastT - 1000
      const cu = process.cpuUsage(lastCpu)
      const cpuPct = Math.round(((cu.user + cu.system) / 1000) / Math.max(1, now - lastT) * 100)
      lastT = now; lastCpu = process.cpuUsage()
      if (lag >= 1000) { lagN++; if (lag > lagMax) lagMax = lag; if (cpuPct > cpuMax) cpuMax = cpuPct; perfLast.at = now; perfLast.ms = Math.round(lag) }

      // สรุปจำนวนแพ็กเก็ตที่ข้าม: ครั้งแรกที่ 1 นาที (ยืนยันว่าทำงาน) แล้วทุก 5 นาที — ลงถังเทคนิค ไม่ปน log/แชท
      if (tickN === 60 || tickN % 300 === 0) {
        const secs = tickN === 60 ? 60 : 300
        for (const m of bots.values()) {
          if (m && m.state && m.state._dropped) {
            pushLog(m.state, `[DROP] ข้ามแพ็กเก็ตที่ไม่ใช้ ${m.state._dropped} ตัวใน ~${secs === 60 ? '1' : '5'} นาที (~${Math.round(m.state._dropped / secs)}/วินาที)`)
            m.state._dropped = 0
          }
        }
      }

      // สรุปอาการค้าง: ลงเมื่อค้างหนัก (>=3 วิ) ห่างกันอย่างน้อย 2 นาที · ถ้าค้างเล็กน้อยสะสม จะสรุปทุก 10 นาที (ไม่ลงทุกครั้งที่ค้าง)
      const sinceLog = now - lastPerfLog
      if (lagN > 0 && ((lagMax >= 3000 && sinceLog >= 120000) || sinceLog >= 600000)) {
        lastPerfLog = now
        const rss = Math.round(process.memoryUsage().rss / 1048576)
        const mins = Math.max(1, Math.round((now - lagSince) / 60000))
        const msg = `[PERF] ใน ~${mins} นาทีที่ผ่านมา โปรเซสค้าง ${lagN} ครั้ง (สูงสุด ${Math.round(lagMax)}ms · CPU สูงสุด ${cpuMax}% · แรม ${rss}MB)` + (lagMax >= 3000 ? ' — ค้างหนัก เสี่ยงโดน disconnect.timeout' : '')
        for (const m of bots.values()) { if (m && m.state && (m.state.status === 'online' || m.state.status === 'connecting')) pushLog(m.state, msg) }
        lagN = 0; lagMax = 0; cpuMax = 0; lagSince = now
      }
    } catch {}
  }, 1000)
  if (t && t.unref) t.unref()
}

/* ===========================
   DISCORD WEBHOOK — แจ้งสถานะบอทแต่ละตัวแยกกัน
   • การ์ดสถานะ 1 ใบต่อบอท (ส่งครั้งแรกแล้ว "แก้ไขข้อความเดิม" ไม่ส่งใหม่รัว ๆ)
   • แจ้งเหตุการณ์: ออนไลน์ / ออฟไลน์-หลุด / reconnect (แนบ log 10 บรรทัดล่าสุด) / โดนแบน / ล็อกอินไม่ผ่าน / โค้ด Microsoft / รอใส่ PIN เอง
   • ตั้ง webhook ตัวรวมที่หน้า /config หรือตั้งเฉพาะบอทใน Settings ของบอทนั้น (ตั้งเองจะทับตัวรวม)
   • ใช้คิวส่งทีละข้อความ + รอตาม Discord rate-limit (429) ให้เอง
=========================== */
const WH_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_\-]+$/
const WH_STATUS_EVERY_MS = 5 * 60 * 1000   // รีเฟรชการ์ดสถานะอย่างน้อยทุก 5 นาที (เวลาออนไลน์ใช้ <t:..:R> ของ Discord เดินเอง)
const WH_CARD_MIN_GAP_MS = 10 * 1000       // แก้การ์ดเพราะสถานะเปลี่ยน ห่างกันอย่างน้อย 10 วิ ต่อบอท
const WH_DOWN_MIN_GAP_MS = 20 * 1000       // แจ้ง "หลุด" ห่างกันอย่างน้อย 20 วิ ต่อบอท
const WH_RECONNECT_NOTIFY_EVERY = 5        // ถ้า reconnect ไม่สำเร็จต่อเนื่อง แจ้งซ้ำทุก ๆ N ครั้ง (ครั้งแรกแจ้งเสมอ)
const WH_LOG_LINES = 10                    // จำนวนบรรทัด log ที่แนบตอนหลุด/reconnect
const WH_COLORS = { online: 0x2ecc71, down: 0xe74c3c, reconnect: 0xf1c40f, stopped: 0x95a5a6, warn: 0xe67e22, info: 0x3498db, banned: 0x992d22 }
const WH_DOWN_STATES = new Set(['offline', 'error', 'connection_error', 'kicked'])
const whQueues = new Map()

// ล้าง/ตรวจ URL: ตัด query/hash/ช่องว่าง/เครื่องหมาย / ท้ายออก — ไม่ถูกต้องคืน ''
function whNormalize(u) {
  if (typeof u !== 'string') return ''
  let s = u.trim().split('#')[0].split('?')[0].replace(/\/+$/, '')
  return s.length <= 300 && WH_RE.test(s) ? s : ''
}
function whMask(u) {
  const n = whNormalize(u)
  if (!n) return ''
  const m = n.match(/webhooks\/(\d+)\/(.+)$/)
  return m ? 'discord.com/api/webhooks/' + m[1] + '/••••' + m[2].slice(-4) : ''
}
function whUrlFor(state) { return whNormalize(state.webhookUrl) || whNormalize(serverConfig.discordWebhookUrl) }
function whEnabled(state) { return state.webhookOn !== false && !!whUrlFor(state) }
// ชื่อที่แสดงใน Discord — ถ้าเป็นอีเมล (บัญชี Microsoft) ปิดบังบางส่วน
function whLabel(state) {
  const n = String(state.username || state.originalUsername || '?')
  return n.includes('@') ? n.replace(/^(.{0,3}).*(@.*)$/, '$1***$2') : n
}
function whFmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
  return h > 0 ? `${h} ชม. ${m} นาที` : (m > 0 ? `${m} นาที ${x} วิ` : `${x} วิ`)
}
function whLogBlock(state) {
  const lines = (state.logs || []).slice(0, WH_LOG_LINES).reverse().map(l => String(l).replace(/`/g, "'").slice(0, 190))
  let body = lines.join('\n')
  if (body.length > 3500) body = body.slice(body.length - 3500)
  return '```\n' + (body || '(ยังไม่มี log)') + '\n```'
}
function whPayload(embed) {
  const e = Object.assign({ timestamp: new Date().toISOString(), footer: { text: 'Galaxy AFK Hub' } }, embed)
  return { username: 'Galaxy AFK Hub', embeds: [e], allowed_mentions: { parse: [] } }
}

function whRequest(method, urlStr, body, extraHeaders) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(urlStr) } catch (e) { return resolve({ status: 0, error: 'URL ไม่ถูกต้อง' }) }
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null
    const headers = { 'User-Agent': 'GalaxyAFKHub/2.1' }
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length }
    if (extraHeaders) Object.assign(headers, extraHeaders)
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 10000 }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch {}
        const ra = json && json.retry_after ? Number(json.retry_after) : (Number(res.headers['retry-after']) || 0)
        resolve({ status: res.statusCode, json, retryAfter: ra })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    if (data) req.write(data)
    req.end()
  })
}

// คิวต่อ webhook (ส่งทีละอัน เว้น ~0.7 วิ · เจอ 429 รอแล้วลองใหม่ · คิวยาวเกิน 40 ทิ้งอันเก่าสุด)
function whEnqueue(url, job) {
  let q = whQueues.get(url)
  if (!q) { q = { items: [], busy: false }; whQueues.set(url, q) }
  return new Promise((resolve) => {
    q.items.push({ job, resolve })
    while (q.items.length > 40) { const old = q.items.shift(); old.resolve({ status: 0, error: 'คิวเต็ม' }) }
    whPump(q)
  })
}
async function whPump(q) {
  if (q.busy) return
  q.busy = true
  try {
    while (q.items.length) {
      const it = q.items.shift()
      let res = null
      for (let t = 0; t < 3; t++) {
        try { res = await it.job() } catch (e) { res = { status: 0, error: e && e.message } }
        if (res && res.status === 429) { await sleep(Math.min(15000, Math.ceil((res.retryAfter || 1) * 1000) + 150)); continue }
        break
      }
      it.resolve(res || { status: 0, error: 'unknown' })
      await sleep(700)
    }
  } finally { q.busy = false }
}

function whSendEmbed(state, embed) {
  const url = whUrlFor(state)
  if (!url || state.webhookOn === false) return Promise.resolve(null)
  return whEnqueue(url, () => whRequest('POST', url, whPayload(embed))).then((r) => {
    if (r && (r.status < 200 || r.status >= 300)) whLogFail(state, r)
    return r
  })
}
function whLogFail(state, r) {
  const w = state._wh || (state._wh = {})
  const now = Date.now()
  if (w.failAt && now - w.failAt < 60000) return
  w.failAt = now
  pushLog(state, `[WEBHOOK] ส่ง Discord ไม่สำเร็จ (${r && r.status ? 'HTTP ' + r.status : (r && r.error) || '?'})${r && (r.status === 404 || r.status === 401) ? ' — webhook ถูกลบ/ผิด ตรวจที่ /config' : ''}`)
}
function whNotifyCustom() { /* ปิด: ข้อมูลทั้งหมดรวมอยู่ในการ์ดเดียวต่อบอท */ }
function whNotifyMsa(state, m) {
  if (!whEnabled(state)) return
  whSendEmbed(state, {
    color: WH_COLORS.warn,
    title: '🔐 ' + whLabel(state) + ' ต้องยืนยันตัวตน Microsoft',
    description: `เปิด ${m.uri} แล้วใส่โค้ด **${m.code}**\nโค้ดหมดอายุ <t:${Math.floor(m.until / 1000)}:R> — บอทจะรอจนกว่าโค้ดจะหมดอายุ ไม่ขอโค้ดใหม่ให้`
  })
}

// ---- ปุ่มใน Discord: webhook ธรรมดารับปุ่ม "ลิงก์" ได้เท่านั้น (ปุ่มโต้ตอบต้องมีบอทแอป) → กดแล้วเปิดลิงก์มาที่ Hub ให้ทำคำสั่งนั้น ----
const TPA_ACCEPT_CMD = process.env.TPA_ACCEPT_CMD || '/tpaccept'
const TPA_DENY_CMD = process.env.TPA_DENY_CMD || '/tpdeny'
const actTokens = new Map()
function hubBase() {
  const custom = normalizeKeepaliveUrl(serverConfig.keepaliveUrl)
  try { if (custom) return new URL(custom).origin } catch {}
  return KEEPALIVE_URL
}
function actUrl(token, action) { return hubBase() + '/act/' + token + '/' + action }

const actKeys = new Map()
function actToken(info) {
  const key = JSON.stringify(info)
  const exp = Date.now() + 10 * 60 * 1000
  const old = actKeys.get(key)
  if (old) { const v = actTokens.get(old); if (v) { v.exp = exp; return old } }
  const token = require('crypto').randomBytes(10).toString('hex')
  actTokens.set(token, Object.assign({}, info, { exp }))
  actKeys.set(key, token)
  return token
}
function whBtn(label, info) { return { type: 2, style: 5, label: String(label || '⌫').slice(0, 40), url: actUrl(actToken(info), 'go') } }
function isTpaUi(u) {
  return !!(u && u.window && u.window.slots.some(x => /ยอมรับ|accept/i.test(x.label || '')) && u.window.slots.some(x => /ปฏิเสธ|deny|decline|reject/i.test(x.label || '')))
}

// UI ในเกม (dialog / หน้าต่าง) → ข้อความ + แถวปุ่มลิงก์ (สูงสุด 4 แถว)
function whUiParts(s, u) {
  const rows = []
  const mkRow = (items, per) => { for (let i = 0; i < items.length && rows.length < 4; i += per) rows.push({ type: 1, components: items.slice(i, i + per) }) }
  let title = '', text = ''
  if (u.dialog) {
    const d = u.dialog
    title = '🧩 เซิร์ฟเวอร์เปิดหน้าต่าง (Dialog)'
    text = String(d.text || '(dialog)').slice(0, 700) + (d.dots ? '\n' + d.dots : '') + (d.left !== null && d.left !== undefined ? `\nเหลือโอกาสอีก ${d.left} ครั้ง` : '')
    const digits = {}
    d.buttons.forEach(b => { if (/^[0-9]$/.test(b.label) && !digits[b.label]) digits[b.label] = b })
    const mk = (b) => b ? whBtn(b.label || '⌫', { type: 'dlg', botId: s.id, i: b.i, label: b.label }) : whBtn('·', { type: 'noop', botId: s.id })
    if (Object.keys(digits).length >= 9) {
      const rest = d.buttons.filter(b => digits[b.label] !== b)
      const clr = rest.find(b => /ล้าง|clear|reset/i.test(b.label))
      const back = rest.find(b => b !== clr && (b.label === '' || /ลบ|back|del|⌫/i.test(b.label)))
      mkRow(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(k => mk(digits[k])), 3)
      rows.push({ type: 1, components: [mk(clr), mk(digits['0']), mk(back)] })
    } else mkRow(d.buttons.slice(0, 20).map(mk), 5)
  } else if (u.window) {
    const w = u.window
    title = `🧩 หน้าต่างในเกม "${w.title || w.type}"`
    const filled = w.slots.filter(x => x.label && !/glass_pane/.test(x.id || '')).slice(0, 20)
    text = filled.map(x => `#${x.s} ${x.label}${x.n > 1 ? ' x' + x.n : ''}`).join('\n').slice(0, 700) || '(ว่าง)'
    mkRow(filled.map(x => whBtn(`${x.label}${x.n > 1 ? ' x' + x.n : ''}`, { type: 'win', botId: s.id, slot: x.s, label: x.label })), 5)
  }
  return { title, text, rows }
}

// การ์ดเดียวต่อบอท: สถานะ + (ถ้ามี) คำขอ TPA + UI/แป้น PIN ในเกม — แก้ไขข้อความเดิมเสมอ ไม่ส่งข้อความใหม่
function whCard(m, s, opts) {
  const embed = whStatusEmbed(s, opts)
  const rows = []
  if (!m || (opts && opts.shutdown)) return { embed, rows }
  if (s.status !== 'online') {
    if (s.status !== 'stopped') {
      const lines = (s.logs || []).slice(0, 6).reverse().map(l => String(l).replace(/`/g, "'").slice(0, 110))
      embed.fields.push({ name: '📜 Log ล่าสุด', value: '```\n' + (lines.join('\n') || '(ยังไม่มี log)') + '\n```' })
    }
    return { embed, rows }
  }
  let t = {}, u = {}
  try { t = m.tpaState() } catch {}
  try { u = m.uiState() } catch {}
  let need = false
  if (t.pending) {
    need = true
    embed.fields.push({ name: '📨 คำขอเทเลพอร์ต', value: `**${t.pending.from || 'ผู้เล่น'}** ${t.pending.kind === 'here' ? 'ขอให้บอทไปหา (tpahere)' : 'ขอเทเลพอร์ตมาหาบอท'} · หมดอายุใน ~${t.pending.left} วิ` })
    rows.push({ type: 1, components: [
      { type: 2, style: 5, label: '✅ ยอมรับ', url: actUrl(t.pending.token, 'accept') },
      { type: 2, style: 5, label: '❌ ไม่ยอมรับ', url: actUrl(t.pending.token, 'deny') }
    ] })
  } else if (t.last) {
    embed.fields.push({ name: '📨 TPA ล่าสุด', value: `${t.last.status === 'accepted' ? '✅ ยอมรับ' : '❌ ไม่ยอมรับ'}${t.last.auto ? 'อัตโนมัติ' : ''} · ${t.last.from || 'ผู้เล่น'} · <t:${Math.floor(t.last.at / 1000)}:R>` })
  }
  if (u && !isTpaUi(u) && ((u.dialog && !u.dialog.closed) || u.window)) {
    const p = whUiParts(s, u)
    need = true
    embed.fields.push({ name: p.title, value: p.text || '-' })
    for (const r of p.rows) if (rows.length < 5) rows.push(r)
  }
  if (need) embed.color = WH_COLORS.warn
  if (rows.length) {
    const dash = { type: 2, style: 5, label: '🌐 เปิดแดชบอร์ด', url: hubBase() + '/bot/' + s.id }
    const last = rows[rows.length - 1]
    if (last.components.length < 5) last.components.push(dash)
    else if (rows.length < 5) rows.push({ type: 1, components: [dash] })
  }
  return { embed, rows }
}

// ตรวจว่า TPA/UI เปลี่ยนไหม → สั่งให้แก้การ์ดเร็ว ๆ (ห่าง ≥ 2 วิ)
function whCardWatch(m, s, now, w) {
  let key = ''
  try {
    if (s.status === 'online') {
      const t = m.tpaState()
      const u = m.uiState()
      key = (t.pending ? 'tpa:' + t.pending.token : '') + '|' + (t.last ? 'last:' + t.last.at + t.last.status : '')
      if (u.dialog && !u.dialog.closed) {
        const pad = u.dialog.buttons.filter(b => /^[0-9]$/.test(b.label)).length >= 9
        key += pad ? '|pad:' + (u.dialog.dots || '') + ':' + u.dialog.left : '|dlg:' + u.dialog.text + u.dialog.buttons.map(b => b.label).join(',')
      } else if (u.window && !isTpaUi(u)) key += '|win:' + u.window.title + u.window.slots.filter(x => x.label).map(x => x.label + x.n).join(',')
    }
  } catch {}
  if (key !== w.cardKey) { w.cardKey = key; w.cardDue = true; w.urgent = true }
}

app.get('/act/:token/:action', async (req, res) => {
  if (/discordbot/i.test(String(req.headers['user-agent'] || ''))) return res.status(204).end() // กันบอทพรีวิวลิงก์กดแทน
  const page = (ok, title, msg) => res.status(ok ? 200 : 410).send(`<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1020;color:#e5e7eb;font-family:Kanit,system-ui,sans-serif;text-align:center"><div style="padding:24px"><div style="font-size:44px">${ok ? '✅' : '⚠️'}</div><h2 style="margin:8px 0">${escapeHtml(title)}</h2><p style="color:#9ca3af">${escapeHtml(msg)}</p></div><script>setTimeout(function(){try{window.close()}catch(e){}},1500)</script></body></html>`)
  const info = actTokens.get(req.params.token)
  if (!info || info.exp < Date.now()) return page(false, 'ลิงก์หมดอายุแล้ว', 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว')
  const m = bots.get(info.botId)
  if (!m) return page(false, 'ไม่พบบอท', 'บอทตัวนี้ถูกลบไปแล้ว')
  try {
    let r
    if (info.type === 'tpa') {
      const a = req.params.action
      if (a !== 'accept' && a !== 'deny') return page(false, 'คำสั่งไม่ถูกต้อง', '')
      r = await m.tpaRespond(req.params.token, a === 'accept')
      if (r.ok) actTokens.delete(req.params.token)
      return page(!!r.ok, r.ok ? (a === 'accept' ? 'ยอมรับคำขอแล้ว' : 'ไม่ยอมรับคำขอแล้ว') : 'ทำไม่สำเร็จ', r.ok ? 'บอทส่งคำสั่งในเกมแล้ว' : (r.error || ''))
    }
    if (info.type === 'dlg') r = await m.uiDialogClick(info.i, info.label)
    else if (info.type === 'win') r = await m.uiWindowClick(info.slot, info.label)
    else return page(false, 'ปุ่มนี้ใช้ไม่ได้', '')
    return page(!!(r && r.ok), r && r.ok ? 'กดในเกมแล้ว' : 'ทำไม่สำเร็จ', (r && r.error) || 'ส่งคำสั่งให้บอทแล้ว')
  } catch (e) { return page(false, 'ผิดพลาด', e.message) }
})

const WH_STATUS_ICON = { online: '🟢', connecting: '🟡', starting: '🟡', offline: '🔴', error: '🔴', connection_error: '🔴', kicked: '🟠', banned: '⛔', auth_failed: '🔒', stopped: '⚫' }
function whStatusEmbed(s, opts) {
  const m = bots.get(s.id)
  const b = m && m.bot
  let hp = '-', food = '-'
  try { if (b && s.status === 'online') { hp = String(Math.round(b.health || 0)); food = String(Math.round(b.food || 0)) } } catch {}
  const icon = WH_STATUS_ICON[s.status] || '⚪'
  const color = s.status === 'online' ? WH_COLORS.online : (s.status === 'connecting' || s.status === 'starting' ? WH_COLORS.reconnect : (s.status === 'stopped' ? WH_COLORS.stopped : (s.status === 'banned' ? WH_COLORS.banned : WH_COLORS.down)))
  const last = String(s.lastMessage || '-').replace(/`/g, "'").slice(0, 250)
  return {
    color: opts && opts.shutdown ? WH_COLORS.stopped : color,
    title: `${icon} ${whLabel(s)}`,
    description: opts && opts.shutdown ? '⚫ ระบบ Galaxy AFK Hub หยุดทำงาน/รีสตาร์ท' : undefined,
    fields: [
      { name: 'สถานะ', value: `${icon} ${s.status}`, inline: true },
      { name: 'เซิร์ฟเวอร์', value: `${serverConfig.host}:${serverConfig.port}`, inline: true },
      { name: 'ออนไลน์ตั้งแต่', value: s.status === 'online' && s.connectedAt ? `<t:${Math.floor(s.connectedAt / 1000)}:R>` : '-', inline: true },
      { name: '❤️ เลือด / 🍗 อาหาร', value: `${hp} / ${food}`, inline: true },
      { name: '🔄 Reconnect', value: s.status !== 'online' && s.reconnectInfo ? `ครั้งที่ ${s.reconnectInfo.attempt}` : '-', inline: true },
      { name: 'ประเภทบัญชี', value: s.accountType === 'premium' ? 'Microsoft' : 'Offline', inline: true },
      { name: 'ข้อความล่าสุด', value: last || '-' }
    ]
  }
}
// สร้าง/แก้ไขการ์ดสถานะของบอทตัวนี้ (ข้อความเดียวต่อบอท)
async function whUpdateStatus(s, opts) {
  const url = whUrlFor(s)
  if (!url || s.webhookOn === false) return
  const m = bots.get(s.id)
  const card = whCard(m, s, opts)
  const build = (asLinks) => {
    let e = card.embed
    if (asLinks && card.rows.length) {
      const links = card.rows.reduce((a, x) => a.concat(x.components), []).map(c => `[${c.label}](${c.url})`).join(' · ')
      e = Object.assign({}, e, { description: ((e.description || '') + '\n' + links).trim().slice(0, 4000) })
    }
    const payload = whPayload(e)
    payload.components = asLinks ? [] : card.rows // [] = ล้างปุ่มเก่าออก
    return payload
  }
  const send = async (method, u) => {
    let r = await whEnqueue(url, () => whRequest(method, u + (u.indexOf('?') >= 0 ? '&' : '?') + 'with_components=true', build(false)))
    if (r && r.status === 400 && card.rows.length) r = await whEnqueue(url, () => whRequest(method, u, build(true))) // webhook ไม่รับปุ่ม → ใช้ลิงก์ในข้อความ
    return r
  }
  if (s.webhookMsgId && s.webhookMsgUrl === url) {
    const r = await send('PATCH', url + '/messages/' + s.webhookMsgId)
    if (r && r.status >= 200 && r.status < 300) return
    if (!r || r.status !== 404) { if (r) whLogFail(s, r); return }
    s.webhookMsgId = null // ข้อความถูกลบ → สร้างใหม่
  }
  const r = await send('POST', url + '?wait=true')
  if (r && r.status >= 200 && r.status < 300 && r.json && r.json.id) {
    s.webhookMsgId = String(r.json.id)
    s.webhookMsgUrl = url
    scheduleSaveBots()
  } else if (r) whLogFail(s, r)
}

// เหตุการณ์ตอนสถานะเปลี่ยน
function whOnChange(s, w, prev, cur) {
  const now = Date.now()
  if (cur === 'online') { w.downSince = 0; w.lastNotified = 'online'; return }
  if (WH_DOWN_STATES.has(cur)) { if (!w.downSince) w.downSince = now; w.lastNotified = 'down'; return }
  w.lastNotified = cur
}

function whTick() {
  try {
    const now = Date.now()
    if (actTokens.size > 200) { for (const [k, v] of actTokens) if (v.exp < now) actTokens.delete(k); for (const [k, t] of actKeys) if (!actTokens.has(t)) actKeys.delete(k) }
    for (const m of bots.values()) {
      const s = m.state
      if (!whEnabled(s)) { if (s._wh) s._wh.last = null; continue }
      const w = s._wh || (s._wh = { last: null, downSince: 0, lastDownAt: 0, lastNotified: null, lastCard: 0, cardDue: true, cardBusy: false, failAt: 0 })
      const cur = s.status
      if (w.last === null) {
        w.last = cur
      } else if (cur !== w.last) {
        const prev = w.last
        w.last = cur
        w.cardDue = true
        try { whOnChange(s, w, prev, cur) } catch (e) { console.error('[WEBHOOK] event error:', e && e.message) }
      }
      try { whCardWatch(m, s, now, w) } catch {}
      const gap = now - (w.lastCard || 0)
      if (!w.cardBusy && ((w.cardDue && gap >= (w.urgent ? 2000 : WH_CARD_MIN_GAP_MS)) || gap >= WH_STATUS_EVERY_MS)) {
        w.cardDue = false
        w.urgent = false
        w.lastCard = now
        w.cardBusy = true
        whUpdateStatus(s).catch(() => {}).then(() => { w.cardBusy = false })
      }
    }
  } catch {}
}
{
  const whTimer = setInterval(whTick, 1000)
  if (whTimer && whTimer.unref) whTimer.unref()
}

// ปิดเซิร์ฟเวอร์: อัปเดตการ์ดทุกใบเป็น "ระบบหยุดทำงาน" (รอไม่เกิน ms)
async function whShutdown(ms) {
  const jobs = []
  for (const m of bots.values()) { if (whEnabled(m.state)) jobs.push(whUpdateStatus(m.state, { shutdown: true }).catch(() => {})) }
  if (!jobs.length) return
  await Promise.race([Promise.all(jobs), sleep(ms)])
}

// ---- API (หน้า /config) ----
app.get('/api/webhook', (req, res) => {
  res.json({
    set: !!whNormalize(serverConfig.discordWebhookUrl),
    masked: whMask(serverConfig.discordWebhookUrl),
    bots: Array.from(bots.values()).map(({ state }) => ({
      id: state.id,
      name: whLabel(state),
      status: state.status,
      on: state.webhookOn !== false,
      source: whNormalize(state.webhookUrl) ? 'own' : (whNormalize(serverConfig.discordWebhookUrl) ? 'global' : 'none')
    }))
  })
})
app.post('/api/webhook', (req, res) => {
  const body = req.body || {}
  if (body.clear === true || body.clear === 'true') {
    serverConfig.discordWebhookUrl = ''
  } else {
    const n = whNormalize(String(body.url || ''))
    if (!n) return res.status(400).json({ error: 'Webhook URL ไม่ถูกต้อง (ต้องเป็นลิงก์แบบ https://discord.com/api/webhooks/<id>/<token>)' })
    serverConfig.discordWebhookUrl = n
  }
  saveServerConfig()
  bots.forEach(m => { if (m.state._wh) m.state._wh.lastCard = 0 }) // ให้ทุกบอทสร้างการ์ดใหม่ทันที
  res.json({ ok: true, set: !!serverConfig.discordWebhookUrl, masked: whMask(serverConfig.discordWebhookUrl) })
})
app.post('/api/webhook/test', async (req, res) => {
  const url = whNormalize(String((req.body && req.body.url) || '')) || whNormalize(serverConfig.discordWebhookUrl)
  if (!url) return res.status(400).json({ ok: false, error: 'ยังไม่ได้ใส่ Webhook URL' })
  const r = await whEnqueue(url, () => whRequest('POST', url, whPayload({ color: WH_COLORS.info, title: '🔔 ทดสอบ webhook — Galaxy AFK Hub', description: 'ถ้าเห็นข้อความนี้ แปลว่า webhook ทำงานปกติ' })))
  res.json({ ok: !!r && r.status >= 200 && r.status < 300, status: r && r.status, error: r && r.error })
})

setInterval(selfPing, KEEPALIVE_EVERY_MS)
setTimeout(selfPing, 20 * 1000) // ยิงครั้งแรกหลังเปิดเซิร์ฟเวอร์ 20 วิ

/* ==========================================================================
   คำสั่งผ่าน Discord (/hub ...) — ใช้ "Interactions Endpoint URL" ของ Discord ไม่ต้องมีบอทออนไลน์ค้าง
   ตั้งค่า (env บน Render):
     DISCORD_PUBLIC_KEY      = Public Key ของแอปใน Developer Portal (ใช้ตรวจลายเซ็น)
     DISCORD_APP_ID          = Application ID
     DISCORD_BOT_TOKEN       = Bot Token (ใช้ตอนเปิดเซิร์ฟเวอร์เพื่อลงทะเบียนคำสั่งเท่านั้น)
     DISCORD_GUILD_ID        = (ไม่บังคับ) ID เซิร์ฟเวอร์ Discord — ใส่แล้วคำสั่งโผล่ทันที ไม่ต้องรอ
     DISCORD_ALLOWED_USERS   = Discord ID ของคนที่สั่งได้ คั่นด้วย , (ดู ID ได้จาก /hub whoami)
   แล้วนำ  <PUBLIC_URL>/discord/interactions  ไปใส่ที่ Interactions Endpoint URL
   ========================================================================== */
const DC_PUBKEY = (process.env.DISCORD_PUBLIC_KEY || '').trim()
const DC_ALLOWED = (process.env.DISCORD_ALLOWED_USERS || '').split(',').map(x => x.trim()).filter(Boolean)
const dcBotOpt = { type: 3, name: 'bot', description: 'ชื่อ/ID บอท (ไม่ใส่ = บอทตัวเดียวที่มี)', required: false, autocomplete: true }
const dcSub = (name, description, options) => ({ type: 1, name, description, options: options || [] })
const DC_COMMANDS = [{
  name: 'hub',
  description: 'สั่งบอท Galaxy AFK Hub',
  options: [
    dcSub('whoami', 'ดู Discord ID ของคุณ (ไว้ใส่ DISCORD_ALLOWED_USERS)'),
    dcSub('list', 'รายชื่อบอททั้งหมดและสถานะ'),
    dcSub('status', 'ดูสถานะบอท', [dcBotOpt]),
    dcSub('say', 'ให้บอทพิมพ์แชท/คำสั่งในเกม (ขึ้นต้นด้วย / = คำสั่ง)', [{ type: 3, name: 'text', description: 'ข้อความหรือคำสั่ง', required: true }, dcBotOpt]),
    dcSub('tpa', 'ตอบคำขอเทเลพอร์ตที่รออยู่', [{ type: 3, name: 'action', description: 'ยอมรับ หรือ ไม่ยอมรับ', required: true, choices: [{ name: 'ยอมรับ', value: 'accept' }, { name: 'ไม่ยอมรับ', value: 'deny' }] }, dcBotOpt]),
    dcSub('tpmode', 'ตั้งโหมดรับ TPA ของบอท', [{ type: 3, name: 'mode', description: 'auto = ยอมรับให้เอง · manual = รอให้กดเลือก', required: true, choices: [{ name: 'ยอมรับอัตโนมัติ', value: 'auto' }, { name: 'ให้ฉันเลือกเอง', value: 'manual' }] }, dcBotOpt]),
    dcSub('pin', 'กรอก PIN ในแป้นที่เซิร์ฟเวอร์เปิดอยู่ตอนนี้', [{ type: 3, name: 'code', description: 'เลข PIN (ไม่ใส่ = ใช้ PIN ที่บันทึกไว้)', required: false }, dcBotOpt]),
    dcSub('start', 'เริ่ม/เชื่อมต่อบอท', [dcBotOpt]),
    dcSub('stop', 'หยุดบอท', [dcBotOpt]),
    dcSub('reconnect', 'ตัดแล้วเชื่อมต่อใหม่', [dcBotOpt])
  ]
}]

function dcVerify(req) {
  try {
    const sig = req.headers['x-signature-ed25519']
    const ts = req.headers['x-signature-timestamp']
    if (!DC_PUBKEY || !sig || !ts || !req.rawBody) return false
    const nodeCrypto = require('crypto')
    const key = nodeCrypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(DC_PUBKEY, 'hex')]), format: 'der', type: 'spki' })
    return nodeCrypto.verify(null, Buffer.concat([Buffer.from(String(ts)), req.rawBody]), key, Buffer.from(String(sig), 'hex'))
  } catch { return false }
}

function dcResolveBot(q) {
  const all = Array.from(bots.values())
  if (q === undefined || q === null || q === '') return all.length === 1 ? all[0] : null
  const s = String(q).trim().toLowerCase()
  const nm = (m) => String(m.state.originalUsername || '').toLowerCase()
  return all.find(m => String(m.state.id) === s) || all.find(m => nm(m) === s) || all.find(m => whLabel(m.state).toLowerCase() === s) || all.find(m => nm(m).includes(s)) || null
}

async function dcRun(sub, o) {
  if (sub === 'list') {
    const all = Array.from(bots.values())
    if (!all.length) return { content: '📭 ยังไม่มีบอท' }
    return { content: all.map(m => `${m.state.status === 'online' ? '🟢' : (m.state.status === 'stopped' ? '⚫' : '🔴')} **${whLabel(m.state)}** (ID ${m.state.id}) · ${m.state.status} · ออนไลน์มา ${getUptime(m.state)}`).join('\n').slice(0, 1900) }
  }
  const m = dcResolveBot(o.bot)
  if (!m) return { content: bots.size ? '❓ ไม่พบบอทนั้น (หรือมีหลายตัวต้องระบุ `bot`) — ดูรายชื่อด้วย `/hub list`' : '📭 ยังไม่มีบอท' }
  const s = m.state
  const name = whLabel(s)
  switch (sub) {
    case 'status': return { embeds: [whStatusEmbed(s)] }
    case 'say': {
      if (s.status !== 'online') return { content: `⚠️ **${name}** ไม่ได้ออนไลน์ (${s.status})` }
      const text = String(o.text || '').trim()
      if (!text) return { content: '⚠️ ข้อความว่าง' }
      m.sendChat(text)
      return { content: `💬 **${name}** ส่งแล้ว: \`${text.replace(/`/g, "'").slice(0, 200)}\`` }
    }
    case 'tpa': {
      const t = m.tpaState()
      if (!t.pending) return { content: `📭 **${name}** ไม่มีคำขอ TPA ที่รออยู่${t.last ? ` (ล่าสุด: ${t.last.status === 'accepted' ? 'ยอมรับ' : 'ไม่ยอมรับ'} ${t.last.from || ''})` : ''}` }
      const r = await m.tpaRespond(t.pending.token, o.action === 'accept')
      return { content: r.ok ? `${o.action === 'accept' ? '✅ ยอมรับ' : '❌ ไม่ยอมรับ'}คำขอจาก **${t.pending.from || 'ผู้เล่น'}** แล้ว` : `⚠️ ${r.error || 'ทำไม่สำเร็จ'}` }
    }
    case 'tpmode':
      s.autoTpa = o.mode === 'auto'
      scheduleSaveBots()
      return { content: s.autoTpa ? `🤖 **${name}**: จะยอมรับ TPA ให้อัตโนมัติ` : `✋ **${name}**: จะแจ้งแล้วรอให้คุณกดเลือกเอง` }
    case 'pin': {
      const r = await m.pinEnter(o.code)
      return { content: r.ok ? `🔢 **${name}** กด PIN ครบ ${r.count} หลักแล้ว` : `⚠️ ${r.error}` }
    }
    case 'start': m.connect(); return { content: `▶️ สั่ง **${name}** เชื่อมต่อแล้ว` }
    case 'stop': m.stop(); return { content: `⏹️ หยุด **${name}** แล้ว` }
    case 'reconnect': m.stop(); await new Promise(r => setTimeout(r, 1500)); m.connect(); return { content: `🔄 **${name}** กำลังเชื่อมต่อใหม่` }
  }
  return { content: '❓ คำสั่งนี้ไม่รู้จัก' }
}

app.post('/discord/interactions', async (req, res) => {
  if (!dcVerify(req)) return res.status(401).send('invalid request signature')
  const it = req.body || {}
  if (it.type === 1) return res.json({ type: 1 }) // PING (ตอนกดบันทึก Interactions Endpoint URL)
  const user = (it.member && it.member.user) || it.user || {}
  const uid = String(user.id || '')
  const data = it.data || {}
  const sub = data.name === 'hub' && data.options && data.options[0]
  const opts = {}
  if (sub && sub.options) for (const x of sub.options) opts[x.name] = x.value
  if (it.type === 4) { // autocomplete ชื่อบอท
    if (!DC_ALLOWED.includes(uid)) return res.json({ type: 8, data: { choices: [] } })
    const q = String(opts.bot || '').toLowerCase()
    const choices = Array.from(bots.values())
      .filter(m => !q || whLabel(m.state).toLowerCase().includes(q) || String(m.state.id) === q)
      .slice(0, 25).map(m => ({ name: (whLabel(m.state) + ' · ' + m.state.status).slice(0, 100), value: String(m.state.id) }))
    return res.json({ type: 8, data: { choices } })
  }
  const reply = (content) => res.json({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } })
  if (it.type !== 2 || !sub) return reply('❓ คำสั่งนี้ไม่รู้จัก')
  if (sub.name === 'whoami') return reply(`🪪 Discord ID ของคุณ: \`${uid}\`\n${DC_ALLOWED.includes(uid) ? '✅ อยู่ในรายการที่สั่งบอทได้แล้ว' : '⛔ ยังสั่งบอทไม่ได้ — เอา ID นี้ไปใส่ใน env `DISCORD_ALLOWED_USERS` แล้วรีสตาร์ท'}`)
  if (!DC_ALLOWED.includes(uid)) return reply('⛔ คุณยังไม่มีสิทธิ์สั่งบอท — ใช้ `/hub whoami` ดู ID แล้วให้เจ้าของใส่ใน `DISCORD_ALLOWED_USERS`')
  if (sub.name === 'list') { const o = await dcRun('list', opts); return reply(o.content) }
  res.json({ type: 5, data: { flags: 64 } }) // รับทราบก่อน (Discord ให้เวลา 3 วิ) แล้วค่อยแก้ข้อความตอบกลับ
  let out
  try { out = await dcRun(sub.name, opts) } catch (e) { out = { content: '⚠️ ' + e.message } }
  out.allowed_mentions = { parse: [] }
  const r = await whRequest('PATCH', `https://discord.com/api/v10/webhooks/${it.application_id}/${it.token}/messages/@original`, out)
  if (r && r.status && (r.status < 200 || r.status >= 300)) console.log('[DISCORD] ตอบคำสั่งไม่สำเร็จ HTTP ' + r.status)
})

async function dcRegisterCommands() {
  const appId = (process.env.DISCORD_APP_ID || '').trim()
  const tok = (process.env.DISCORD_BOT_TOKEN || '').trim()
  if (!appId || !tok) { console.log('[DISCORD] ไม่ได้ตั้ง DISCORD_APP_ID / DISCORD_BOT_TOKEN — ข้ามการลงทะเบียนคำสั่ง /hub'); return }
  const guild = (process.env.DISCORD_GUILD_ID || '').trim()
  const url = `https://discord.com/api/v10/applications/${appId}/${guild ? 'guilds/' + guild + '/' : ''}commands`
  const r = await whRequest('PUT', url, DC_COMMANDS, { Authorization: 'Bot ' + tok })
  console.log(r && r.status >= 200 && r.status < 300 ? `[DISCORD] ลงทะเบียนคำสั่ง /hub แล้ว (${guild ? 'เซิร์ฟเวอร์ ' + guild : 'ทั่วไป — อาจใช้เวลาสักพักกว่าจะโผล่'})` : `[DISCORD] ลงทะเบียนคำสั่งไม่สำเร็จ HTTP ${r && r.status}: ${JSON.stringify(r && (r.json || r.error)).slice(0, 300)}`)
}

async function startServer() {
  // ดึง config จาก GitHub ก่อน (ถ้าตั้ง env ไว้) แล้วค่อยโหลดเข้าระบบ
  try { await ghPull() } catch (e) { console.error('[GITHUB] ดึงข้อมูลตอนเปิดไม่สำเร็จ — ใช้ไฟล์ในเครื่องแทน:', e.message) }
  loadServerConfig()  // โหลด server config ก่อน
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' +
    '╔════════════════════════════════════════╗\n' +
    '║   🌌 GALAXY AFK HUB v2.1              ║\n' +
    '╚════════════════════════════════════════╝\n')
  console.log('🚀 Server: http://localhost:' + PORT)
  console.log('📦 Config: bots_config.json, server_config.json')
  console.log('💡 Press Ctrl+C to stop\n')
  loadBots()
  setTimeout(() => { dcRegisterCommands().catch(e => console.log('[DISCORD] register error:', e.message)) }, 3000)
})
}
startServer()
