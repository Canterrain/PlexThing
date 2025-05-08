const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const { parseString } = require('xml2js');
const PlexAPI = require('plex-api');
const dgram = require('dgram');

app.commandLine.appendSwitch('allow-insecure-localhost');
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

let mainWindow;
let plexClient = null;

// --- ADB path
let baseADBPath;
if (
  process.resourcesPath &&
  fs.existsSync(path.join(process.resourcesPath, "app.asar.unpacked"))
) {
  baseADBPath = path.join(process.resourcesPath, "app.asar.unpacked");
} else {
  baseADBPath = __dirname;
}

let ADB_PATH;
if (process.platform.startsWith("win")) {
  ADB_PATH = path.join(baseADBPath, "ADB", "win", "adb.exe");
} else if (process.platform.startsWith("darwin")) {
  ADB_PATH = path.join(baseADBPath, "ADB", "mac", "adb");
} else {
  ADB_PATH = path.join(baseADBPath, "ADB", "linux", "adb");
}


// Only chmod if NOT inside an ASAR archive
if (process.platform !== 'win32') {
  if (!process.mainModule?.filename.includes('app.asar')) {
    try {
      fs.chmodSync(ADB_PATH, 0o755);
      console.log(`${ADB_PATH} is now executable.`);
    } catch (err) {
      console.error("Error setting ADB permissions:", err);
    }
  } else {
    console.log("Skipping chmod: running from ASAR package.");
  }
}

// --- Config
const CONFIG_FILE = path.join(app.getPath('userData'), "config.json");
const DEFAULT_CONFIG = {
  plex_server_url: "http://<PLEX_SERVER_IP>:32400",
  plex_token: "<YOUR_PLEX_TOKEN>"
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE));
    }
  } catch (err) {
    console.error("Error loading config:", err);
  }
  return DEFAULT_CONFIG;
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4));
  } catch (err) {
    console.error("Error saving config:", err);
  }
}

// --- Local Network Prompt
function triggerLocalNetworkPrompt() {
  if (process.platform === 'darwin') {
    try {
      const socket = dgram.createSocket('udp4');
      socket.send('Hello', 5353, '224.0.0.251', () => {
        console.log('Sent dummy packet to trigger Local Network Permission');
        socket.close();
      });
    } catch (err) {
      console.error('Failed to trigger local network prompt:', err);
    }
  }
}

// --- ADB Control
function adbReverseActive(callback) {
  if (process.platform === 'darwin') return callback(false);
  execFile(ADB_PATH, ["reverse", "--list"], (error, stdout) => {
    callback(!error && stdout.includes("tcp:8891"));
  });
}

function runAdbReverse() {
  adbReverseActive(active => {
    if (!active) {
      execFile(ADB_PATH, ["reverse", "tcp:8891", "tcp:8891"], (err, stdout) => {
        if (err) console.error("Error applying ADB reverse:", err);
        else console.log("ADB reverse applied:", stdout.trim());
      });
    } else {
      console.log("ADB reverse already active.");
    }
  });
}

// --- Car Thing Status
async function getCarThingStatus() {
  return new Promise(resolve => {
    if (wss && [...wss.clients].some(client => client.readyState === WebSocket.OPEN)) {
      return resolve("Connected");
    }
    adbReverseActive(active => {
      resolve(active ? "Connected (ADB)" : "Not connected");
    });
  });
}

// --- Artwork Helpers
function buildArtworkUrl(thumb, token) {
  const config = loadConfig();
  let base = config.plex_server_url.replace(/\/$/, "");
  return `${base}${thumb}${thumb.includes('?') ? '&' : '?'}X-Plex-Token=${token}`;
}

function fetchArtworkData(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error("Image fetch failed"));
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const base64 = Buffer.concat(chunks).toString("base64");
        resolve("data:image/jpeg;base64," + base64);
      });
    }).on("error", reject);
  });
}

// --- Plex Status
async function getNetworkFromSessions() {
  if (!plexClient) return { sent_mbps: "0", recv_mbps: "0" };
  try {
    const sessions = await plexClient.query("/status/sessions");
    let totalKbps = 0;
    if (sessions.MediaContainer?.Metadata) {
      for (const s of sessions.MediaContainer.Metadata) {
        if (s.Media?.[0]?.bitrate) {
          totalKbps += parseInt(s.Media[0].bitrate, 10);
        }
      }
    }
    return { sent_mbps: (totalKbps / 1000).toFixed(1), recv_mbps: "0" };
  } catch {
    return { sent_mbps: "0", recv_mbps: "0" };
  }
}

