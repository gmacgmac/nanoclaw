const { Client } = require('/app/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StdioClientTransport } = require('/app/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js');

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['/app/dist/ipc-mcp-stdio.js'],
    env: {
      ...process.env,
      NANOCLAW_CHAT_JID: 'test',
      NANOCLAW_GROUP_FOLDER: 'test',
      NANOCLAW_IS_MAIN: '1',
    }
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  const result = await client.listTools();
  console.log('Tools from MCP client:');
  result.tools.forEach((t, i) => console.log((i+1) + '. ' + t.name));
  await client.close();
}
main().catch(e => console.error('ERROR:', e.message));
