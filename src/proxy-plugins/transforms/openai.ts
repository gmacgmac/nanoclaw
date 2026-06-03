/**
 * OpenAI ChatCompletions transform.
 *
 * Bidirectional conversion between Anthropic Messages API (Claude Code speaks this)
 * and OpenAI ChatCompletions API (Mantle serves open-source models with this).
 *
 * Pure functions — no HTTP, no env, no external dependencies.
 */

import {
  registerTransform,
  type InferenceTransform,
} from './registry.js';

// ----- Anthropic → OpenAI (Request) -----

interface AnthropicContentBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type: string; data: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
}

interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

function mapSystemToMessages(
  system: string | AnthropicContentBlock[] | undefined,
): OpenAIMessage[] {
  if (!system) return [];
  if (typeof system === 'string') {
    return [{ role: 'system', content: system }];
  }
  // Array of content blocks — concatenate text blocks
  const text = system
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n\n');
  return text ? [{ role: 'system', content: text }] : [];
}

function mapAnthropicMessage(msg: AnthropicMessage): OpenAIMessage[] {
  // Simple string content
  if (typeof msg.content === 'string') {
    return [{ role: msg.role, content: msg.content }];
  }

  // Content block array — split tool_result into separate messages
  const toolResults: OpenAIMessage[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  const contentParts: OpenAIContentPart[] = [];

  for (const block of msg.content) {
    switch (block.type) {
      case 'text':
        contentParts.push({ type: 'text', text: block.text ?? '' });
        break;
      case 'image': {
        const src = block.source;
        if (src?.type === 'base64') {
          contentParts.push({
            type: 'image_url',
            image_url: { url: `data:${src.media_type};base64,${src.data}` },
          });
        }
        break;
      }
      case 'tool_use':
        toolCalls.push({
          id: block.id!,
          type: 'function',
          function: {
            name: block.name!,
            arguments: typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {}),
          },
        });
        break;
      case 'tool_result':
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id!,
          content: typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? ''),
        });
        break;
    }
  }

  const messages: OpenAIMessage[] = [];

  // Build the main message
  if (toolCalls.length > 0) {
    const main: OpenAIMessage = { role: msg.role, tool_calls: toolCalls };
    if (contentParts.length > 0) {
      main.content = contentParts.length === 1 && contentParts[0].type === 'text'
        ? contentParts[0].text!
        : contentParts;
    } else {
      main.content = null;
    }
    messages.push(main);
  } else if (contentParts.length > 0) {
    if (contentParts.length === 1 && contentParts[0].type === 'text') {
      messages.push({ role: msg.role, content: contentParts[0].text! });
    } else {
      messages.push({ role: msg.role, content: contentParts });
    }
  }

  // Append tool results as separate messages
  messages.push(...toolResults);

  return messages;
}

function mapTools(tools: AnthropicTool[] | undefined): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      ...(t.description && { description: t.description }),
      parameters: t.input_schema,
    },
  }));
}

function mapToolChoice(
  choice: unknown,
): string | { type: 'function'; function: { name: string } } | undefined {
  if (!choice) return undefined;
  if (typeof choice === 'object' && choice !== null) {
    const obj = choice as Record<string, unknown>;
    if (obj.type === 'auto') return 'auto';
    if (obj.type === 'any') return 'required';
    if (obj.type === 'tool' && typeof obj.name === 'string') {
      return { type: 'function', function: { name: obj.name } };
    }
  }
  return undefined;
}

export function buildOpenAIRequest(anthropicBody: AnthropicRequest): Record<string, unknown> {
  const messages: OpenAIMessage[] = [
    ...mapSystemToMessages(anthropicBody.system),
    ...anthropicBody.messages.flatMap(mapAnthropicMessage),
  ];

  const req: Record<string, unknown> = {
    model: anthropicBody.model,
    messages,
    max_tokens: anthropicBody.max_tokens,
  };

  if (anthropicBody.temperature !== undefined) req.temperature = anthropicBody.temperature;
  if (anthropicBody.top_p !== undefined) req.top_p = anthropicBody.top_p;
  if (anthropicBody.stop_sequences) req.stop = anthropicBody.stop_sequences;
  if (anthropicBody.stream) req.stream = true;

  const tools = mapTools(anthropicBody.tools);
  if (tools) req.tools = tools;

  const toolChoice = mapToolChoice(anthropicBody.tool_choice);
  if (toolChoice) req.tool_choice = toolChoice;

  return req;
}

// ----- OpenAI → Anthropic (Non-streaming Response) -----

interface OpenAIChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: OpenAIChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

export function buildAnthropicResponse(openaiBody: OpenAIResponse): Record<string, unknown> {
  const choice = openaiBody.choices[0];
  const content: unknown[] = [];

  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: unknown;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  const resp: Record<string, unknown> = {
    id: openaiBody.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: openaiBody.model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
  };

  if (openaiBody.usage) {
    resp.usage = {
      input_tokens: openaiBody.usage.prompt_tokens,
      output_tokens: openaiBody.usage.completion_tokens,
    };
  }

  return resp;
}

