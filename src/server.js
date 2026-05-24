// nova-engine/src/server.js

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs-extra');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { execSync, exec, spawn } = require('child_process');
const client = require('prom-client');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));

// Version constant and header middleware
const ENGINE_VERSION = '1.2.0';
app.use((req, res, next) => {
  res.setHeader('X-Nova-Engine-Version', ENGINE_VERSION);
  next();
});

// JSON Logger Setup
const LOG_FORMAT = process.env.LOG_FORMAT || 'text';
function log(level, event, extra = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...extra
  };
  if (LOG_FORMAT === 'json') {
    console.log(JSON.stringify(payload));
  } else {
    const { userId, sessionId, durationMs, error } = extra;
    let details = '';
    if (userId) details += ` | user: ${userId}`;
    if (sessionId) details += ` | session: ${sessionId}`;
    if (durationMs) details += ` | took: ${durationMs}ms`;
    if (error) details += ` | error: ${error}`;
    console.log(`[${payload.timestamp}] [${level.toUpperCase()}] ${event}${details}`);
  }
}

// Prometheus Setup
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const activeSessionsGauge = new client.Gauge({
  name: 'nova_sessions_active',
  help: 'Number of active sandbox sessions',
  registers: [register]
});
const totalSessionsCounter = new client.Counter({
  name: 'nova_sessions_total',
  help: 'Total number of sessions created',
  registers: [register]
});
const containerSpawnDurationHistogram = new client.Histogram({
  name: 'nova_container_spawn_duration_ms',
  help: 'Duration of docker container spawning in ms',
  registers: [register]
});
const errorsCounter = new client.Counter({
  name: 'nova_errors_total',
  help: 'Total number of server-side errors',
  labelNames: ['type'],
  registers: [register]
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-256-bit-default-secret';
const BASE_WORKSPACE = path.join(__dirname, '../workspace');

fs.ensureDirSync(BASE_WORKSPACE);

const activeSessions = {};

const authenticateREST = (req, res, next) => {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (token === 'nova-super-secret-token') {
      const localUserId = req.headers['x-user-id'] || req.query.localUserId || 'local-student';
      if (!/^[a-zA-Z0-9_\-]+$/.test(localUserId)) {
        return res.status(400).json({ error: 'Invalid user identifier' });
      }
      req.user = { userId: localUserId };
    } else {
      req.user = jwt.verify(token, JWT_SECRET);
    }
    next();
  } catch (err) {
    res.status(403).json({ error: 'Forbidden' });
  }
};

app.post('/sessions', authenticateREST, (req, res) => {
  const userId = req.user.userId;
  const sessionId = crypto.randomUUID();
  const containerId = `nova-sandbox-${sessionId}`;
  const userWorkspace = path.join(BASE_WORKSPACE, userId);
  
  fs.ensureDirSync(userWorkspace);
  fs.chmodSync(userWorkspace, 0o755);

  const pythonPackagesPath = path.join(userWorkspace, '.python_packages');
  fs.ensureDirSync(pythonPackagesPath);
  fs.chmodSync(pythonPackagesPath, 0o777);

  const hostWorkspace = process.env.HOST_WORKSPACE_DIR
    ? path.join(process.env.HOST_WORKSPACE_DIR, userId)
    : userWorkspace;

  // Resource limits from environment variables
  const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY_MB ? `${process.env.CONTAINER_MEMORY_MB}m` : '256m';
  const CONTAINER_CPUS = process.env.CONTAINER_CPUS || '0.5';
  const CONTAINER_PIDS = process.env.CONTAINER_PIDS_LIMIT || '50';

  try {
    const network = process.env.DOCKER_NETWORK || 'bridge';
    const cmd = `docker run -d --name ${containerId} --network ${network} --rm --memory=${CONTAINER_MEMORY} --memory-swap=${CONTAINER_MEMORY} --cpus=${CONTAINER_CPUS} --pids-limit=${CONTAINER_PIDS} --read-only --tmpfs /tmp:rw,size=50m,mode=1777 --tmpfs /home/student:rw,size=10m,mode=1777 -e PYTHONPATH=/workspace/.python_packages -e PIP_TARGET=/workspace/.python_packages -v ${hostWorkspace}:/workspace -w /workspace nova-engine-sandbox sleep 7200`;
    
    const startSpawn = Date.now();
    if (process.env.NODE_ENV !== 'test') {
      execSync(cmd);
    }
    const spawnDuration = Date.now() - startSpawn;
    containerSpawnDurationHistogram.observe(spawnDuration);
    
    activeSessions[sessionId] = {
      containerId,
      userId,
      lastActiveTime: Date.now(),
      startTime: Date.now(),
      ptyProcess: null,
      previewVersion: 1,
      consoleLogs: []
    };
    
    totalSessionsCounter.inc();
    activeSessionsGauge.set(Object.keys(activeSessions).length);

    log('info', 'Session created', { sessionId, userId, durationMs: spawnDuration });
    res.json({ sessionId, containerId });
  } catch (err) {
    errorsCounter.inc({ type: 'spawn_sandbox_failed' });
    log('error', 'Failed to spawn sandbox', { userId, error: err.message });
    res.status(500).json({ error: 'Failed to create sandbox session' });
  }
});

app.delete('/sessions/:id', authenticateREST, (req, res) => {
  const { id } = req.params;
  const session = activeSessions[id];
  
  if (!session || session.userId !== req.user.userId) return res.status(404).json({ error: 'Session not found' });
  
  try { execSync(`docker rm -f ${session.containerId}`); } catch (e) {}
  if (session.ptyProcess) session.ptyProcess.kill();
  delete activeSessions[id];
  res.json({ success: true });
});

app.post('/sessions/:id/upload', authenticateREST, async (req, res) => {
  const { id } = req.params;
  const { filename, content } = req.body;
  const session = activeSessions[id];
  
  if (!session || session.userId !== req.user.userId) return res.status(404).json({ error: 'Session not found' });
  if (!filename || filename.includes('..') || filename.includes('\0') || path.isAbsolute(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  const userWorkspace = path.join(BASE_WORKSPACE, session.userId);
  const safePath = path.normalize(filename).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(userWorkspace, safePath);
  
  try {
    await fs.ensureDir(path.dirname(filePath));
    
    // Ensure all created project directories are writable by the container student user (0o777)
    let dir = path.dirname(filePath);
    while (dir && dir !== userWorkspace && dir !== BASE_WORKSPACE && dir.startsWith(userWorkspace)) {
      await fs.chmod(dir, 0o777);
      dir = path.dirname(dir);
    }

    await fs.writeFile(filePath, content || '', 'utf8');
    session.previewVersion = (session.previewVersion || 0) + 1;
    res.json({ success: true, filename: safePath });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write file to host map' });
  }
});

app.delete('/sessions/:id/files', authenticateREST, async (req, res) => {
  const { id } = req.params;
  const { filename } = req.body;
  const session = activeSessions[id];
  
  if (!session || session.userId !== req.user.userId) return res.status(404).json({ error: 'Session not found' });
  if (!filename || filename.includes('..') || path.isAbsolute(filename)) return res.status(400).json({ error: 'Invalid filename' });

  const safePath = path.normalize(filename).replace(/^(\.\.[\/\\])+/, '');
  if (!/^[a-zA-Z0-9_\-\.\/]+$/.test(safePath)) return res.status(400).json({ error: 'Invalid filename characters' });

  const userWorkspace = path.join(BASE_WORKSPACE, session.userId);
  const filePath = path.join(userWorkspace, safePath);

  try {
    if (await fs.exists(filePath)) {
      await fs.remove(filePath);
      session.previewVersion = (session.previewVersion || 0) + 1;
    }
    res.json({ success: true, filename: safePath });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete file from host map' });
  }
});

app.post('/sessions/:id/format', authenticateREST, async (req, res) => {
  const { id } = req.params;
  const { filename, language } = req.body;
  const session = activeSessions[id];
  
  if (!session || session.userId !== req.user.userId) return res.status(404).json({ error: 'Session not found' });
  if (!filename || filename.includes('..') || path.isAbsolute(filename)) return res.status(400).json({ error: 'Invalid filename' });

  const safePath = path.normalize(filename).replace(/^(\.\.[\/\\])+/, '');
  if (!/^[a-zA-Z0-9_\-\.\/]+$/.test(safePath)) return res.status(400).json({ error: 'Invalid filename characters' });

  if (language === 'python') {
    const userWorkspace = path.join(BASE_WORKSPACE, session.userId);
    const filePath = path.join(userWorkspace, safePath);

    try {
      const formatCmd = `docker exec ${session.containerId} bash -c "if command -v black &> /dev/null; then black /workspace/${safePath}; elif command -v autopep8 &> /dev/null; then autopep8 --in-place /workspace/${safePath}; else exit 1; fi"`;
      execSync(formatCmd);
      
      const formattedContent = await fs.readFile(filePath, 'utf8');
      session.previewVersion = (session.previewVersion || 0) + 1;
      res.json({ success: true, content: formattedContent });
    } catch (e) {
      res.status(500).json({ error: 'Formatter failed to execute or format.' });
    }
  } else {
    res.status(400).json({ error: 'Formatting only supported for Python.' });
  }
});

// ── HTTP: Exec Command (SSE Streaming) ──
app.post('/sessions/:id/exec', authenticateREST, (req, res) => {
  const { id } = req.params;
  const { command } = req.body;
  const session = activeSessions[id];
  
  if (!session || session.userId !== req.user.userId) return res.status(404).json({ error: 'Session not found' });
  if (!command) return res.status(400).json({ error: 'Command required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const execProcess = spawn('docker', ['exec', session.containerId, 'bash', '-c', command]);

  execProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
    }
  });

  execProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
    }
  });

  execProcess.on('close', (code) => {
    res.write(`data: ${JSON.stringify({ text: `Process exited with code ${code}` })}\n\n`);
    res.write('event: done\ndata: {}\n\n');
    res.end();
  });
});

