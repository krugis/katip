// SPDX-License-Identifier: AGPL-3.0-only

/** Tool names are logged and stored, so anything that doesn't look like one isn't kept. */
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_TOOL_CALLS = 32;

interface ToolCallDelta {
  index?: number;
  function?: { name?: unknown };
}

/**
 * The tools a model asked to call in one reply: names only, never arguments, which can
 * hold anything. A streamed name can arrive in pieces, so pieces are joined per call.
 */
export class ToolCallLog {
  private readonly names = new Map<string, string>();

  /** A complete reply (`message`), or one streamed chunk (`delta`). */
  add(choiceIndex: number, part: { tool_calls?: unknown; function_call?: unknown }): void {
    if (Array.isArray(part.tool_calls)) {
      (part.tool_calls as ToolCallDelta[]).forEach((call, position) => {
        this.append(`${choiceIndex}:${call?.index ?? position}`, call?.function?.name);
      });
    }
    const legacy = part.function_call as { name?: unknown } | undefined;
    if (legacy) this.append(`${choiceIndex}:legacy`, legacy.name);
  }

  private append(key: string, fragment: unknown): void {
    if (typeof fragment !== 'string') return;
    this.names.set(key, (this.names.get(key) ?? '') + fragment);
  }

  /** One entry per call, so the same tool called twice appears twice. */
  list(): string[] {
    return [...this.names.values()]
      .slice(0, MAX_TOOL_CALLS)
      .map((name) => (TOOL_NAME.test(name) ? name : '<invalid>'));
  }
}