// ----- Streaming: OpenAI SSE → Anthropic SSE -----

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createOpenAIStreamTransformer(): (chunk: Buffer) => Buffer {
  let buffer = '';
  let started = false;
  let contentBlockIndex = 0;
  let inContentBlock = false;
  // Track tool call state for multi-chunk tool_calls
  let activeToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
  let model = 'unknown';
  let messageId = `msg_${Date.now()}`;

  return (chunk: Buffer): Buffer => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    // Keep last incomplete line in the buffer
    buffer = lines.pop() ?? '';

    let output = '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith(':')) continue;

      if (!trimmed.startsWith('data: ')) continue;

      const dataStr = trimmed.slice(6);

      // Handle [DONE] sentinel
      if (dataStr === '[DONE]') {
        // Close any open content block
        if (inContentBlock) {
          output += sseEvent('content_block_stop', { type: 'content_block_stop', index: contentBlockIndex - 1 });
          inContentBlock = false;
        }
        // Flush any pending tool calls
        for (const [idx, tc] of activeToolCalls) {
          // Close the tool_use content block
          output += sseEvent('content_block_stop', { type: 'content_block_stop', index: idx });
        }
        activeToolCalls.clear();
        // Emit message_delta + message_stop
        output += sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 0 },
        });
        output += sseEvent('message_stop', { type: 'message_stop' });
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        continue;
      }

      if (parsed.model) model = parsed.model as string;
      if (parsed.id) messageId = `msg_${(parsed.id as string).replace('chatcmpl-', '')}`;

      const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
      if (!choices || choices.length === 0) continue;

      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown> | undefined;
      const finishReason = choice.finish_reason as string | null;

      if (!delta && !finishReason) continue;

      // Emit message_start on first chunk
      if (!started) {
        started = true;
        output += sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
      }

      // Handle text content deltas
      if (delta?.content) {
        if (!inContentBlock) {
          output += sseEvent('content_block_start', {
            type: 'content_block_start',
            index: contentBlockIndex,
            content_block: { type: 'text', text: '' },
          });
          inContentBlock = true;
        }
        output += sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'text_delta', text: delta.content as string },
        });
      }

      // Handle tool_calls deltas
      if (delta?.tool_calls) {
        // Close text content block if open
        if (inContentBlock) {
          output += sseEvent('content_block_stop', { type: 'content_block_stop', index: contentBlockIndex });
          contentBlockIndex++;
          inContentBlock = false;
        }

        const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
        for (const tc of toolCalls) {
          const tcIndex = tc.index as number;
          const fn = tc.function as Record<string, string> | undefined;

          if (!activeToolCalls.has(tcIndex)) {
            // New tool call — emit content_block_start
            const toolBlockIndex = contentBlockIndex + tcIndex;
            const toolId = (tc.id as string) || `toolu_${Date.now()}_${tcIndex}`;
            const toolName = fn?.name ?? '';
            activeToolCalls.set(tcIndex, { id: toolId, name: toolName, args: '' });

            output += sseEvent('content_block_start', {
              type: 'content_block_start',
              index: toolBlockIndex,
              content_block: { type: 'tool_use', id: toolId, name: toolName },
            });
          }

          // Accumulate arguments
          if (fn?.arguments) {
            const existing = activeToolCalls.get(tcIndex)!;
            existing.args += fn.arguments;
            const toolBlockIndex = contentBlockIndex + tcIndex;
            output += sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: toolBlockIndex,
              delta: { type: 'input_json_delta', partial_json: fn.arguments },
            });
          }
        }
      }

      // Handle finish_reason
      if (finishReason) {
        // Close text block if open
        if (inContentBlock) {
          output += sseEvent('content_block_stop', { type: 'content_block_stop', index: contentBlockIndex });
          inContentBlock = false;
        }
        // Close tool call blocks
        for (const [tcIndex] of activeToolCalls) {
          const toolBlockIndex = contentBlockIndex + tcIndex;
          output += sseEvent('content_block_stop', { type: 'content_block_stop', index: toolBlockIndex });
        }
        activeToolCalls.clear();

        const usage = (parsed.usage as Record<string, number>) || {};
        output += sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: mapFinishReason(finishReason) },
          usage: { output_tokens: usage.completion_tokens ?? 0 },
        });
        output += sseEvent('message_stop', { type: 'message_stop' });
      }
    }

    return Buffer.from(output);
  };
}

// ----- InferenceTransform implementation -----

class OpenAITransform implements InferenceTransform {
  name = 'openai';

  transformRequest(body: Buffer): { body: Buffer; path: string; contentType?: string } {
    const anthropicReq = JSON.parse(body.toString()) as AnthropicRequest;
    const openaiReq = buildOpenAIRequest(anthropicReq);
    return {
      body: Buffer.from(JSON.stringify(openaiReq)),
      path: '/v1/chat/completions',
      contentType: 'application/json',
    };
  }

  transformResponse(body: Buffer): Buffer {
    const openaiResp = JSON.parse(body.toString()) as OpenAIResponse;
    const anthropicResp = buildAnthropicResponse(openaiResp);
    return Buffer.from(JSON.stringify(anthropicResp));
  }

  createStreamTransformer(): (chunk: Buffer) => Buffer {
    return createOpenAIStreamTransformer();
  }
}

// Self-register
registerTransform('openai', () => new OpenAITransform());
