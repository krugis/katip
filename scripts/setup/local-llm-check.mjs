#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm test:local-llm: a real model behind the whole gateway, on the running dev stack, with
 * KATIP_LOCAL_LLM_UPSTREAM set in katip.env. The mock only echoes. This shows the product
 * works with what a real model really sends back.
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { AUTO_KEYS, deriveEnv, loadAllTenantSecrets, tenantSecretOf } from './steps.mjs';
import { ensureEnvFile, INFRA } from './util.mjs';

const config = loadConfig();
const project = config.project.name;
const ctx = { config, infra: INFRA, env: ensureEnvFile(AUTO_KEYS, deriveEnv).env, log: () => {} };
loadAllTenantSecrets(ctx);
if (!ctx.env.KATIP_LOCAL_LLM_UPSTREAM) {
  console.error('Set KATIP_LOCAL_LLM_UPSTREAM in infra/env/katip.env, then run pnpm dev:up.');
  process.exit(1);
}

const tenant = config.tenants[0];
const key = tenantSecretOf(ctx, tenant, 'GATEWAY_KEY');
const USER = 'demo@example.com';

let checks = 0;
const check = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  checks += 1;
  console.log(`  ok  ${what}`);
};

/** From inside the backend network, as a company's LibreChat reaches the gateway. */
const call = (path, body, { stream = false } = {}) => {
  const script = `
    const started = Date.now();
    const r = await fetch('http://policy-gateway:8080/v1' + process.env.P, {
      method: process.env.B ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + process.env.K, 'x-user-email': process.env.E, 'content-type': 'application/json' },
      ...(process.env.B ? { body: process.env.B } : {}),
    });
    const text = await r.text();
    console.log(JSON.stringify({ status: r.status, text, ms: Date.now() - started }));`;
  const out = execFileSync(
    'docker',
    [
      'exec',
      '-e',
      `K=${key}`,
      '-e',
      `E=${USER}`,
      '-e',
      `P=${path}`,
      '-e',
      `B=${body ? JSON.stringify({ ...body, stream }) : ''}`,
      `${project}-console-api-1`,
      'node',
      '--input-type=module',
      '-e',
      script,
    ],
    { encoding: 'utf8', timeout: 300_000, maxBuffer: 50_000_000 },
  );
  return JSON.parse(out);
};
const sql = (query) =>
  execFileSync(
    'docker',
    [
      'exec',
      `${project}-postgres-1`,
      'psql',
      '-U',
      ctx.env.POSTGRES_USER,
      '-d',
      'governance',
      '-Atc',
      query,
    ],
    { encoding: 'utf8' },
  ).trim();

const usageCount = () =>
  Number(
    sql(
      `select count(*) from usage_events u join tenants t on t.id = u.tenant_id where t.slug = '${tenant.slug}'`,
    ),
  );
const contentOf = (r) => JSON.parse(r.text).choices?.[0]?.message?.content ?? '';

console.log(`A real model, through the gateway, as ${tenant.slug}`);
try {
  const before = usageCount();

  console.log('an ordinary answer');
  let r = call('/chat/completions', {
    model: 'fast',
    messages: [
      { role: 'user', content: 'Türkiye’nin başkenti neresidir? Tek kelimeyle cevap ver.' },
    ],
    max_tokens: 1500,
  });
  check(r.status === 200, `the gateway answers (${r.ms} ms)`);
  const answer = contentOf(r);
  console.log(`      model said: ${answer.slice(0, 120).replace(/\s+/g, ' ')}`);
  check(/ankara/i.test(answer), 'and it is really the model: it knows the capital of Turkey');
  check(!/echo:/i.test(answer), 'not the mock');
  const usage = JSON.parse(r.text).usage;
  check(usage?.prompt_tokens > 0 && usage?.completion_tokens > 0, 'it reports real token counts');

  console.log('streaming, as LibreChat uses it');
  r = call(
    '/chat/completions',
    {
      model: 'fast',
      messages: [{ role: 'user', content: 'Say the word hello, nothing else.' }],
      max_tokens: 1500,
    },
    { stream: true },
  );
  check(r.status === 200, `the stream opens (${r.ms} ms)`);
  const events = r.text.split('\n').filter((l) => l.startsWith('data: '));
  check(events.length > 1, `it arrives in pieces (${events.length} events)`);
  check(events.at(-1)?.trim() === 'data: [DONE]', 'and ends properly');
  const streamed = events
    .slice(0, -1)
    .map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? '')
    .join('');
  console.log(`      model said: ${streamed.slice(0, 120).replace(/\s+/g, ' ')}`);
  check(/hello/i.test(streamed), 'with the real answer in it');

  console.log('personal data, with a model that really reads it');
  const secretName = 'Ayşe Yılmaz';
  const email = 'ayse.yilmaz@ornek.com.tr';
  r = call('/chat/completions', {
    model: 'fast',
    messages: [
      {
        role: 'user',
        content: `Şu e-posta adresini aynen tekrar et, başka bir şey yazma: ${email}`,
      },
    ],
    max_tokens: 1500,
  });
  check(r.status === 200, `the gateway answers (${r.ms} ms)`);
  console.log(`      user sees: ${contentOf(r).slice(0, 140).replace(/\s+/g, ' ')}`);
  check(
    contentOf(r).includes(email),
    'the placeholder the model repeated becomes the address again',
  );
  check(
    !JSON.stringify(
      sql("select coalesce(string_agg(tool_calls::text, ','), '') from usage_events"),
    ).includes(secretName),
    'and nothing personal reached the usage records',
  );

  console.log('a tool call, as an MCP tool would need');
  r = call('/chat/completions', {
    model: 'fast',
    messages: [{ role: 'user', content: 'What is the weather in Ankara? Use the tool.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Gets the current weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
    max_tokens: 1500,
  });
  check(r.status === 200, `the gateway answers (${r.ms} ms)`);
  const calls = JSON.parse(r.text).choices?.[0]?.message?.tool_calls ?? [];
  console.log(`      tool calls: ${JSON.stringify(calls.map((c) => c.function?.name))}`);
  check(
    calls[0]?.function?.name === 'get_weather',
    'the model calls the tool, through the gateway',
  );
  const after = usageCount();
  check(after >= before + 4, `usage is recorded (${after - before} new events)`);
  const logged = sql(
    `select u.tool_calls::text from usage_events u join tenants t on t.id = u.tenant_id where t.slug = '${tenant.slug}' order by u.ts desc limit 1`,
  );
  check(logged.includes('get_weather'), 'with the tool name, and not its arguments');
  check(!logged.includes('Ankara'), 'its arguments stay out');

  console.log('the relay');
  const refused = execFileSync(
    'docker',
    [
      'exec',
      `${project}-demo-lc-demo-1`,
      'node',
      '-e',
      `require('net').connect(${ctx.env.KATIP_LOCAL_LLM_RELAY_PORT ?? 18090},'host.docker.internal').on('error',()=>{console.log('closed');process.exit()}).on('close',()=>{console.log('closed');process.exit()}).on('connect',function(){this.write('GET /v1/models HTTP/1.0\\r\\n\\r\\n')}).on('data',()=>{console.log('open');process.exit()});setTimeout(()=>{console.log('closed');process.exit()},4000)`,
    ],
    { encoding: 'utf8' },
  ).trim();
  check(refused === 'closed', "a company's LibreChat can't reach the model around the gateway");

  console.log(`\nAll ${checks} checks passed.`);
} catch (e) {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
}