app.get('/sessions/:id/packages', authenticateREST, async (req, res) => {
  const { id } = req.params;
  const session = activeSessions[id];
  if (!session || session.userId !== req.user.userId) return res.status(404).json({ error: 'Session not found' });

  const userWorkspace = path.join(BASE_WORKSPACE, session.userId);
  const projectName = req.query.projectName;
  const projectPath = projectName ? path.join(userWorkspace, projectName) : userWorkspace;
  
  try {
    const packages = { npm: [], pip: [] };

    // Read npm packages from package.json
    const pkgJsonPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = await fs.readJson(pkgJsonPath);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      packages.npm = Object.keys(deps).map(key => ({
        id: key, name: key, version: deps[key] || 'installed', description: 'Installed via package.json'
      }));
    }

    // Read pip packages from .python_packages directory
    const pipDir = path.join(userWorkspace, '.python_packages');
    if (fs.existsSync(pipDir)) {
      const items = await fs.readdir(pipDir);
      const dirs = [];
      for (const item of items) {
        const itemPath = path.join(pipDir, item);
        const stat = await fs.stat(itemPath);
        if (stat.isDirectory() && !item.includes('.dist-info') && !item.includes('__pycache__') && item !== 'bin') {
          dirs.push({
            id: item, name: item, version: 'installed', description: 'Local package'
          });
        }
      }
      packages.pip = dirs;
    }

    res.json(packages);
  } catch (err) {
    log('error', 'Failed to read packages', { sessionId: id, error: err.message });
    res.status(500).json({ error: 'Failed to list packages' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: Object.keys(activeSessions).length,
    containerPoolSize: Object.keys(activeSessions).length,
    uptime: Math.floor(process.uptime()),
    version: ENGINE_VERSION
  });
});

