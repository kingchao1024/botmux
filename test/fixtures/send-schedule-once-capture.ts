import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';

(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url = String(config.url);
  let data;
  if (url.includes('/auth/')) {
    data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  } else if (url.endsWith('/im/v1/messages')) {
    console.log(`CAPTURE_REQUEST=${JSON.stringify({
      method: config.method,
      params: config.params,
      data: JSON.parse(config.data),
    })}`);
    data = { code: 0, data: { message_id: 'om_schedule_once' } };
  } else if (url.includes('/im/v1/chats/')) {
    data = { code: 0, data: { chat_mode: 'group', chat_type: 'private' } };
  } else {
    throw new Error(`Unexpected HTTP request: ${url}`);
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};

process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
