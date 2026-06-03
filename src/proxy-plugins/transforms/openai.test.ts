/**
 * OpenAI transform — unit tests.
 *
 * Covers: request mapping, non-streaming response mapping, streaming SSE,
 * and registry lookup.
 *
 * Run:  npm test -- src/proxy-plugins/transforms/openai
 */
import { describe, it, expect } from 'vitest';

import { getTransform } from './registry.js';
import {
  buildOpenAIRequest,
  buildAnthropicResponse,
  createOpenAIStreamTransformer,
} from './openai.js';

// Trigger self-registration
import './openai.js';

// ---- Registry ----

describe('transform registry', () => {
  it('getTransform("openai") returns an instance', () => {
    const t = getTransform('openai');
    expect(t).toBeDefined();
    expect(t!.name).toBe('openai');
  });

  it('getTransform("unknown") returns undefined', () => {
    expect(getTransform('unknown')).toBeUndefined();
  });

  it('transform.transformRequest returns path /v1/chat/completions', () => {
    const t = getTransform('openai')!;
    const body = Buffer.from(
      JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      }),
    );
    const result = t.transformRequest(body);
    expect(result.path).toBe('/v1/chat/completions');
    expect(result.contentType).toBe('application/json');
  });
});

// ---- Request Mapping ----

describe('buildOpenAIRequest', () => {
  it('maps basic message with system prompt', () => {
    const result = buildOpenAIRequest({
      model: 'deepseek-v3',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    expect(result.model).toBe('deepseek-v3');
    expect(result.max_tokens).toBe(1024);
    expect(result.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('maps system content blocks to a single system message', () => {
    const result = buildOpenAIRequest({
      model: 'test',
      system: [
        { type: 'text', text: 'First.' },
        { type: 'text', text: 'Second.' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    });

    const msgs = result.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'First.\n\nSecond.' });
  });

  it('maps multi-turn conversation', () => {
    const result = buildOpenAIRequest({
      model: 'test',
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'Thanks' },
      ],
      max_tokens: 50,
    });

    const msgs = result.messages as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[2].role).toBe('user');
  });

  it('maps tool definitions', () => {
    const result = buildOpenAIRequest({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    });

    expect(result.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ]);
  });

  it('maps tool_use and tool_result blocks', () => {
    const result = buildOpenAIRequest({
      model: 'test',
      messages: [
        { role: 'user', content: 'What is the weather in London?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_123',
              name: 'get_weather',
              input: { city: 'London' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_123',
              content: 'Sunny, 22°C',
            },
          ],
        },
      ],
      max_tokens: 100,
    });

    const msgs = result.messages as Array<Record<string, unknown>>;
    // Assistant message with tool_calls
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].tool_calls).toEqual([
      {
        id: 'toolu_123',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"London"}' },
      },
    ]);
    // Tool result message
    expect(msgs[2].role).toBe('tool');
    expect(msgs[2].tool_call_id).toBe('toolu_123');
    expect(msgs[2].content).toBe('Sunny, 22°C');
  });

  it('maps tool_choice types', () => {
    const autoResult = buildOpenAIRequest({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      tool_choice: { type: 'auto' },
    });
    expect(autoResult.tool_choice).toBe('auto');

    const anyResult = buildOpenAIRequest({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      tool_choice: { type: 'any' },
    });
    expect(anyResult.tool_choice).toBe('required');

    const specificResult = buildOpenAIRequest({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      tool_choice: { type: 'tool', name: 'get_weather' },
    });
    expect(specificResult.tool_choice).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  it('passes through temperature, top_p, stop_sequences, stream', () => {
    const result = buildOpenAIRequest({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ['END'],
      stream: true,
    });

    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
    expect(result.stop).toEqual(['END']);
    expect(result.stream).toBe(true);
  });

  it('maps image content blocks', () => {
    const result = buildOpenAIRequest({
      model: 'test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgo=',
              },
            },
          ],
        },
      ],
      max_tokens: 100,
    });

    const msgs = result.messages as Array<{ content: unknown }>;
    expect(msgs[0].content).toEqual([
      { type: 'text', text: 'Describe this' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
      },
    ]);
  });
});

