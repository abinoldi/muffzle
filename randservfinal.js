#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const readline = require("readline");
const os = require("os");

// --- CONFIGURATION ---
const MSRV_URL = "https://ghostbin.axel.org/paste/nk4fh/raw";
const PLACE_ID = "121864768012064";

// --- SOLVER CONFIGURATION ---
const SOLVER_API_URL = "http://64.23.246.253:3000/solve";
const YES_KEY = "f7a1a420f1ae90ca6c9d4d71437262edbd0ea31237995";

// STATUS MONITORING
const CHECK_SERVER_PRESENCE = false;
const AUTO_RECONNECT = true;     
const AUTO_RANDOM_CODE = false;

// --- GRID SETTINGS (XML) ---
const GRID_COLS = 3;
const BOX_SIZE = 150;
const START_OFFSET_Y = 50;
const GAP_X = 5;            
const GAP_Y = 60;

// --- TIMING & RETRY ---
const CHECK_INTERVAL = 60000;
const POST_GAME_WAIT = 15000;
const MAX_FINAL_RETRIES = 3;

function ensurePackage(pkg) {
  try { require.resolve(pkg); } 
  catch {
    try { execSync(`npm install ${pkg}`, { stdio: "inherit" });
    } catch (e) { process.exit(1); }
  }
}
["axios", "cli-table3"].forEach(ensurePackage);

const axios = require("axios");
const Table = require("cli-table3");

const TERMUX_PREFIX = "/data/data/com.termux/files/usr/bin";
const NODE_PATH = `${TERMUX_PREFIX}/node`;
const SQLITE_PATH = `${TERMUX_PREFIX}/sqlite3`;

let lastRestartMap = {};
let accountStates = {};

// --- PERFORMANCE BOOSTER ---
function applyPerformanceTweaks() {
  console.log("\n🚀 Menerapkan Tweak Performa (CPU, Thermal, UI)...");
  try {
      const tweaksCmd = `
          for i in {0..7};
          do
              echo 1 > /sys/devices/system/cpu/cpu$i/online 2>/dev/null;
              echo performance > /sys/devices/system/cpu/cpu$i/cpufreq/scaling_governor 2>/dev/null;
          done;
          stop thermal-engine 2>/dev/null;
          stop thermald 2>/dev/null;
          killall -9 thermal-engine thermald 2>/dev/null;
          for tz in /sys/class/thermal/thermal_zone*/trip_point_*_temp; do
              [ -f "$tz" ] && echo 99999 > "$tz" 2>/dev/null;
          done;
          for dev in /sys/block/mmcblk[0-9]/queue/scheduler; do
              [ -f "$dev" ] && echo "deadline" > "$dev" 2>/dev/null;
          done;
          echo 10 > /proc/sys/vm/swappiness 2>/dev/null;
          settings put global window_animation_scale 0 2>/dev/null;
          settings put global transition_animation_scale 0 2>/dev/null;
          settings put global animator_duration_scale 0 2>/dev/null;
      `;
      execSync(`su -c '${tweaksCmd}'`, { stdio: 'ignore' });
      console.log("   ✅ Tweak Performa Aktif! (HP mungkin akan terasa lebih hangat)");
  } catch (e) {
      console.log("   ❌ Gagal menerapkan tweak performa.");
  }
}

process.on('SIGINT', () => {
  console.log("\n👋 Keluar dari script. Tweak performa tetap AKTIF (Tidak di-reset).");
  process.exit(0);
});

function initSystem() {
  try {
    const uid = execSync("id -u").toString().trim();
    if (uid !== "0") {
      const node = fs.existsSync(NODE_PATH) ? NODE_PATH : "node";
      const args = process.argv.slice(2).join(" ");
      execSync(`su -c "${node} ${__filename} ${args}"`, { stdio: "inherit" });
      process.exit(0);
    }
    try { execSync("termux-wake-lock"); } catch {}
  } catch (e) { process.exit(1); }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const ask = (q) => new Promise(r => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (ans) => { rl.close(); r(ans); });
});

function getPackages() {
  try {
    return execSync("pm list packages | grep roblox", { encoding: "utf8" })
      .split("\n").filter(l => l.trim()).map(l => l.replace("package:", "").trim());
  } catch { return []; }
}

