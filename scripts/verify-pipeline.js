#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

function isoDate() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return [year, month, day].join('-');
}

function buildHarmonySystemMessage(hasTools) {
  const lines = [
    'You are ChatGPT, a large language model trained by OpenAI.',
    'Knowledge cutoff: 2024-06',
    'Current date: ' + isoDate(),
    '',
    'Reasoning: high',
    '',
    '# Valid channels: analysis, commentary, final. Channel must be included for every message.',
  ];
  if (hasTools) {
    lines.push("Calls to these tools must go to the commentary channel: 'functions'.");
  }
  return { role: 'system', content: lines.join('\n') };
}

function normalizePrompt(input) {
  return input.replace(/\r\n/g, '\n').trim().replace(/^System:\s*/i, '').trim();
}

function joinSections(sections) {
  return sections.filter((section) => section.trim().length > 0).join('\n\n');
}

function readPrompt(relative) {
  const fullPath = path.join(__dirname, '..', 'uicp', 'src', 'prompts', relative);
  return fs.readFileSync(fullPath, 'utf8');
}

function readApiKey() {
  const envPath = path.join(__dirname, '..', 'uicp', '.env');
  const envText = fs.readFileSync(envPath, 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    if (line.startsWith('OLLAMA_API_KEY=')) {
      return line.slice('OLLAMA_API_KEY='.length).trim();
    }
  }
  throw new Error('OLLAMA_API_KEY not found in uicp/.env');
}

function makeStreamRequest(options) {
  return new Promise((resolve, reject) => {
    let completed = false;
    const req = https.request({
      method: 'POST',
      hostname: 'ollama.com',
      path: '/api/chat',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + options.key,
        'Content-Length': Buffer.byteLength(options.payload, 'utf8'),
      },
    }, (res) => {
      if (!res.statusCode || res.statusCode >= 300) {
        res.setEncoding('utf8');
        const errorChunks = [];
        res.on('data', (chunk) => errorChunks.push(chunk));
        res.on('end', () => {
          reject(new Error('HTTP ' + res.statusCode + ': ' + errorChunks.join('')));
        });
        return;
      }

      res.setEncoding('utf8');
      let buffer = '';
      const rawEvents = [];
      let content = '';
      let thinking = '';

      const flushLine = (line) => {
        if (completed) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        rawEvents.push(trimmed);
        let payload;
        try {
          payload = JSON.parse(trimmed);
        } catch (err) {
          rawEvents.push('/* parse error */');
          return;
        }
        const message = payload.message ?? payload.delta ?? payload;
        if (message) {
          if (typeof message.content === 'string') content += message.content;
          if (typeof message.thinking === 'string') thinking += message.thinking;
        }
        if (payload.done) {
          completed = true;
          resolve({ content, thinking, raw: rawEvents });
        }
      };

      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          flushLine(line);
        }
      });

      res.on('end', () => {
        if (buffer.length) {
          flushLine(buffer);
        }
        if (!completed) {
          reject(new Error('Stream ended without completion. Raw events: ' + rawEvents.length));
        }
      });
    });
    req.on('error', reject);
    req.write(options.payload);
    req.end();
  });
}

function buildPlannerMessages(intent, plannerPrompt) {
  const harmonyRequirements = [
    '# Harmony Output Requirements',
    '- Use the analysis channel for private chain-of-thought reasoning. Do not expose analysis content to the user.',
    '- Emit function calls on the commentary channel, terminate the request with <|call|>, and wait for tool output before continuing.',
    '- Return the final JSON on the final channel and end the message with <|return|>.',
    '- Do not wrap JSON in Markdown code fences or add prose outside the JSON object.',
  ].join('\n');

  const responseFormat = [
    '# Structured Output Format',
    '- Respond with a single JSON object and nothing else.',
    '- JSON Schema:',
    '{"type":"object","required":["summary","batch"],"properties":{"summary":{"type":"string","minLength":1},"risks":{"type":"array","items":{"type":"string"}},"batch":{"type":"array","items":{"type":"object"}}}}',
    '- Keep HTML compact (single line) and safe (no <script>, <style>, on* handlers, or javascript: URLs).',
  ].join('\n');

  const developerSections = [
    '# Instructions\n' + normalizePrompt(plannerPrompt),
    harmonyRequirements,
    responseFormat,
    '# Failure Handling\n- Ask clarifying questions if essential details are missing.\n- If a safe implementation is impossible, explain why and return an empty batch.',
  ];

  return [
    buildHarmonySystemMessage(false),
    { role: 'developer', content: joinSections(developerSections) },
    { role: 'user', content: intent },
  ];
}