// ---- Response Mapping ----

describe('buildAnthropicResponse', () => {
  it('maps a text response', () => {
    const result = buildAnthropicResponse({
      id: 'chatcmpl-abc123',
      model: 'deepseek-v3',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Hello!',
            tool_calls: undefined,
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    expect(result.type).toBe('message');
    expect(result.role).toBe('assistant');
    expect(result.model).toBe('deepseek-v3');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('maps tool_calls response', () => {
    const result = buildAnthropicResponse({
      id: 'chatcmpl-xyz',
      model: 'test',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"London"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    expect(result.stop_reason).toBe('tool_use');
    expect(result.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_abc',
        name: 'get_weather',
        input: { city: 'London' },
      },
    ]);
  });

  it('maps finish_reason variants', () => {
    const test = (reason: string, expected: string) => {
      const r = buildAnthropicResponse({
        id: 'x',
        model: 'm',
        choices: [
          {
            message: { role: 'assistant', content: 'x' },
            finish_reason: reason,
          },
        ],
      });
      expect(r.stop_reason).toBe(expected);
    };

    test('stop', 'end_turn');
    test('length', 'max_tokens');
    test('tool_calls', 'tool_use');
    test('content_filter', 'end_turn');
  });

  it('includes text + tool_calls together', () => {
    const result = buildAnthropicResponse({
      id: 'chatcmpl-both',
      model: 'test',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Let me check the weather.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    expect(result.content).toEqual([
      { type: 'text', text: 'Let me check the weather.' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'get_weather',
        input: { city: 'NYC' },
      },
    ]);
  });
});

// ---- Streaming ----

describe('createOpenAIStreamTransformer', () => {
  function feedChunks(chunks: string[]): string {
    const transformer = createOpenAIStreamTransformer();
    let output = '';
    for (const chunk of chunks) {
      output += transformer(Buffer.from(chunk)).toString();
    }
    return output;
  }

  function parseSSEEvents(
    raw: string,
  ): Array<{ event: string; data: unknown }> {
    const events: Array<{ event: string; data: unknown }> = [];
    const blocks = raw.split('\n\n').filter(Boolean);
    for (const block of blocks) {
      const lines = block.split('\n');
      let event = '';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7);
        if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (event && data) {
        events.push({ event, data: JSON.parse(data) });
      }
    }
    return events;
  }

  it('transforms text streaming chunks', () => {
    const chunks = [
      'data: {"id":"chatcmpl-1","model":"test","choices":[{"delta":{"content":"Hello"},"index":0,"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"test","choices":[{"delta":{"content":" world"},"index":0,"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"test","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const output = feedChunks(chunks);
    const events = parseSSEEvents(output);

    // message_start
    expect(events[0].event).toBe('message_start');
    // content_block_start
    expect(events[1].event).toBe('content_block_start');
    expect((events[1].data as Record<string, unknown>).content_block).toEqual({
      type: 'text',
      text: '',
    });
    // text deltas
    expect(events[2].event).toBe('content_block_delta');
    expect((events[2].data as Record<string, unknown>).delta).toEqual({
      type: 'text_delta',
      text: 'Hello',
    });
    expect(events[3].event).toBe('content_block_delta');
    expect((events[3].data as Record<string, unknown>).delta).toEqual({
      type: 'text_delta',
      text: ' world',
    });
    // content_block_stop
    expect(events[4].event).toBe('content_block_stop');
    // message_delta with stop_reason
    expect(events[5].event).toBe('message_delta');
    expect((events[5].data as Record<string, unknown>).delta).toEqual({
      stop_reason: 'end_turn',
    });
    // message_stop
    expect(events[6].event).toBe('message_stop');
  });

  it('handles chunks split across buffer boundaries', () => {
    // The SSE line is split across two chunks
    const part1 =
      'data: {"id":"chatcmpl-1","model":"test","choices":[{"delta":{"con';
    const part2 =
      'tent":"Hi"},"index":0,"finish_reason":null}]}\n\ndata: [DONE]\n\n';

    const output = feedChunks([part1, part2]);
    const events = parseSSEEvents(output);

    expect(events[0].event).toBe('message_start');
    expect(events[1].event).toBe('content_block_start');
    expect(events[2].event).toBe('content_block_delta');
    expect((events[2].data as Record<string, unknown>).delta).toEqual({
      type: 'text_delta',
      text: 'Hi',
    });
  });

  it('transforms tool_calls streaming', () => {
    const chunks = [
      'data: {"id":"chatcmpl-tc","model":"test","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"index":0,"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-tc","model":"test","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]},"index":0,"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-tc","model":"test","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"London\\"}"}}]},"index":0,"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-tc","model":"test","choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const output = feedChunks(chunks);
    const events = parseSSEEvents(output);

    // message_start
    expect(events[0].event).toBe('message_start');
    // content_block_start for tool_use
    expect(events[1].event).toBe('content_block_start');
    const toolBlock = (events[1].data as Record<string, unknown>)
      .content_block as Record<string, unknown>;
    expect(toolBlock.type).toBe('tool_use');
    expect(toolBlock.name).toBe('get_weather');
    expect(toolBlock.id).toBe('call_1');
    // input_json_delta chunks
    expect(events[2].event).toBe('content_block_delta');
    expect((events[2].data as Record<string, unknown>).delta).toEqual({
      type: 'input_json_delta',
      partial_json: '{"city"',
    });
    expect(events[3].event).toBe('content_block_delta');
    expect((events[3].data as Record<string, unknown>).delta).toEqual({
      type: 'input_json_delta',
      partial_json: ':"London"}',
    });
    // content_block_stop for tool
    expect(events[4].event).toBe('content_block_stop');
    // message_delta
    expect(events[5].event).toBe('message_delta');
    expect((events[5].data as Record<string, unknown>).delta).toEqual({
      stop_reason: 'tool_use',
    });
    // message_stop
    expect(events[6].event).toBe('message_stop');
  });

  it('handles [DONE] sentinel without finish_reason (graceful)', () => {
    const chunks = [
      'data: {"id":"chatcmpl-1","model":"test","choices":[{"delta":{"content":"OK"},"index":0,"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const output = feedChunks(chunks);
    const events = parseSSEEvents(output);

    // Should still close properly
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain('message_start');
    expect(eventTypes).toContain('content_block_start');
    expect(eventTypes).toContain('content_block_delta');
    expect(eventTypes).toContain('content_block_stop');
    expect(eventTypes).toContain('message_delta');
    expect(eventTypes).toContain('message_stop');
  });
});

// ---- Round-trip sanity ----

describe('round-trip transform', () => {
  it('request → mock response → well-formed Anthropic output', () => {
    const t = getTransform('openai')!;

    // Transform request
    const anthropicReqBody = Buffer.from(
      JSON.stringify({
        model: 'deepseek-v3',
        system: 'Be concise.',
        messages: [{ role: 'user', content: 'Say hi' }],
        max_tokens: 50,
      }),
    );
    const { body: openaiReqBuf, path } = t.transformRequest(anthropicReqBody);
    const openaiReq = JSON.parse(openaiReqBuf.toString());

    expect(path).toBe('/v1/chat/completions');
    expect(openaiReq.model).toBe('deepseek-v3');
    expect(openaiReq.messages[0]).toEqual({
      role: 'system',
      content: 'Be concise.',
    });

    // Mock OpenAI response
    const mockOpenAIResp = Buffer.from(
      JSON.stringify({
        id: 'chatcmpl-roundtrip',
        model: 'deepseek-v3',
        choices: [
          {
            message: { role: 'assistant', content: 'Hi!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      }),
    );

    // Transform response
    const anthropicResp = JSON.parse(
      t.transformResponse(mockOpenAIResp).toString(),
    );

    expect(anthropicResp.type).toBe('message');
    expect(anthropicResp.role).toBe('assistant');
    expect(anthropicResp.content).toEqual([{ type: 'text', text: 'Hi!' }]);
    expect(anthropicResp.stop_reason).toBe('end_turn');
    expect(anthropicResp.usage).toEqual({ input_tokens: 8, output_tokens: 2 });
    expect(anthropicResp.model).toBe('deepseek-v3');
  });
});
