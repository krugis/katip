// SPDX-License-Identifier: AGPL-3.0-only
// Lets LiteLLM reach an LLM server that only listens on the host's localhost. Runs on the
// host's network, and takes connections from the backend network only, so a tenant's
// LibreChat can't use it to get round the gateway.
import { BlockList, connect, createServer } from 'node:net';

const { RELAY_BIND, RELAY_PORT, RELAY_ALLOW, RELAY_UPSTREAM } = process.env;
const [network, prefix] = RELAY_ALLOW.split('/');
const allowed = new BlockList();
allowed.addSubnet(network, Number(prefix), 'ipv4');
const [host, port] = RELAY_UPSTREAM.split(':');

createServer((client) => {
  const from = (client.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!allowed.check(from, 'ipv4')) {
    console.error(`refused ${from}`);
    client.destroy();
    return;
  }
  const upstream = connect(Number(port), host);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
}).listen(Number(RELAY_PORT), RELAY_BIND, () => {
  console.log(`relaying ${RELAY_BIND}:${RELAY_PORT} to ${RELAY_UPSTREAM}, from ${RELAY_ALLOW}`);
});
