// SPDX-License-Identifier: AGPL-3.0-only
import { buildMockApp } from './app.js';

const port = Number(process.env['PORT'] ?? 4010);
const failModels = (process.env['MOCK_FAIL_MODELS'] ?? '').split(',').filter(Boolean);
const app = buildMockApp({ failModels, delayMs: Number(process.env['MOCK_DELAY_MS'] ?? 0) });
await app.listen({ host: '0.0.0.0', port });
console.log(`mock-llm listening on :${port}`);
