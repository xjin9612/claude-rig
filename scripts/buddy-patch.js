#!/usr/bin/env node
/**
 * buddy-patch.js — Claude Code Buddy 完整 Patcher（單檔版）
 *
 * 合併 buddy-core.js + buddy-patch.js，不再需要額外依賴。
 *
 * 用法：
 *   node buddy-patch.js status
 *   node buddy-patch.js search  --species dragon --rarity legendary --shiny
 *   node buddy-patch.js apply   --salt "lab-00000001234"
 *   node buddy-patch.js stats   --debugging 100 --patience 100 --chaos 0 --wisdom 100 --snark 0
 *   node buddy-patch.js restore
 *   node buddy-patch.js auto    --species dragon --rarity legendary --shiny \
 *                               --debugging 100 --patience 100 --chaos 0 --wisdom 100 --snark 0
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');

// ═══════════════════════════════════════════════════════════════════════════════
// buddy-core：常數與核心演算法
// ═══════════════════════════════════════════════════════════════════════════════

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const RARITY_WEIGHTS = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 };
const SPECIES = [
  'duck','goose','blob','cat','dragon','octopus','owl','penguin',
  'turtle','snail','ghost','axolotl','capybara','cactus','robot',
  'rabbit','mushroom','chonk',
];
const EYES = ['·', '✦', '×', '◉', '@', '°'];
const HATS = ['none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck'];
const STAT_NAMES = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK'];
const RARITY_FLOOR = { common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50 };
const DEFAULT_SALT = 'friend-2026-401';

// ─── PRNG ─────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  // Bun runtime 使用 Bun.hash()，與 Claude Code binary 內部行為一致
  if (typeof Bun !== 'undefined')
    return Number(BigInt(Bun.hash(str)) & 0xffffffffn);
  // Node.js fallback：FNV-1a
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function rollRarity(rng) {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (const rarity of RARITIES) {
    roll -= RARITY_WEIGHTS[rarity];
    if (roll < 0) return rarity;
  }
  return 'common';
}

function rollStats(rng, rarity) {
  const floor = RARITY_FLOOR[rarity];
  const peak = pick(rng, STAT_NAMES);
  let dump = pick(rng, STAT_NAMES);
  while (dump === peak) dump = pick(rng, STAT_NAMES);
  const stats = {};
  for (const name of STAT_NAMES) {
    if (name === peak)      stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30));
    else if (name === dump)  stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15));
    else                     stats[name] = floor + Math.floor(rng() * 40);
  }
  return stats;
}

function rollWithSalt(userId, salt) {
  const rng = mulberry32(hashString(userId + salt));
  const rarity = rollRarity(rng);
  return {
    rarity,
    species: pick(rng, SPECIES),
    eye: pick(rng, EYES),
    hat: rarity === 'common' ? 'none' : pick(rng, HATS),
    shiny: rng() < 0.01,
    stats: rollStats(rng, rarity),
    inspirationSeed: Math.floor(rng() * 1e9),
  };
}

function detectUserId() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', '.config.json'),
    path.join(home, '.claude.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const config = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const userId = config.oauthAccount?.accountUuid || config.userID;
      if (userId) return userId;
    } catch { /* 略過格式錯誤的檔案 */ }
  }
  throw new Error(`無法從 ${candidates.join(', ')} 偵測 userId`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// buddy-patch：Binary 操作與指令
// ═══════════════════════════════════════════════════════════════════════════════

const BACKUP_FILE = path.join(os.homedir(), '.claude-buddy-patch.json');
const SALT_PATTERNS = [
  /friend-\d{4}-\d+/,
  /ccbf-\d{10}/,
  /lab-\d{11}/,
];

// Stat 算法的唯一 pattern（從 strings 輸出確認存在於 v2.1.90）
const STAT_PATTERN_STR =
  'f[A]=Math.min(100,q+50+Math.floor(H()*30));else if(A===_)f[A]=Math.max(1,q-10+Math.floor(H()*15));else f[A]=q+Math.floor(H()*40)';

const R='\x1b[0m',B='\x1b[1m',D='\x1b[2m',RE='\x1b[31m',GR='\x1b[32m',YL='\x1b[33m';

// ─── Binary 工具 ──────────────────────────────────────────────────────────────

function findRealBinary() {
  let bin;
  try { bin = cp.execSync('which claude', { encoding: 'utf8' }).trim(); }
  catch { throw new Error('找不到 claude 指令'); }
  try { bin = fs.realpathSync(bin); } catch {}
  if (!fs.existsSync(bin)) throw new Error(`Binary 不存在：${bin}`);
  return bin;
}

function detectCurrentSalt(content) {
  for (const pat of SALT_PATTERNS) {
    const m = content.match(pat);
    if (m) return m[0];
  }
  return null;
}

function patchBuffer(buf, oldStr, newStr) {
  if (oldStr.length !== newStr.length)
    throw new Error(`字串長度不符（${oldStr.length} vs ${newStr.length}）`);
  const search  = Buffer.from(oldStr, 'utf8');
  const replace = Buffer.from(newStr, 'utf8');
  let count = 0, pos = 0;
  while (true) {
    const idx = buf.indexOf(search, pos);
    if (idx === -1) break;
    replace.copy(buf, idx);
    count++;
    pos = idx + 1;
  }
  return count;
}

function writeBinary(binPath, buf) {
  fs.writeFileSync(binPath, buf);
  if (process.platform === 'darwin') {
    try { cp.execFileSync('codesign', ['--force', '--sign', '-', binPath], { stdio: 'pipe' }); }
    catch { console.warn(`${YL}警告：macOS 簽名失敗${R}`); }
  }
}

// ─── Stats Patch ──────────────────────────────────────────────────────────────

function buildStatReplacement(stats) {
  const origLen = STAT_PATTERN_STR.length; // 128
  // 結構固定 36 chars：f[A]=<P>;else if(A===_)f[A]=<D>;else f[A]=<O>
  // 三個公式槽共 92 chars
  const available = origLen - 36;

  // 用 +.0 / +0 填充至目標長度（JS 合法，不影響數值結果）
  function padFormula(base, targetLen) {
    let f = base;
    let rem = targetLen - base.length;
    if (rem < 0) return null;
    while (rem >= 3) { f += '+.0'; rem -= 3; }
    while (rem >= 2) { f += '+0';  rem -= 2; }
    if (rem === 1) {
      const qi = f.indexOf('?');
      if (qi > 0) { f = f.slice(0, qi) + ' ' + f.slice(qi); rem = 0; }
      else return null;
    }
    return f;
  }

  // 將同一公式塞入 3 個槽（P/D/O），自動分配 padding
  function tryFormula(formula) {
    const len = formula.length;
    if (len * 3 > available) return null;
    const pad = available - len * 3;
    // 嘗試不同 padding 分配，避免 rem=1 失敗
    for (const [dp, extra] of [[0, pad], [3, pad-3], [2, pad-2]]) {
      if (extra < 0) continue;
      const D = dp > 0 ? padFormula(formula, len + dp) : formula;
      const O = padFormula(formula, len + extra);
      if (D && O) {
        const r = `f[A]=${formula};else if(A===_)f[A]=${D};else f[A]=${O}`;
        if (r.length === origLen) return r;
      }
    }
    return null;
  }

  const unique = [...new Set(STAT_NAMES.map(n => stats[n]))];

  // ── 策略 1：全同值（如全 100 或全 0）─────────────────────────────────────
  if (unique.length === 1) {
    const r = tryFormula(String(unique[0]));
    if (r) return { ok: true, replacement: r };
  }

  // ── 策略 2：兩組值 ───────────────────────────────────────────────────────
  if (unique.length === 2) {
    // 2a：A[2] 判斷（CHAOS/SNARK 的第 3 字元 ='A'，其餘 >'A'）
    const groupA = STAT_NAMES.filter(n => n[2] === 'A'); // CHAOS, SNARK
    const groupB = STAT_NAMES.filter(n => n[2] !== 'A'); // DEBUGGING, PATIENCE, WISDOM
    const valA = stats[groupA[0]], valB = stats[groupB[0]];
    if (groupA.every(n => stats[n] === valA) && groupB.every(n => stats[n] === valB)) {
      const r = tryFormula(`A[2]<"B"?${valA}:${valB}`);
      if (r) return { ok: true, replacement: r };
    }
    // 2b：A[0] 首字元判斷（C/D/P/S/W 各不同）
    const [v1, v2] = unique;
    const g1 = STAT_NAMES.filter(n => stats[n] === v1);
    const g2 = STAT_NAMES.filter(n => stats[n] === v2);
    const [minor, minV, majV] = g1.length <= g2.length ? [g1, v1, v2] : [g2, v2, v1];
    const ch = { CHAOS:'C', DEBUGGING:'D', PATIENCE:'P', SNARK:'S', WISDOM:'W' };
    if (minor.length === 1) {
      const r = tryFormula(`A[0]==="${ch[minor[0]]}"?${minV}:${majV}`);
      if (r) return { ok: true, replacement: r };
    }
    if (minor.length === 2) {
      // 嘗試 A[2] 相同字元
      if (minor[0][2] === minor[1][2]) {
        const r = tryFormula(`A[2]==="${minor[0][2]}"?${minV}:${majV}`);
        if (r) return { ok: true, replacement: r };
      }
      const r = tryFormula(`A[0]==="${ch[minor[0]]}"||A[0]==="${ch[minor[1]]}"?${minV}:${majV}`);
      if (r) return { ok: true, replacement: r };
    }
  }

  // ── 策略 3：A<"X" 排序鏈（支援 3～5 組不同值）────────────────────────────
  // 首字元排序：CHAOS < DEBUGGING < PATIENCE < SNARK < WISDOM
  {
    const c=stats.CHAOS, d=stats.DEBUGGING, p=stats.PATIENCE, s=stats.SNARK, w=stats.WISDOM;
    const expr = `A<"D"?${c}:A<"P"?${d}:A<"S"?${p}:A<"W"?${s}:${w}`;
    const r = tryFormula(expr);
    if (r) return { ok: true, replacement: r };
  }

  return { ok: false, reason: `公式超長無法塞入 ${available} chars（各值位數總和過大），建議減少不同值數量` };
}

function patchStats(buf, stats) {
  const res = buildStatReplacement(stats);
  if (!res.ok) return res;
  // 用 Buffer loop patch 所有出現位置（binary 中通常有 2 處）
  const search = Buffer.from(STAT_PATTERN_STR, 'utf8');
  const repBuf = Buffer.from(res.replacement, 'utf8');
  let count = 0, pos = 0;
  while (true) {
    const idx = buf.indexOf(search, pos);
    if (idx === -1) break;
    repBuf.copy(buf, idx);
    count++;
    pos = idx + 1;
  }
  if (count === 0) return { ok: false, reason: '找不到 stat pattern（版本可能已更新）' };
  return { ok: true, count };
}

// ─── 備份 ─────────────────────────────────────────────────────────────────────

function loadBackup() {
  try { return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8')); } catch { return {}; }
}
function saveBackup(data) {
  fs.writeFileSync(BACKUP_FILE, JSON.stringify({ ...loadBackup(), ...data }, null, 2));
}

// ─── Salt 搜尋 ────────────────────────────────────────────────────────────────

function generateSalt(prefix, index, length) {
  const suffixLength = Math.max(0, length - prefix.length);
  return prefix + String(index).padStart(suffixLength, '0').slice(-suffixLength);
}

function matchesFilters(result, filters) {
  if (filters.species && result.species !== filters.species) return false;
  if (filters.rarity  && result.rarity  !== filters.rarity)  return false;
  if (filters.eye     && result.eye     !== filters.eye)      return false;
  if (filters.hat     && result.hat     !== filters.hat)      return false;
  if (filters.shiny   && !result.shiny)                       return false;
  if (filters.minStat && result.stats[filters.minStat.name] < filters.minStat.threshold) return false;
  return true;
}

function searchSalt({ userId, species, rarity, eye, hat, shiny, minStat, total = 500000 }) {
  const len = DEFAULT_SALT.length;
  const filters = { species, rarity, eye, hat, shiny, minStat };
  for (let i = 0; i < total; i++) {
    const salt = generateSalt('lab-', i, len);
    const b = rollWithSalt(userId, salt);
    if (matchesFilters(b, filters)) return { salt, buddy: b };
  }
  return null;
}

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--shiny') { args.shiny = true; continue; }
    if (!t.startsWith('--')) { args._.push(t); continue; }
    const key = t.slice(2);
    const val = argv[i + 1];
    if (!val || val.startsWith('--')) throw new Error(`--${key} 缺少值`);
    args[key] = val; i++;
  }
  return args;
}

