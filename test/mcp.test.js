import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP stdio handshake, schemas, safe closed status and rejected arbitrary input', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/server.js'], stderr: 'pipe' });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.equal(result.tools.length, 17);
    for (const name of ['connect_exec','connect_start','connect_job','connect_cancel','connect_file_read','connect_file_write','connect_file_diff','connect_reconnect']) assert.ok(result.tools.some(tool => tool.name === name));
    const status = await client.callTool({ name: 'connect_status', arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).status, 'closed');
    const unknown = await client.callTool({ name: 'connect_diagnostic', arguments: { sessionId: '00000000-0000-4000-8000-000000000000', probe: 'rm -rf /' } });
    assert.equal(unknown.isError, true);
  } finally { await client.close(); }
});
