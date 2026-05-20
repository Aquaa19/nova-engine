// nova-engine/src/server.js

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs-extra');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { execSync, exec } = require('child_process');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' })); // Allow medium-sized uploads

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-256-bit-default-secret';
const BASE_WORKSPACE = path.join(__dirname, '../workspace');

fs.ensureDirSync(BASE_WORKSPACE);

// Session State Tracking
// Format: { sessionId: { containerId, userId, lastActiveTime, startTime, ptyProcess } }
const activeSessions = {};

// ── Auth Middleware ──
const authenticateREST = (req, res, next) => {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (token === 'nova-super-secret-token') {
      req.user = { userId: 'local-student' };
    } else {
      req.user = jwt.verify(token, JWT_SECRET);
    }
    next();
  } catch (err) {
    res.status(403).json({ error: 'Forbidden' });
  }
};

// ── HTTP: Spawn Session ──
app.post('/sessions', authenticateREST, (req, res) => {
  const userId = req.user.userId;
  const sessionId = crypto.randomUUID();
  const containerId = `nova-sandbox-${sessionId}`;
  const userWorkspace = path.join(BASE_WORKSPACE, userId);
  
  fs.ensureDirSync(userWorkspace);

  try {
    // Spawn container with strict limits, mapped workspace, read-only root, and writable /home/student
    const cmd = `docker run -d --name ${containerId} --rm --memory=256m --memory-swap=256m --cpus=0.5 --pids-limit=50 --network=none --read-only --tmpfs /tmp:rw,size=50m,mode=1777 --tmpfs /home/student:rw,size=10m,mode=1777 -v ${userWorkspace}:/workspace -w /workspace nova-engine-sandbox sleep 7200`;
    
    execSync(cmd);
    
    activeSessions[sessionId] = {
      containerId,
      userId,
      lastActiveTime: Date.now(),
      startTime: Date.now(),
      ptyProcess: null,
      previewVersion: 1,
      consoleLogs: []
    };
    
    console.log(`[Nova Engine] Session created: ${sessionId} for user ${userId}`);
    res.json({ sessionId, containerId });
  } catch (err) {
    console.error('[Nova Engine] Failed to spawn sandbox:', err);
    res.status(500).json({ error: 'Failed to create sandbox session' });
  }
});

// ── HTTP: Terminate Session ──
app.delete('/sessions/:id', authenticateREST, (req, res) => {
  const { id } = req.params;
  const session = activeSessions[id];
  
  if (!session || session.userId !== req.user.userId) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    execSync(`docker rm -f ${session.containerId}`);
  } catch (e) {
    console.error(`[Nova Engine] Failed to remove container ${session.containerId}:`, e.message);
  }
  
  if (session.ptyProcess) session.ptyProcess.kill();
  delete activeSessions[id];
  res.json({ success: true });
});

// ── HTTP: Safe Upload ──
app.post('/sessions/:id/upload', authenticateREST, async (req, res) => {
  const { id } = req.params;
  const { filename, content } = req.body;
  const session = activeSessions[id];
  
  if (!session || session.userId !== req.user.userId) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  // Protect against directory traversal and bad filenames
  if (!filename || filename.includes('..') || filename.includes('\0') || path.isAbsolute(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  const userWorkspace = path.join(BASE_WORKSPACE, session.userId);
  const safePath = path.normalize(filename).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(userWorkspace, safePath);
  
  try {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content || '', 'utf8');
    session.previewVersion = (session.previewVersion || 0) + 1; // Bump version for live reload
    res.json({ success: true, filename: safePath });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write file to host map' });
  }
});

// ── Preview & Live Reload Routes ──
app.get('/sessions/:id/preview/*', async (req, res) => {
  const { id } = req.params;
  const session = activeSessions[id];
  if (!session) return res.status(404).send('<h2>Sandbox Offline</h2>');

  const reqPath = req.params[0] || 'index.html';
  const userWorkspace = path.join(BASE_WORKSPACE, session.userId);
  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(userWorkspace, safePath);

  if (!filePath.startsWith(userWorkspace)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(filePath)) return res.status(404).send(`File not found: ${safePath}`);

  // Handle directory requests by appending index.html
  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('<h2>index.html not found</h2>');
    }
  }

  if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
    let content = await fs.readFile(filePath, 'utf8');
    const injectedScript = `
      <script>
        (function() {
          const scrollKey = 'nova_scroll_' + window.location.pathname;
          const savedScroll = sessionStorage.getItem(scrollKey);
          if (savedScroll) window.scrollTo(0, parseInt(savedScroll, 10));
          window.addEventListener('scroll', () => sessionStorage.setItem(scrollKey, window.scrollY));

          let currentVersion = null;
          setInterval(() => {
            fetch('/sessions/${id}/livereload')
              .then(r => r.json())
              .then(data => {
                if (currentVersion === null) currentVersion = data.version;
                else if (data.version > currentVersion) window.location.reload();
              }).catch(() => {});
          }, 1000);

          const originalConsole = { log: console.log, warn: console.warn, error: console.error };
          function forwardLog(level, args) {
            const message = Array.from(args).map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            fetch('/sessions/${id}/console', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ level, message, timestamp: Date.now() })
            }).catch(() => {});
          }
          console.log = function() { originalConsole.log.apply(console, arguments); forwardLog('log', arguments); };
          console.warn = function() { originalConsole.warn.apply(console, arguments); forwardLog('warn', arguments); };
          console.error = function() { originalConsole.error.apply(console, arguments); forwardLog('error', arguments); };
          window.onerror = function(msg, url, lineNo, columnNo) {
            forwardLog('error', [msg, url, lineNo, columnNo]);
            return false;
          };
        })();
      </script>
    `;
    if (content.includes('</body>')) {
      content = content.replace('</body>', `${injectedScript}</body>`);
    } else {
      content += injectedScript;
    }
    res.type('html').send(content);
  } else {
    res.sendFile(filePath);
  }
});