function parseStats(args) {
  const stats = {};
  let any = false;
  for (const name of STAT_NAMES) {
    const key = name.toLowerCase();
    if (args[key] !== undefined) {
      const v = Number(args[key]);
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error(`${name} 須為 0~100`);
      stats[name] = v;
      any = true;
    }
  }
  if (!any) return null;
  // 未指定的屬性預設 0（降低公式複雜度，確保 patch 成功）
  for (const name of STAT_NAMES) if (stats[name] === undefined) stats[name] = 0;
  return stats;
}

function parseMinStat(value) {
  if (!value) return null;
  const [rawName, rawThreshold] = value.split(':');
  const name = String(rawName || '').trim().toUpperCase();
  const threshold = Number(rawThreshold);
  if (!STAT_NAMES.includes(name) || !Number.isFinite(threshold))
    throw new Error(`無效的 min-stat 值：${value}`);
  return { name, threshold };
}

// ─── 指令 ─────────────────────────────────────────────────────────────────────

function cmdStatus() {
  const binPath = findRealBinary();
  const buf = fs.readFileSync(binPath);
  const str = buf.toString('utf8');
  const salt = detectCurrentSalt(str);
  const backup = loadBackup();
  const hasStatPattern = str.includes(STAT_PATTERN_STR);
  console.log(`\n${B}Binary 狀態${R}`);
  console.log(`  路徑：${D}${binPath}${R}`);
  console.log(`  大小：${D}${(buf.length/1024/1024).toFixed(1)} MB${R}`);
  console.log(`  當前 salt：${YL}${salt||'未找到'}${R}`);
  console.log(`  原始 salt：${D}${backup.originalSalt||'未記錄'}${R}`);
  console.log(`  Stat pattern：${hasStatPattern ? `${GR}找到✓${R}` : `${RE}未找到（版本不符）${R}`}`);
  console.log(`  Stats 已 patch：${backup.statsPatched ? `${YL}是${R}` : `${D}否${R}`}\n`);
}