function getRobloxCookie(packageName) {
  try {
    const cookiesPath = `/data/data/${packageName}/app_webview/Default/Cookies`;
    const tempPath = `/sdcard/temp_cookie_${packageName}_${Date.now()}.db`;
    execSync(`cp "${cookiesPath}" "${tempPath}"`);
    const sqliteCmd = fs.existsSync(SQLITE_PATH) ? SQLITE_PATH : "sqlite3";
    const query = `${sqliteCmd} "${tempPath}" "SELECT value FROM cookies WHERE name = '.ROBLOSECURITY' LIMIT 1"`;
    let cookie = execSync(query).toString().trim();
    execSync(`rm "${tempPath}"`);
    if (cookie && !cookie.startsWith("_")) cookie = "_" + cookie;
    return cookie ? `.ROBLOSECURITY=${cookie}` : null;
  } catch { return null; }
}

async function getUserInfo(cookie) {
  if (!cookie) return { id: null, name: "No Cookie" };
  try {
    const res = await axios.get("https://users.roblox.com/v1/users/authenticated", {
      headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0 (Android 10; Mobile)" }
    });
    return { id: res.data.id, name: res.data.name };
  } catch { 
    return { id: null, name: "Expired" };
  }
}

function stopPackage(pkg) {
  try { execSync(`am force-stop ${pkg}`, { stdio: 'ignore' }); } catch (e) {} 
}