async function getServerStatus() {
  let connected = false;
  try {
    if (plexClient) {
      await plexClient.query("/");
      connected = true;
    }
  } catch {}

  const config = loadConfig();
  const carThingStatus = await getCarThingStatus();
  const networkBandwidth = await getNetworkFromSessions();

  let libraryStats = {};
  let recentlyAdded = null;
  let activeStreams = { count: 0, nowPlaying: null, details: [] };
  let transcoding = { count: 0, details: [] };

  if (plexClient) {
    try {
      const sections = await plexClient.query("/library/sections");
      for (const section of sections.MediaContainer?.Directory || []) {
        const id = section.key;
        const items = await plexClient.query(`/library/sections/${id}/all`);
        const count = parseInt(items.MediaContainer.size, 10) || 0;
        libraryStats[section.title] = count;
      }
    } catch (e) {
      console.error("Library stats error:", e);
    }

    try {
      const recent = await plexClient.query("/library/recentlyAdded");
      const item = recent.MediaContainer?.Metadata?.[0];
      if (item) {
        const baseTitle = item.grandparentTitle || item.title;
        const library = item.librarySectionTitle || "Unknown";
        recentlyAdded = {
          title: baseTitle,
          addedAt: new Date(item.addedAt * 1000).toISOString(),
          library
        };
      }
    } catch (e) {
      console.error("Recently added error:", e);
    }

    try {
      const sessions = await plexClient.query("/status/sessions");
      activeStreams.count = parseInt(sessions.MediaContainer.size, 10) || 0;
      for (const s of sessions.MediaContainer?.Metadata || []) {
        const detail = {
          title: s.title,
          user: s.user?.title || "Unknown",
          transcoding: !!s.transcodeInfo,
          show: s.grandparentTitle || ""
        };
        activeStreams.details.push(detail);

        if (!activeStreams.nowPlaying) {
          const thumb = s.grandparentThumb || s.thumb;
          const artwork = thumb ? await fetchArtworkData(buildArtworkUrl(thumb, config.plex_token)) : "";
          activeStreams.nowPlaying = {
            title: s.grandparentTitle || s.title,
            episode: s.grandparentTitle ? s.title : undefined,
            artworkData: artwork,
            dominantColor: "#333"
          };
        }

        if (s.transcodeInfo) {
          transcoding.details.push({
            title: s.title,
            user: s.user?.title || "Unknown",
            transcodeInfo: s.transcodeInfo
          });
        }
      }
      transcoding.count = transcoding.details.length;
    } catch (e) {
      console.error("Session info error:", e);
    }
  }

  return {
    plexStatus: { connected },
    carThingStatus,
    libraryStats,
    recentlyAdded,
    networkBandwidth,
    activeStreams,
    transcoding
  };
}

// --- WebSocket
let wss;
function startWebSocketServer() {
  wss = new WebSocket.Server({ port: 8891 });
  wss.on("connection", () => console.log("WebSocket client connected"));
  console.log("WebSocket server running on port 8891");
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  if (wss?.clients) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
    console.log("Broadcasted:", msg);
  }
}

function startStatusBroadcast() {
  setInterval(async () => {
    const status = await getServerStatus();
    if (!plexClient || status.activeStreams.count === 0) {
      status.activeStreams.nowPlaying = null;
    }
    const payload = {
      type: "serverStatus",
      serverStatus: { serverUp: status.plexStatus.connected },
      libraryStats: status.libraryStats,
      recentlyAdded: status.recentlyAdded,
      networkBandwidth: status.networkBandwidth,
      activeStreams: status.activeStreams,
      transcoding: {
        count: status.transcoding.count,
        details: status.transcoding.details
      }
    };
    broadcast(payload);
  }, 5000);
}

// --- IPC
ipcMain.handle("get-config", async () => loadConfig());
ipcMain.handle("connect-plex", async (e, config) => {
  saveConfig(config);
  try {
    const { hostname, port } = new URL(config.plex_server_url);
    plexClient = new PlexAPI({ hostname, port: port || "32400", token: config.plex_token });
    await plexClient.query("/");
    return { success: true };
  } catch (e) {
    console.error("Plex connect error:", e);
    return { success: false, error: e.toString() };
  }
});
ipcMain.handle("get-server-status", async () => getServerStatus());
ipcMain.handle("manual-adb-reverse", async () => {
  return new Promise(resolve => {
    if (!fs.existsSync(ADB_PATH)) {
      resolve({ success: false, error: "ADB binary not found." });
      return;
    }
    execFile(ADB_PATH, ["reverse", "tcp:8891", "tcp:8891"], (error, stdout) => {
      if (error) resolve({ success: false, error: error.toString() });
      else resolve({ success: true, output: stdout.trim() });
    });
  });
});
ipcMain.handle("push-build", async () => {
  return new Promise((resolve) => {
    let buildPath;

    if (process.env.NODE_ENV === 'development') {
      buildPath = path.join(__dirname, "react_webapp", "build");
    } else {
      // Normal production: try mac-style layout
      buildPath = path.join(process.resourcesPath, "app", "react_webapp", "build");

      // Windows or alternate layout fallback
      if (!fs.existsSync(buildPath)) {
        buildPath = path.join(process.resourcesPath, "app.asar.unpacked", "react_webapp", "build");
      }
    }


    if (!fs.existsSync(buildPath)) {
      return resolve({ success: false, error: `Build folder not found at ${buildPath}` });
    }

    console.log("Pushing build from:", buildPath);

    // Mount root as read-write, remove existing webapp, push new one, then reboot
    execFile(ADB_PATH, ["shell", "mount", "-o", "remount,rw", "/"], (err1) => {
      if (err1) return resolve({ success: false, error: "Mount error: " + err1.toString() });

      execFile(ADB_PATH, ["shell", "rm", "-rf", "/usr/share/qt-superbird-app/webapp/*"], (err2) => {
        if (err2) console.error("Warning: couldn't delete old webapp folder");

        execFile(
          ADB_PATH,
          ["push", ".", "/usr/share/qt-superbird-app/webapp/"],
          { cwd: buildPath },
          (err3, stdout3) => {
            if (err3) {
              return resolve({ success: false, error: "Push error: " + err3.toString() });
            }

            execFile(ADB_PATH, ["reboot"], (err4) => {
              if (err4) {
                return resolve({ success: false, error: "Reboot error: " + err4.toString() });
              }

              resolve({ success: true, output: stdout3.trim() });
            });
          }
        );
      });
    });
  });
});



// --- App lifecycle
app.whenReady().then(() => {
  triggerLocalNetworkPrompt();
  createWindow();
  startWebSocketServer();
  startStatusBroadcast();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  mainWindow.loadFile("index.html");
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
