import { Readable } from 'node:stream';

process.env.SIGNER_PROVIDER ||= 'mock';
process.env.SIGNER_ADMIN_TOKEN ||= 'smoke-token';
process.env.PUBLIC_BASE_URL ||= 'http://127.0.0.1:3100';
process.env.SIGNER_LEDGER_PATH ||= '.data/vercel-handler-smoke-ledger.json';

const { default: handler, resetHandlerForTests } = await import('../api/[...path].js');
resetHandlerForTests();

const health = await invoke({ method: 'GET', url: '/api/health' });
const unauthorized = await invoke({ method: 'GET', url: '/api/v1/agents' });
const authorized = await invoke({
  method: 'GET',
  url: '/api/v1/agents',
  headers: {
    authorization: 'Bearer smoke-token',
  },
});

const ok = health.statusCode === 200
  && unauthorized.statusCode === 401
  && authorized.statusCode === 200
  && health.body.status === 'ok'
  && Array.isArray(authorized.body.agents);

console.log(JSON.stringify({
  ok,
  health_status: health.statusCode,
  unauthorized_status: unauthorized.statusCode,
  authorized_status: authorized.statusCode,
  route_prefix: '/api -> app routes',
}, null, 2));

if (!ok) {
  process.exitCode = 1;
}

async function invoke({ method, url, headers = {}, body = undefined }) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;

  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(statusCode, responseHeaders) {
        this.statusCode = statusCode;
        this.headers = responseHeaders;
      },
      end(raw) {
        resolve({
          statusCode: this.statusCode,
          headers: this.headers,
          body: JSON.parse(raw || '{}'),
        });
      },
    };

    Promise.resolve(handler(req, res)).catch((error) => {
      resolve({
        statusCode: 500,
        headers: {},
        body: {
          error: 'handler_error',
          message: error.message,
        },
      });
    });
  });
}