function cmdSearch(args) {
  const userId  = args['user-id'] || detectUserId();
  const species = args.species;
  const rarity  = args.rarity;
  const eye     = args.eye;
  const hat     = args.hat;
  const shiny   = !!args.shiny;
  const minStat = parseMinStat(args['min-stat']);
  const total   = Number(args.total) || 500000;
  console.log(`\n搜尋：${species||'任意'} / ${rarity||'任意'} / ${shiny?'✨Shiny':'不限'}`);
  if (eye) console.log(`  眼睛：${eye}`);
  if (hat) console.log(`  帽子：${hat}`);
  if (minStat) console.log(`  最低屬性：${minStat.name} >= ${minStat.threshold}`);
  console.log(`userId：${D}${userId}${R}`);
  console.log(`搜尋 ${total.toLocaleString()} 次...\n`);
  const found = searchSalt({ userId, species, rarity, eye, hat, shiny, minStat, total });
  if (!found) { console.log(`${RE}未找到，請增加 --total 或放寬條件${R}`); return; }
  const { salt, buddy: b } = found;
  console.log(`${GR}${B}找到！${R}`);
  console.log(`  Salt：${YL}${salt}${R}`);
  console.log(`  ${b.species} ${b.rarity}${b.shiny?' ✨':''} 眼:${b.eye} 帽:${b.hat}`);
  for (const n of STAT_NAMES) console.log(`    ${n.padEnd(10)} ${b.stats[n]}`);
  console.log(`\n套用：${D}node buddy-patch.js apply --salt "${salt}"${R}\n`);
}

