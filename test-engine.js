// test-engine.js
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const assert = require('assert');

const TEST_PORT = 3999;
process.env.PORT = TEST_PORT;
process.env.JWT_SECRET = 'engine-test-secret-key-123456';
process.env.LOG_FORMAT = 'text';
process.env.NODE_ENV = 'test';

console.log('Starting Nova Engine server in test mode...');
const serverProc = spawn('node', ['src/server.js'], {
  env: process.env,
  stdio: 'inherit'
});

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: TEST_PORT,
      ...options
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: data
      }));
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  // Wait 2 seconds for server boot-up
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('\n--- Running Backend Engine Tests ---');

  let activeSessionId = null;

  try {
    // 1. Health Check Test
    console.log('Test 1: Health check endpoint /health...');
    const healthRes = await request({ path: '/health', method: 'GET' });
    assert.strictEqual(healthRes.statusCode, 200);
    assert.strictEqual(healthRes.headers['x-nova-engine-version'], '1.2.0');
    const healthBody = JSON.parse(healthRes.body);
    assert.strictEqual(healthBody.version, '1.2.0');
    console.log('✓ Health check passed.');

    // 2. Metrics Check Test
    console.log('Test 2: Metrics endpoint /metrics...');
    const metricsRes = await request({ path: '/metrics', method: 'GET' });
    assert.strictEqual(metricsRes.statusCode, 200);
    assert.ok(metricsRes.body.includes('nova_sessions_active'));
    console.log('✓ Metrics check passed.');

    // 3. REST Unauthenticated Request Test
    console.log('Test 3: REST unauthenticated barrier...');
    const sessionRes = await request({ path: '/sessions', method: 'POST' });
    assert.strictEqual(sessionRes.statusCode, 401);
    console.log('✓ REST unauthenticated barrier passed.');

    // 4. REST Forbidden Request Test
    console.log('Test 4: REST invalid token barrier...');
    const badTokenRes = await request({
      path: '/sessions',
      method: 'POST',
      headers: { 'x-auth-token': 'bad-token-signature' }
    });
    assert.strictEqual(badTokenRes.statusCode, 403);
    console.log('✓ REST invalid token barrier passed.');

    // 5. Create Session Test
    console.log('Test 5: Create session with token...');
    const createSessionRes = await request({
      path: '/sessions',
      method: 'POST',
      headers: {
        'x-auth-token': 'nova-super-secret-token',
        'content-type': 'application/json'
      }
    });
    assert.strictEqual(createSessionRes.statusCode, 200);
    const sessionBody = JSON.parse(createSessionRes.body);
    assert.ok(sessionBody.sessionId);
    activeSessionId = sessionBody.sessionId;
    console.log(`✓ Create session passed (Session ID: ${activeSessionId}).`);

    // 6. Path Traversal Protection Test
    console.log('Test 6: REST path traversal checks...');
    const uploadRes = await request({
      path: `/sessions/${activeSessionId}/upload`,
      method: 'POST',
      headers: {
        'x-auth-token': 'nova-super-secret-token',
        'content-type': 'application/json'
      }
    }, {
      filename: '../../etc/passwd',
      content: 'malicious'
    });
    // Expected 400 Bad Request due to path traversal checks
    assert.strictEqual(uploadRes.statusCode, 400);
    const uploadBody = JSON.parse(uploadRes.body);
    assert.strictEqual(uploadBody.error, 'Invalid filename');
    console.log('✓ Path traversal protection passed.');

    // 7. Successful File Upload Test
    console.log('Test 7: Successful file upload...');
    const uploadSuccessRes = await request({
      path: `/sessions/${activeSessionId}/upload`,
      method: 'POST',
      headers: {
        'x-auth-token': 'nova-super-secret-token',
        'content-type': 'application/json'
      }
    }, {
      filename: 'test.py',
      content: 'print("hello test")'
    });
    assert.strictEqual(uploadSuccessRes.statusCode, 200);
    const uploadSuccessBody = JSON.parse(uploadSuccessRes.body);
    assert.strictEqual(uploadSuccessBody.success, true);
    assert.strictEqual(uploadSuccessBody.filename, 'test.py');
    console.log('✓ File upload passed.');

    // 8. WebSocket Connection Without Token Test
    console.log('Test 8: WebSocket unauthorized connection check...');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/sessions/${activeSessionId}/terminal`);
      ws.on('open', () => {
        reject(new Error('WebSocket should not connect without token'));
      });
      ws.on('unexpected-response', (req, res) => {
        assert.strictEqual(res.statusCode, 401);
        ws.close();
        resolve();
      });
      ws.on('error', () => {
        resolve();
      });
    });
    console.log('✓ WebSocket connection unauthorized check passed.');

    // 9. WebSocket Connection With Bad Token Test
    console.log('Test 9: WebSocket forbidden connection check...');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/sessions/${activeSessionId}/terminal?token=bad-token`);
      ws.on('open', () => {
        reject(new Error('WebSocket should not connect with bad token'));
      });
      ws.on('unexpected-response', (req, res) => {
        assert.strictEqual(res.statusCode, 403);
        ws.close();
        resolve();
      });
      ws.on('error', () => {
        resolve();
      });
    });
    console.log('✓ WebSocket connection forbidden check passed.');

    // 10. Delete Session Test
    console.log('Test 10: Delete session...');
    const deleteRes = await request({
      path: `/sessions/${activeSessionId}`,
      method: 'DELETE',
      headers: {
        'x-auth-token': 'nova-super-secret-token'
      }
    });
    assert.strictEqual(deleteRes.statusCode, 200);
    console.log('✓ Delete session passed.');

    console.log('\nAll backend engine tests PASSED successfully!');
  } catch (error) {
    console.error('Test run failed with error:', error);
    process.exitCode = 1;
  } finally {
    console.log('Cleaning up server process...');
    serverProc.kill('SIGTERM');
  }
}

runTests();