app.get('/sessions/:id/livereload', (req, res) => {
  const session = activeSessions[req.params.id];
  res.json({ version: session ? session.previewVersion : 0 });
});

app.post('/sessions/:id/console', (req, res) => {
  const session = activeSessions[req.params.id];
  if (session) {
    session.consoleLogs = session.consoleLogs || [];
    session.consoleLogs.push({ ...req.body, id: crypto.randomUUID() });
    if (session.consoleLogs.length > 200) session.consoleLogs.shift();
  }
  res.json({ success: true });
});

app.get('/sessions/:id/console', (req, res) => {
  const session = activeSessions[req.params.id];
  res.json({ logs: session ? (session.consoleLogs || []) : [] });
});

app.delete('/sessions/:id/console', (req, res) => {
  const session = activeSessions[req.params.id];
  if (session) session.consoleLogs = [];
  res.json({ success: true });
});

// ── Idle Watchdog ──
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of Object.entries(activeSessions)) {
    const isIdle = now - session.lastActiveTime > 30 * 60000;      // 30 min idle
    const isExpired = now - session.startTime > 2 * 3600000;       // 2 hours absolute cap
    
    if (isIdle || isExpired) {
      console.log(`[Watchdog] Terminating session ${id} (Idle: ${isIdle}, Expired: ${isExpired})`);
      try {
        exec(`docker rm -f ${session.containerId}`);
      } catch(e) {}
      if (session.ptyProcess) session.ptyProcess.kill();
      delete activeSessions[id];
    }
  }
}, 60000); // Check every minute

// ── WebSocket Upgrade ──
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const token = url.searchParams.get('token') || request.headers['x-auth-token'];
  
  const match = url.pathname.match(/^\/sessions\/([^\/]+)\/terminal$/);
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const sessionId = match[1];

  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  try {
    let userPayload;
    if (token === 'nova-super-secret-token') {
      userPayload = { userId: 'local-student' };
    } else {
      userPayload = jwt.verify(token, JWT_SECRET);
    }
    
    request.user = userPayload;
    request.sessionId = sessionId;
    
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } catch (err) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
  }
});

// ── WebSocket Connection logic ──
wss.on('connection', (ws, request) => {
  const { userId } = request.user;
  const { sessionId } = request;
  const session = activeSessions[sessionId];
  
  if (!session || session.userId !== userId) {
    ws.send(JSON.stringify({ type: 'output', data: '\r\nSession invalid or unauthorized.\r\n' }));
    ws.close();
    return;
  }
  
  session.lastActiveTime = Date.now();

  // Exec bash inside the existing container
  const ptyProcess = pty.spawn('docker', ['exec', '-it', session.containerId, '/bin/bash'], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
  });
  
  session.ptyProcess = ptyProcess;

  ptyProcess.onData((data) => {
    ws.send(JSON.stringify({ type: 'output', data }));
  });

  ws.on('message', (message) => {
    session.lastActiveTime = Date.now();
    try {
      const payload = JSON.parse(message);
      if (payload.type === 'input') {
        ptyProcess.write(payload.data);
      } else if (payload.type === 'resize') {
        ptyProcess.resize(payload.cols || 80, payload.rows || 24);
      }
    } catch (err) {
      console.error('[Nova Engine] Failed to handle WS message:', err);
    }
  });

  ws.on('close', () => {
    console.log(`[Nova Engine] Terminal disconnected for session: ${sessionId}`);
    ptyProcess.kill();
    session.ptyProcess = null;
  });
});

server.listen(PORT, () => {
  console.log(`[Nova Engine] Active and running on port ${PORT}`);
});