function cmdApply(args) {
  if (!args.salt) throw new Error('請提供 --salt <salt>');
  const binPath = findRealBinary();
  const buf = fs.readFileSync(binPath);
  const str = buf.toString('utf8');
  const oldSalt = detectCurrentSalt(str);
  if (!oldSalt) throw new Error('找不到 salt pattern');
  const newSalt = args.salt;
  if (newSalt.length !== oldSalt.length)
    throw new Error(`Salt 需要 ${oldSalt.length} 個字元，輸入了 ${newSalt.length} 個`);
  const backup = loadBackup();
  if (!backup.originalSalt) saveBackup({ originalSalt: oldSalt, binaryPath: binPath });
  const count = patchBuffer(buf, oldSalt, newSalt);
  writeBinary(binPath, buf);
  console.log(`${GR}Salt 更新：${oldSalt} → ${YL}${newSalt}${R}（${count} 處）`);
  console.log('重啟 Claude Code 生效');
}

function cmdStats(args) {
  const stats = parseStats(args);
  if (!stats) throw new Error('請提供屬性，例如 --debugging 100 --chaos 0');
  console.log('\n目標屬性：');
  for (const n of STAT_NAMES) console.log(`  ${n.padEnd(10)} ${stats[n]}`);
  const binPath = findRealBinary();
  const buf = fs.readFileSync(binPath);
  const res = patchStats(buf, stats);
  if (!res.ok) { console.error(`${RE}失敗：${res.reason}${R}`); process.exitCode=1; return; }
  writeBinary(binPath, buf);
  saveBackup({ statsPatched: true, customStats: stats });
  console.log(`${GR}屬性 patch 成功（${res.count} 處），重啟 Claude Code 生效${R}`);
}

