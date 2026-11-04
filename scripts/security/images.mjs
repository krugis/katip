// SPDX-License-Identifier: AGPL-3.0-only
// The images the security scans cover (P1-46, LLD-10 §6): ours, built from this repo, and the
// third-party pins in katip.config.yaml. Used by .github/workflows/images.yml.
//
//   node scripts/security/images.mjs ours                  JSON list of our image names
//   node scripts/security/images.mjs build <name> <tag>    builds one of ours as <tag>
//   node scripts/security/images.mjs third-party [<file>]  JSON list of pins; with the base
//                                                          branch's config file, each says
//                                                          whether the PR changed it
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { composeEnv, loadConfig } from '../setup/config.mjs';
import { pinsOf } from '../setup/deploy-lib.mjs';
import { ROOT, parseYaml } from '../setup/util.mjs';

/** What docker build needs for each of ours. Matches infra/compose/*.yml. */
export function ourImages(config) {
  const env = composeEnv(config);
  const app = (name) => ({ name, context: '.', dockerfile: `apps/${name}/Dockerfile`, args: {} });
  return [
    app('policy-gateway'),
    app('console'),
    app('console-api'),
    app('provisioner'),
    app('mock-llm'),
    app('billing-bridge'),
    {
      name: 'litellm',
      context: 'infra/litellm',
      dockerfile: 'infra/litellm/Dockerfile',
      args: { LITELLM_VERSION: env.LITELLM_VERSION, LITELLM_SHA256: env.LITELLM_SHA256 },
    },
    {
      name: 'presidio-analyzer',
      context: 'infra/presidio',
      dockerfile: 'infra/presidio/Dockerfile',
      args: {
        PRESIDIO_REGISTRY: env.KATIP_PRESIDIO_REGISTRY,
        PRESIDIO_VERSION: env.KATIP_PRESIDIO_VERSION,
        SPACY_MODEL_VERSION: env.KATIP_SPACY_MODEL_VERSION,
        SPACY_MODEL_SHA256: env.KATIP_SPACY_MODEL_SHA256,
        NER_MODEL: env.KATIP_NER_MODEL,
        NER_MODEL_REVISION: env.KATIP_NER_MODEL_REVISION,
      },
    },
  ];
}

/**
 * Each pinned third-party image, and whether it is new or changed against `baseConfig`. A changed
 * pin is gated like our own images; one nobody touched is only reported, or every PR would wait
 * on fixes upstream hasn't released.
 */
export function thirdPartyImages(config, baseConfig = null) {
  const basePins = baseConfig ? pinsOf(baseConfig) : null;
  return Object.entries(pinsOf(config)).map(([name, image]) => ({
    name,
    image,
    changed: basePins ? basePins[name] !== image : false,
  }));
}

function main(argv) {
  const config = loadConfig();
  const [command, ...rest] = argv;
  if (command === 'ours') {
    console.log(JSON.stringify(ourImages(config).map((i) => i.name)));
    return;
  }
  if (command === 'build') {
    const [name, tag] = rest;
    const image = ourImages(config).find((i) => i.name === name);
    if (!image || !tag) throw new Error('usage: build <name> <tag>');
    const args = Object.entries(image.args).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]);
    execFileSync('docker', ['build', '-f', image.dockerfile, '-t', tag, ...args, image.context], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    return;
  }
  if (command === 'third-party') {
    // The base branch's config is only read for its pins: it may predate today's validation.
    const base = rest[0] ? parseYaml(readFileSync(rest[0], 'utf8')) : null;
    console.log(JSON.stringify(thirdPartyImages(config, base)));
    return;
  }
  throw new Error('usage: images.mjs ours | build <name> <tag> | third-party [<base config>]');
}

if (process.argv[1]?.endsWith('images.mjs')) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
