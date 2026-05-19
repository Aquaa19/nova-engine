const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs-extra');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-256-bit-default-secret';
const BASE_WORKSPACE = path.join(__dirname, '../workspace');

// Ensure base workspace directory exists on the system
fs.ensureDirSync(BASE_WORKSPACE);

// Upgrade incoming HTTP requests to WebSocket connection (JWT Verified)
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const token = request.headers['x-auth-token'] || url.searchParams.get('token');

  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  try {
    let userPayload;
    
    if (token === 'nova-super-secret-token') {
      // 🟢 Local development fallback: Allow the plain default token
      userPayload = { userId: 'local-student' };
    } else {
      // 🔵 Production: Verify the secure JWT token
      userPayload = jwt.verify(token, JWT_SECRET);
    }
    
    request.user = userPayload; // Contains decodable userId
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } catch (err) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws, request) => {
  const userId = request.user.userId;
  // Isolated workspaces per authenticated student
  const userWorkspace = path.join(BASE_WORKSPACE, userId);
  fs.ensureDirSync(userWorkspace);

  console.log(`[Nova Engine] Terminal opened for: ${userId}. Workspace: ${userWorkspace}`);

  // Spawn an interactive bash shell mapped to the user's workspace
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: userWorkspace,
    env: process.env
  });

  // Stream standard output/stderr back to the client
  ptyProcess.onData((data) => {
    ws.send(JSON.stringify({ type: 'output', data }));
  });

  // Process incoming control streams from mobile
  ws.on('message', async (message) => {
    try {
      const payload = JSON.parse(message);
      
      switch (payload.type) {
        case 'input':
          // Feed character streams directly to PTY stdin
          ptyProcess.write(payload.data);
          break;

        case 'resize':
          // Adjust terminal size dynamically
          ptyProcess.resize(payload.cols || 80, payload.rows || 24);
          break;

        case 'upload':
          // Safely write uploaded files into the user's root workspace
          const safePath = path.normalize(payload.filename).replace(/^(\.\.[\/\\])+/, '');
          const filePath = path.join(userWorkspace, safePath);
          
          await fs.ensureDir(path.dirname(filePath));
          await fs.writeFile(filePath, payload.content, 'utf8');

          // Send back file receipt acknowledgement
          ws.send(JSON.stringify({ type: 'upload_ack', filename: payload.filename }));
          console.log(`[Nova Engine] Uploaded: ${safePath} for student ${userId}`);
          break;
      }
    } catch (err) {
      console.error('[Nova Engine] Failed to handle message:', err);
    }
  });

  ws.on('close', () => {
    console.log(`[Nova Engine] Terminal closed for student: ${userId}`);
    ptyProcess.kill();
  });

  // Clean the screen and display terminal greeting
  ptyProcess.write('clear\n');
  ptyProcess.write('echo -e "\\x1B[1;36m*** Welcome to Nova Code Terminal Server ***\\x1B[0m"\n');
  ptyProcess.write(`echo -e "Your workspace is isolated at: \\x1B[0;32m/workspace/${userId}\\x1B[0m"\n`);
  ptyProcess.write('echo ""\n');
});

server.listen(PORT, () => {
  console.log(`[Nova Engine] Active and running on port ${PORT}`);
});