function cmdAuto(args) {
  console.log(`${B}=== Auto：搜尋 + Patch ===${R}\n`);
  const userId  = args['user-id'] || detectUserId();
  const species = args.species;
  const rarity  = args.rarity;
  const eye     = args.eye;
  const hat     = args.hat;
  const shiny   = !!args.shiny;
  const minStat = parseMinStat(args['min-stat']);
  const total   = Number(args.total) || 500000;
  const stats   = parseStats(args);

  // 1. 搜尋
  console.log(`[1/3] 搜尋 ${species||'任意'} / ${rarity||'任意'} / ${shiny?'✨Shiny':'不限'}...`);
  const found = searchSalt({ userId, species, rarity, eye, hat, shiny, minStat, total });
  if (!found) throw new Error('未找到，請增加 --total 或放寬條件');
  const { salt, buddy: b } = found;
  console.log(`      找到 ${YL}${salt}${R}（${b.species} ${b.rarity}${b.shiny?' ✨':''} 眼:${b.eye} 帽:${b.hat}）\n`);

  // 2. Patch salt
  console.log(`[2/3] Patch salt...`);
  const binPath = findRealBinary();
  const buf = fs.readFileSync(binPath);
  const str = buf.toString('utf8');
  const oldSalt = detectCurrentSalt(str);
  if (!oldSalt) throw new Error('找不到 salt pattern');
  const backup = loadBackup();
  if (!backup.originalSalt) saveBackup({ originalSalt: oldSalt, binaryPath: binPath });
  const count = patchBuffer(buf, oldSalt, salt);
  console.log(`      ${oldSalt} → ${salt}（${count} 處）\n`);

  // 3. Patch stats
  if (stats) {
    console.log(`[3/3] Patch 屬性...`);
    for (const n of STAT_NAMES) console.log(`      ${n.padEnd(10)} → ${stats[n]}`);
    const res = patchStats(buf, stats);
    if (!res.ok) console.warn(`${YL}屬性 patch 失敗：${res.reason}${R}`);
    else { saveBackup({ statsPatched: true, customStats: stats }); console.log(`      ${GR}成功（${res.count} 處）${R}\n`); }
  } else {
    console.log(`[3/3] 未指定屬性，跳過\n`);
  }

  writeBinary(binPath, buf);
  console.log(`${GR}${B}完成！重啟 Claude Code 後生效${R}`);
  console.log(`${D}還原：node buddy-patch.js restore${R}`);
}