function releaseMemory() {
  try {
    execSync('su -c "sync; echo 3 > /proc/sys/vm/drop_caches"', { stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}

// 🛡️ NEW: DETEKSI PROSES KHUSUS CLOUD (MURNI TANPA SYARAT RAM)
function isAppRunning(pkg) {
    try {
        // Coba metode 1: pidof
        let pid = execSync(`su -c "pidof ${pkg}"`, { encoding: 'utf8' }).trim();
        if (pid.length > 0) return true;
    } catch(e) {}

    try {
        // Coba metode 2: ps grep (sebagai cadangan jika pidof gagal di cloud)
        let ps = execSync(`su -c "ps -A | grep ${pkg}"`, { encoding: 'utf8' }).trim();
        if (ps.length > 0) return true;
    } catch(e) {}

    return false;
}

// Menampilkan RAM hanya untuk tabel, tidak mempengaruhi jalannya script
function getAppRam(pkg) {
  try {
    // Dumpsys bisa langsung ditembak menggunakan nama package (tidak perlu PID)
    const memInfo = execSync(`su -c "dumpsys meminfo ${pkg} | grep -E 'TOTAL:|TOTAL PSS:'"`, { encoding: 'utf8' }).trim();
    const match = memInfo.match(/\d+/);
    if (match) {
        const mb = (parseInt(match[0]) / 1024).toFixed(1);
        return `${mb} MB`;
    }
    return "0 MB";
  } catch (e) {
    return "0 MB";
  }
}

async function protectProcessFromLMK(pkg) {
  try {
    const pid = execSync(`su -c "pidof ${pkg}"`, { encoding: 'utf8' }).trim();
    if (pid) {
      execSync(`su -c "echo -900 > /proc/${pid}/oom_score_adj"`, { stdio: 'ignore' });
      return true;
    }
  } catch (e) {
    return false;
  }
}

function autoArrangeXML(packages) {
  console.log(`\n📐 Mengatur XML (Grid ${GRID_COLS}xN | Size ${BOX_SIZE} | Gap Y ${GAP_Y})...`);
  packages.sort();
  packages.forEach((pkg, index) => {
    const col = index % GRID_COLS;
    const row = Math.floor(index / GRID_COLS);

    const left = col * (BOX_SIZE + GAP_X);
    const top = (row * (BOX_SIZE + GAP_Y)) + START_OFFSET_Y;
    const right = left + BOX_SIZE;
    const bottom = top + BOX_SIZE;

    const prefsFile = `/data/data/${pkg}/shared_prefs/${pkg}_preferences.xml`;

    const cmd = `su -c "
      sed -i 's|app_cloner_current_window_left\\" value=\\"[0-9]*|app_cloner_current_window_left\\" value=\\"${left}|' ${prefsFile};
      sed -i 's|app_cloner_current_window_top\\" value=\\"[0-9]*|app_cloner_current_window_top\\" value=\\"${top}|' ${prefsFile};
      sed -i 's|app_cloner_current_window_right\\" value=\\"[0-9]*|app_cloner_current_window_right\\" value=\\"${right}|' ${prefsFile};
      sed -i 's|app_cloner_current_window_bottom\\" value=\\"[0-9]*|app_cloner_current_window_bottom\\" value=\\"${bottom}|' ${prefsFile};
      sed -i 's|<int name=\\"GraphicsQualityLevel\\" value=\\".*\\" />|<int name=\\"GraphicsQualityLevel\\" value=\\"1\\" />|g' ${prefsFile};
      chmod 660 ${prefsFile}
    "`;
    try { execSync(cmd, { stdio: 'ignore' }); } catch (e) {}
  });
  console.log("✅ Posisi XML tersimpan dan Grafis dipaksa rata kiri.");
}

async function launchPackage(pkg, url) {
  try {
    const cmd = `am start -n ${pkg}/com.roblox.client.ActivityProtocolLaunch -f 0x18080000 -a android.intent.action.VIEW -d "${url}"`;
    execSync(cmd, { stdio: 'ignore' });
  } catch (e) {}
}

async function fetchLinkCodes() {
  console.log("🌐 Fetching codes...");
  try {
    const res = await axios.get(MSRV_URL);
    return res.data.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  } catch (e) { return []; }
}

function getSystemStats() {
  const cpus = os.cpus();
  const idle = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0);
  const total = cpus.reduce((acc, cpu) => acc + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle, 0);
  const cpuUsage = (100 - (idle / total) * 100).toFixed(1);
  const totalMem = os.totalmem();
  const totalGB = (totalMem / (1024 ** 3)).toFixed(2);
  const usedGB = ((totalMem - os.freemem()) / (1024 ** 3)).toFixed(2);
  const uptimeHrs = Math.floor(os.uptime() / 3600);
  return { cpu: `${cpuUsage}%`, ram: `${usedGB}/${totalGB} GB`, uptime: `${uptimeHrs}h` };
}

function renderDashboard(cleanCode, statusMessage) {
  console.clear();
  const stats = getSystemStats();
  console.log(`📱 SYSTEM: CPU ${stats.cpu} | RAM ${stats.ram} | UP ${stats.uptime} | BOOSTER: ON 🔥`);
  console.log(`📏 MODE: XML GRID (${GRID_COLS} cols) | GAP Y: ${GAP_Y}px`);
  console.log(`📊 STATUS: ${statusMessage} | Mode: CONTINUOUS | Code: ${cleanCode}`);
  const termWidth = process.stdout.columns || 80;
  const safeWidth = Math.max(50, termWidth - 10); 

  const wPkg = Math.floor(safeWidth * 0.20);
  const wUser = Math.floor(safeWidth * 0.15);
  const wState = Math.floor(safeWidth * 0.12);
  const wStatus = Math.floor(safeWidth * 0.20);
  const wRam = 10; 
  const wAction = Math.max(5, safeWidth - (wPkg + wUser + wState + wStatus + wRam));

  const table = new Table({ 
      head: ['Pkg', 'User', 'State', 'Status', 'RAM', 'Action'], 
      colWidths: [wPkg, wUser, wState, wStatus, wRam, wAction],
      wordWrap: true 
  });

  Object.keys(accountStates).sort().forEach(pkg => {
    const s = accountStates[pkg];
    table.push([
      pkg.replace("com.roblox.client", "...client"), 
      s.username.substring(0, 12),
      s.isRunning ? "Run 🟢" : "Wait ⚪",
      s.serverStatus,
      s.ramUsage,
      s.action
    ]);
  });
  console.log(table.toString());
}

// --- FUNGSI SOLVER API ---
async function runSolver(fullCookie, accPkg) {
    const rawCookie = fullCookie.replace('.ROBLOSECURITY=', '');
    
    try {
        const res = await axios.get(SOLVER_API_URL, {
            params: { cookie: rawCookie, yeskey: YES_KEY },
            timeout: 300000 
        });
        accountStates[accPkg].serverStatus = "✅ Solver Passed";
        return true;
    } catch (error) {
        if (error.response) {
            accountStates[accPkg].serverStatus = "❌ Solver API Err";
        } else if (error.code === 'ECONNABORTED') {
            accountStates[accPkg].serverStatus = "⚠️ Solver Timeout";
        } else {
            accountStates[accPkg].serverStatus = "❌ Solver Offline";
        }
        return false;
    }
}

async function main() {
  initSystem();
  console.clear();
  console.log("🚀 Initializing Manager (Continuous Mode)...");

  applyPerformanceTweaks();

  const packages = getPackages();
  if (!packages.length) { 
    console.log("❌ No Roblox packages found."); 
    process.exit(0); 
  }

  let accounts = [];
  packages.sort();
  for (const pkg of packages) {
    process.stdout.write(`Reading ${pkg}... \r`);
    const cookie = getRobloxCookie(pkg);
    const userInfo = await getUserInfo(cookie);
    
    if (!userInfo.id || userInfo.name === "Expired") {
      console.log(`⚠️ Skipping ${pkg}: Cookie Expired atau Tidak Valid.`);
      continue; 
    }

    accounts.push({ pkg, cookie, userId: userInfo.id, username: userInfo.name });
    lastRestartMap[pkg] = 0;
    accountStates[pkg] = { username: userInfo.name, isRunning: false, serverStatus: "Waiting...", ramUsage: "0 MB", action: "-" };
  }

  if (accounts.length === 0) {
    console.log("❌ Tidak ada akun valid untuk dijalankan.");
    process.exit(0);
  }

  console.log(`\n✅ Loaded ${accounts.length} valid accounts.`);

  const codes = await fetchLinkCodes();
  if (codes.length === 0) { 
    console.log("⚠️ No codes found."); 
    process.exit(1);
  }

  let cleanCode = "";
  if (!AUTO_RANDOM_CODE) {
    const argIndex = process.argv.indexOf("-server");
    let selectedIdx = -1;
    if (argIndex !== -1 && process.argv[argIndex + 1]) {
        selectedIdx = parseInt(process.argv[argIndex + 1]) - 1;
    }

    if (selectedIdx >= 0 && selectedIdx < codes.length) {
        console.log(`\n✅ Auto-selecting Server [${selectedIdx + 1}] via arguments.`);
        cleanCode = codes[selectedIdx];
    } else {
        console.log("\n📜 Available Codes:");
        codes.forEach((code, index) => console.log(`[${index + 1}] ${code}`));
        
        const selection = await ask("\n👉 Choose Server: ");
        const idx = parseInt(selection) - 1;
        
        if (isNaN(idx) || idx < 0 || idx >= codes.length) {
            console.log("❌ Invalid selection.");
            process.exit(1);
        }
        cleanCode = codes[idx];
    }
  }

  const codeDisplay = AUTO_RANDOM_CODE ? "RANDOM" : `...${cleanCode.slice(-4)}`;
  autoArrangeXML(accounts.map(a => a.pkg));

  // --- FASE 1: PELUNCURAN BERURUTAN ---
  console.log("\n🚀 Launching valid instances (Fase 1)...");
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    
    accountStates[acc.pkg].serverStatus = "Solving Captcha ⏳";
    renderDashboard(codeDisplay, `🤖 Mengirim cookie ${acc.username} ke Solver API...`);
    await runSolver(acc.cookie, acc.pkg);
    renderDashboard(codeDisplay, `✅ Solver selesai untuk ${acc.username}. Melakukan Launching...`);
    await sleep(2000); 

    let currentCode = AUTO_RANDOM_CODE ? codes[Math.floor(Math.random() * codes.length)] : cleanCode;
    if(currentCode.includes("linkCode=")) {
        currentCode = currentCode.split("linkCode=")[1].split("&")[0];
    }
    const finalLaunchUrl = `roblox://placeID=${PLACE_ID}&linkCode=${currentCode}`;
    let isStable = false;

    while (!isStable) {
      stopPackage(acc.pkg); 
      releaseMemory();
      await sleep(1500); 

      await launchPackage(acc.pkg, finalLaunchUrl);
      lastRestartMap[acc.pkg] = Date.now();
      accountStates[acc.pkg].isRunning = true;
      accountStates[acc.pkg].serverStatus = "Launching...";
      
      await sleep(3000);
      await protectProcessFromLMK(acc.pkg);
      
      let crashed = false;
      for (let sec = 1; sec <= 60; sec++) {
        if (sec % 5 === 0) accountStates[acc.pkg].ramUsage = getAppRam(acc.pkg);
        renderDashboard(codeDisplay, `⏳ ${acc.username} Stabilizing... (${sec}/60s) 🛡️ Shield ON`);
        await sleep(1000); 

        if (!isAppRunning(acc.pkg)) {
            accountStates[acc.pkg].serverStatus = "Force Close!";
            accountStates[acc.pkg].ramUsage = "0 MB";
            renderDashboard(codeDisplay, `⚠️ ${acc.username} Force Close di detik ${sec}! Membuka ulang...`);
            crashed = true;
            await sleep(3000); 
            break; 
        }
      }

      if (!crashed) {
        accountStates[acc.pkg].serverStatus = "In Game 🎮 (Stable)";
        accountStates[acc.pkg].ramUsage = getAppRam(acc.pkg);
        renderDashboard(codeDisplay, `✅ ${acc.username} Stabil! Lanjut ke akun berikutnya...`);
        isStable = true; 
        await sleep(2000); 
      }
    }
  }

  // --- FASE 2: CONTINUOUS MONITORING ---
  console.log("\n🔄 Memasuki Mode Continuous Monitoring...");
  releaseMemory();

  while (true) {
    let anyCrashed = false;
    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        
        accountStates[acc.pkg].ramUsage = getAppRam(acc.pkg);
        const processRunning = isAppRunning(acc.pkg);
        
        // MURNI DETEKSI PROSES HIDUP ATAU MATI (Tidak pakai batas RAM)
        if (!processRunning) {
            anyCrashed = true;
            accountStates[acc.pkg].isRunning = false;
            
            accountStates[acc.pkg].serverStatus = "Crash: Force Close! Reopening...";
            accountStates[acc.pkg].ramUsage = "0 MB";
            
            renderDashboard(codeDisplay, `⚠️ ${acc.username} terdeteksi Force Close! Melakukan Auto-Reopen...`);
            stopPackage(acc.pkg);
            releaseMemory();
            await sleep(1500);

            accountStates[acc.pkg].serverStatus = "Solving Captcha ⏳";
            renderDashboard(codeDisplay, `🤖 Memproses Solver API untuk ${acc.username} sebelum Reconnect...`);
            await runSolver(acc.cookie, acc.pkg);
            renderDashboard(codeDisplay, `✅ Solver selesai untuk ${acc.username}. Me-reopen game...`);
            await sleep(2000);

            let currentCode = AUTO_RANDOM_CODE ? codes[Math.floor(Math.random() * codes.length)] : cleanCode;
            if(currentCode.includes("linkCode=")) {
                currentCode = currentCode.split("linkCode=")[1].split("&")[0];
            }
            const finalLaunchUrl = `roblox://placeID=${PLACE_ID}&linkCode=${currentCode}`;
            
            await launchPackage(acc.pkg, finalLaunchUrl);
            await sleep(3000);
            await protectProcessFromLMK(acc.pkg);
            
            for(let w = 1; w <= 20; w++) {
                if (w % 5 === 0) accountStates[acc.pkg].ramUsage = getAppRam(acc.pkg);
                renderDashboard(codeDisplay, `⏳ Menunggu ${acc.username} re-open... (${w}/20s) 🛡️ Shield ON`);
                await sleep(1000);
            }
            
            accountStates[acc.pkg].isRunning = true;
            accountStates[acc.pkg].serverStatus = "In Game 🎮 (Auto-Recovered)";
            accountStates[acc.pkg].ramUsage = getAppRam(acc.pkg);
        } else {
            accountStates[acc.pkg].isRunning = true;
            accountStates[acc.pkg].serverStatus = "In Game 🎮 (Monitoring)";
        }
    }

    if (anyCrashed) {
        releaseMemory();
    }

    renderDashboard(codeDisplay, `👀 Monitoring Aktif (Auto-Reopen ON) | Refresh per 1 Menit`);
    await sleep(CHECK_INTERVAL); 
  }
}

main();