function buildActorMessages(planJson, actorPrompt) {
  const harmonyRequirements = [
    '# Harmony Output Requirements',
    '- Use the analysis channel for reasoning about the plan and evaluating tool output.',
    '- Perform tool invocations on the commentary channel with <|call|> and resume once the tool replies.',
    '- Emit the final batch JSON on the final channel ending with <|return|> and no surrounding prose.',
    '- Never return Markdown fences or extra narration.',
  ].join('\n');

  const responseFormat = [
    '# Structured Output Format',
    '- Respond with JSON. Preferred form: {"batch":[Command...]}.',
    '- Commands must comply with the UICP operation schema (window.*, dom.*, component.*, state.*, api.call, txn.cancel).',
    '- Ensure accessibility hints and stable window IDs follow the plan guidance.',
  ].join('\n');

  const developerSections = [
    '# Instructions\n' + normalizePrompt(actorPrompt),
    harmonyRequirements,
    responseFormat,
    '# Safety\n- Abort with an error window if the plan cannot be completed safely.',
  ];

  return [
    buildHarmonySystemMessage(false),
    { role: 'developer', content: joinSections(developerSections) },
    { role: 'user', content: planJson },
  ];
}

async function main() {
  const intent = process.argv.slice(2).join(' ') || 'build a calculator';
  const apiKey = readApiKey();
  const plannerPrompt = readPrompt('planner.txt');
  const actorPrompt = readPrompt('actor.txt');

  console.log('Intent:', intent);

  const plannerMessages = buildPlannerMessages(intent, plannerPrompt);
  const plannerPayload = JSON.stringify({ model: 'gpt-oss:120b', messages: plannerMessages, stream: true });

  console.log('\nRequesting plan from Ollama Cloud...');
  const planResult = await makeStreamRequest({ payload: plannerPayload, key: apiKey });
  const planText = planResult.content.trim();
  if (!planText) {
    throw new Error('Planner returned empty content. Raw events: ' + planResult.raw.length);
  }
  let plan;
  try {
    plan = JSON.parse(planText);
  } catch (err) {
    console.error('Failed to parse planner content:', planText);
    throw err;
  }
  console.log('Planner summary:', plan.summary || '(none)');
  console.log('Plan batch length:', Array.isArray(plan.batch) ? plan.batch.length : 0);

  const planJson = JSON.stringify({ summary: plan.summary, risks: plan.risks, batch: plan.batch });
  const actorMessages = buildActorMessages(planJson, actorPrompt);
  const actorPayload = JSON.stringify({ model: 'gpt-oss:120b', messages: actorMessages, stream: true });

  console.log('\nRequesting batch from Ollama Cloud...');
  const actorResult = await makeStreamRequest({ payload: actorPayload, key: apiKey });
  const batchText = actorResult.content.trim();
  if (!batchText) {
    throw new Error('Actor returned empty content. Raw events: ' + actorResult.raw.length);
  }
  let batchEnvelope;
  try {
    batchEnvelope = JSON.parse(batchText);
  } catch (err) {
    console.error('Failed to parse actor content:', batchText);
    throw err;
  }
  const batch = Array.isArray(batchEnvelope.batch) ? batchEnvelope.batch : batchEnvelope;

  console.log('Batch operation count:', Array.isArray(batch) ? batch.length : 0);
  if (Array.isArray(batch) && batch.length) {
    console.log('First operation:', JSON.stringify(batch[0], null, 2));
  }

  console.log('\nPipeline verified successfully.');
}

main().catch((err) => {
  console.error('Pipeline verification failed:', err);
  process.exit(1);
});