function cmdRestore() {
  const backup = loadBackup();
  if (!backup.originalSalt) throw new Error('無備份記錄');
  const binPath = backup.binaryPath || findRealBinary();
  const buf = fs.readFileSync(binPath);
  const curSalt = detectCurrentSalt(buf.toString('utf8'));
  if (!curSalt) throw new Error('找不到 salt pattern');
  if (curSalt === backup.originalSalt) { console.log(`${YL}已是原始 salt${R}`); return; }
  patchBuffer(buf, curSalt, backup.originalSalt);
  if (backup.statsPatched) {
    console.log(`${YL}注意：屬性 patch 無法自動還原，需重新安裝：${R}`);
    console.log(`  curl -fsSL https://claude.ai/install.sh | sh`);
  }
  writeBinary(binPath, buf);
  saveBackup({ originalSalt: null, statsPatched: false });
  console.log(`${GR}Salt 還原為 ${backup.originalSalt}，重啟生效${R}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd  = args._[0];
  try {
    if (!cmd||cmd==='help') {
      console.log('用法: node buddy-patch.js [status|search|apply|stats|auto|restore]');
      console.log('\n  status   查看 binary 當前狀態');
      console.log('  search   搜尋符合條件的 salt（不寫入）');
      console.log('  apply    套用指定 salt');
      console.log('  stats    修改屬性值');
      console.log('  auto     一鍵搜尋 + 套用 salt + 改屬性');
      console.log('  restore  還原至原始 salt');
      console.log('\n搜尋/篩選參數：');
      console.log('  --species <物種>       指定物種');
      console.log('  --rarity <稀有度>      指定稀有度');
      console.log('  --eye <符號>           指定眼睛');
      console.log('  --hat <帽子>           指定帽子');
      console.log('  --shiny                只找 shiny');
      console.log('  --min-stat NAME:值     指定單一屬性最低值');
      console.log('  --user-id <uuid>       手動指定 userId');
      console.log('  --total <數量>         搜尋次數（預設 500000）');
      return;
    }
    if (cmd==='status')  { cmdStatus();      return; }
    if (cmd==='search')  { cmdSearch(args);  return; }
    if (cmd==='apply')   { cmdApply(args);   return; }
    if (cmd==='stats')   { cmdStats(args);   return; }
    if (cmd==='auto')    { cmdAuto(args);    return; }
    if (cmd==='restore') { cmdRestore();     return; }
    throw new Error(`未知指令：${cmd}`);
  } catch(e) { console.error(`${RE}錯誤：${e.message}${R}`); process.exitCode=1; }
}
main();
