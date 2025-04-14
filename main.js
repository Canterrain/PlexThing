// main.js
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


let mainWindow;
let plexClient = null;

// --- ADB path
let ADB_PATH;
if (process.platform.startsWith("win")) {
  ADB_PATH = path.join(__dirname, "ADB", "win", "adb.exe");
} else if (process.platform.startsWith("darwin")) {
  ADB_PATH = path.join(__dirname, "ADB", "mac", "adb");
} else {
  ADB_PATH = path.join(__dirname, "ADB", "linux", "adb");
}
if (process.platform !== 'win32') {
  try {
    fs.chmodSync(ADB_PATH, 0o755);
    console.log(`${ADB_PATH} is now executable.`);
  } catch (err) {
    console.error("Error setting ADB permissions:", err);
  }
}

// --- Config
const CONFIG_FILE = path.join(app.getPath('userData'), "config.json");
const DEFAULT_CONFIG = {
  plex_server_url: "http://<PLEX_SERVER_IP>:32400",
  plex_token: "<YOUR_PLEX_TOKEN>",
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


// --- Helper: Car Thing status
async function getCarThingStatus() {
  return new Promise(resolve => {
    // Check if any WebSocket clients (Car Thing) are connected
    if (wss && [...wss.clients].some(client => client.readyState === WebSocket.OPEN)) {
      return resolve("Connected");
    }

    // Fallback: check if ADB reverse is active (especially useful on Windows)
    adbReverseActive(active => {
      resolve(active ? "Connected (ADB)" : "Not connected");
    });
  });
}


// --- Helper: Fetch artwork
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

// --- Get Plex Status
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
        recentlyAdded = {
          title: item.title,
          addedAt: new Date(item.addedAt * 1000).toISOString(),
          library: item.librarySectionTitle || "Unknown"
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

// --- Broadcast Status
function startStatusBroadcast() {
  setInterval(async () => {
    const status = await getServerStatus();

    // Nullify nowPlaying if no streams or no Plex client
    if (!plexClient || status.activeStreams.count === 0) {
      status.activeStreams.nowPlaying = null;
    }

    const payload = {
      type: "serverStatus",
      serverStatus: {
        serverUp: status.plexStatus.connected
        // serverVersion removed entirely
      },
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
      if (error) {
        resolve({ success: false, error: error.toString() });
      } else {
        resolve({ success: true, output: stdout.trim() });
      }
    });
  });
});


ipcMain.handle("push-build", async (event, buildPath) => {
  return new Promise((resolve) => {
    console.log("Pushing build to Car Thing using buildPath:", buildPath);

    let absoluteBuildPath;

    // Development mode or unbundled app
    if (process.env.NODE_ENV === 'development' || !process.resourcesPath) {
      absoluteBuildPath = path.resolve(buildPath);
    } else {
      // Try default packaged location
      absoluteBuildPath = path.join(process.resourcesPath, 'app', 'superbird-custom-webapp', 'react_webapp', 'build');
      if (!fs.existsSync(absoluteBuildPath)) {
        // Fallback if "app" isn't present in packaged structure
        absoluteBuildPath = path.join(process.resourcesPath, 'superbird-custom-webapp', 'react_webapp', 'build');
      }
    }

    console.log("Using build folder:", absoluteBuildPath);

    if (!fs.existsSync(absoluteBuildPath)) {
      resolve({ success: false, error: `Build folder not found at ${absoluteBuildPath}` });
      return;
    }

    // Optional: list files to verify contents
    const listFilesRecursive = (dir) => {
      let results = [];
      fs.readdirSync(dir).forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          results = results.concat(listFilesRecursive(fullPath));
        } else {
          results.push(fullPath);
        }
      });
      return results;
    };

    const allFiles = listFilesRecursive(absoluteBuildPath);
    console.log("Files to be pushed:", allFiles.length);

    // ADB steps
    execFile(ADB_PATH, ["shell", "mount", "-o", "remount,rw", "/"], (err1) => {
      if (err1) {
        resolve({ success: false, error: "Mount error: " + err1.toString() });
        return;
      }

      execFile(ADB_PATH, ["shell", "rm", "-rf", "/usr/share/qt-superbird-app/webapp/*"], (err2) => {
        if (err2) {
          console.error("Error removing old webapp folder (continuing):", err2);
        }

        execFile(ADB_PATH, ["push", ".", "/usr/share/qt-superbird-app/webapp/"], { cwd: absoluteBuildPath }, (err3, stdout3) => {
          if (err3) {
            resolve({ success: false, error: "Push error: " + err3.toString() });
          } else {
            execFile(ADB_PATH, ["reboot"], (err4) => {
              if (err4) {
                resolve({ success: false, error: "Reboot error: " + err4.toString() });
              } else {
                resolve({ success: true, output: stdout3.trim() });
              }
            });
          }
        });
      });
    });
  });
});


// --- App Ready
app.whenReady().then(() => {
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