app.get('/metrics', async (req, res) => {
  try {
    activeSessionsGauge.set(Object.keys(activeSessions).length);
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

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

  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    if (!fs.existsSync(filePath)) return res.status(404).send('<h2>index.html not found</h2>');
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

app.all('/sessions/:id/proxy/:port/*', (req, res) => {
  const { id, port } = req.params;
  const session = activeSessions[id];
  if (!session) return res.status(404).send('<h2>Sandbox Offline</h2>');

  const reqPath = req.params[0] || '';
  const queryStr = req.url.split('?')[1] || '';
  const destPath = '/' + reqPath + (queryStr ? '?' + queryStr : '');
  const targetHost = session.containerId;

  const options = {
    hostname: targetHost,
    port: parseInt(port, 10),
    path: destPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${targetHost}:${port}`
    }
  };

  delete options.headers['x-auth-token'];
  delete options.headers['x-user-id'];

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    log('error', 'Proxy request failed', { sessionId: id, port, path: destPath, error: err.message });
    res.status(502).send(`<h2>Proxy Connection Failed</h2><p>Could not connect to service on port ${port} inside the sandbox container. Make sure your server is running.</p>`);
  });

  req.pipe(proxyReq, { end: true });
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

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of Object.entries(activeSessions)) {
    const isIdle = now - session.lastActiveTime > 30 * 60000;
    const isExpired = now - session.startTime > 2 * 3600000;
    
    if (isIdle || isExpired) {
      try { exec(`docker rm -f ${session.containerId}`); } catch(e) {}
      if (session.ptyProcess) session.ptyProcess.kill();
      delete activeSessions[id];
    }
  }
}, 60000);

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const token = url.searchParams.get('token') || request.headers['x-auth-token'];
  const match = url.pathname.match(/^\/sessions\/([^\/]+)\/terminal$/);
  
  if (!match) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
  if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }

  try {
    if (token === 'nova-super-secret-token') {
      const localUserId = url.searchParams.get('localUserId') || request.headers['x-user-id'] || 'local-student';
      if (!/^[a-zA-Z0-9_\-]+$/.test(localUserId)) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        return socket.destroy();
      }
      request.user = { userId: localUserId };
    } else {
      request.user = jwt.verify(token, JWT_SECRET);
    }
    request.sessionId = match[1];
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } catch (err) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws, request) => {
  const session = activeSessions[request.sessionId];
  if (!session || session.userId !== request.user.userId) return ws.close();
  
  session.lastActiveTime = Date.now();

  const url = new URL(request.url, 'http://localhost');
  const project = url.searchParams.get('project');
  let workdir = '/workspace';
  if (project) {
    const safeProject = project.replace(/[^a-zA-Z0-9_\-]+/g, '');
    if (safeProject) {
      workdir = `/workspace/${safeProject}`;
    }
  }

  const ptyProcess = pty.spawn('docker', ['exec', '-it', '-w', workdir, session.containerId, '/bin/bash'], { cols: 80, rows: 24 });
  session.ptyProcess = ptyProcess;

  ptyProcess.onData(data => ws.send(JSON.stringify({ type: 'output', data })));
  ws.on('message', message => {
    session.lastActiveTime = Date.now();
    try {
      const payload = JSON.parse(message);
      if (payload.type === 'input') ptyProcess.write(payload.data);
      else if (payload.type === 'resize') ptyProcess.resize(payload.cols || 80, payload.rows || 24);
    } catch (err) {}
  });
  ws.on('close', () => {
    ptyProcess.kill();
    session.ptyProcess = null;
  });
});

let isShuttingDown = false;
const gracefulShutdown = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  log('info', `Received signal ${signal}, initiating graceful shutdown...`);

  server.close(async () => {
    log('info', 'HTTP/WS server closed. Cleaning up docker containers...');
    
    const sessionIds = Object.keys(activeSessions);
    const cleanupPromises = sessionIds.map(sessionId => {
      const session = activeSessions[sessionId];
      log('info', 'Killing container', { sessionId, containerId: session.containerId });
      
      return new Promise((resolve) => {
        exec(`docker rm -f ${session.containerId}`, () => {
          if (session.ptyProcess) {
            try { session.ptyProcess.kill(); } catch (e) {}
          }
          resolve();
        });
      });
    });

    await Promise.all(cleanupPromises);
    log('info', 'All docker containers cleaned up successfully. Exiting.');
    process.exit(0);
  });

  setTimeout(() => {
    log('error', 'Force shutdown timed out. Exiting immediately.');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, () => log('info', `Nova Engine active and running on port ${PORT}`, { port: PORT }));
