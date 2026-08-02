'use strict';

const http = require('node:http');

async function startFakeOtlpReceiver() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        pathname: new URL(request.url, 'http://127.0.0.1').pathname,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/v1/logs`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function startHangingOtlpReceiver() {
  const requests = [];
  const server = http.createServer((request) => {
    request.resume();
    requests.push({
      method: request.method,
      pathname: new URL(request.url, 'http://127.0.0.1').pathname,
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/v1/logs`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function testSink(endpoint) {
  return {
    id: 'test',
    egress: 'loopback',
    outbox: { enabled: true, endpoint, headers: {}, allowRemote: false },
  };
}

module.exports = { startFakeOtlpReceiver, startHangingOtlpReceiver, testSink };
