// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ToolCallLog } from '../src/tool-calls.js';

const call = (name: unknown, index?: number) => ({ index, function: { name, arguments: '{}' } });

describe('ToolCallLog', () => {
  it('lists the tools in a complete reply, one entry per call', () => {
    const log = new ToolCallLog();
    log.add(0, { tool_calls: [call('ara'), call('oku'), call('ara')] });
    expect(log.list()).toEqual(['ara', 'oku', 'ara']);
  });

  it('joins a streamed name that arrives in pieces', () => {
    const log = new ToolCallLog();
    log.add(0, { tool_calls: [call('hava_', 0)] });
    log.add(0, { tool_calls: [call('durumu', 0), call('ara', 1)] });
    log.add(0, { tool_calls: [{ index: 0, function: { arguments: '{"q":1}' } }] });
    expect(log.list()).toEqual(['hava_durumu', 'ara']);
  });

  it('keeps calls in different choices apart', () => {
    const log = new ToolCallLog();
    log.add(0, { tool_calls: [call('ara', 0)] });
    log.add(1, { tool_calls: [call('oku', 0)] });
    expect(log.list()).toEqual(['ara', 'oku']);
  });

  it('reads the legacy function_call too', () => {
    const log = new ToolCallLog();
    log.add(0, { function_call: { name: 'ara', arguments: '{}' } });
    expect(log.list()).toEqual(['ara']);
  });

  it('does not keep a name that does not look like one', () => {
    const log = new ToolCallLog();
    log.add(0, { tool_calls: [call('Ahmet Yilmaz TCKN 10000000146')] });
    expect(log.list()).toEqual(['<invalid>']);
  });

  it('never holds arguments', () => {
    const log = new ToolCallLog();
    log.add(0, { tool_calls: [{ function: { name: 'ara', arguments: '{"q":"10000000146"}' } }] });
    expect(JSON.stringify(log.list())).not.toContain('10000000146');
  });

  it('ignores replies without tool calls and malformed parts', () => {
    const log = new ToolCallLog();
    log.add(0, { tool_calls: 'x' });
    log.add(0, { tool_calls: [null, call(5)] });
    log.add(0, {});
    expect(log.list()).toEqual([]);
  });

  it('caps a reply with very many calls', () => {
    const log = new ToolCallLog();
    log.add(0, { tool_calls: Array.from({ length: 50 }, (_, i) => call(`t${i}`)) });
    expect(log.list()).toHaveLength(32);
  });
});
