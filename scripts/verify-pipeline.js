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

function makeRequest(options) {
  return new Promise((resolve, reject) => {
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
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (!res.statusCode || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode + ': ' + body));
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(options.payload);
    req.end();
  });
}

function extractContent(response) {
  const candidates = [];
  if (response.message && response.message.content) candidates.push(response.message.content);
  if (Array.isArray(response.messages)) {
    for (const m of response.messages) {
      if (m && m.content) candidates.push(m.content);
    }
  }
  if (response.response && response.response.message && response.response.message.content) {
    candidates.push(response.response.message.content);
  }
  if (!candidates.length) {
    throw new Error('No content found in response payload');
  }
  return candidates[candidates.length - 1];
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
  const plannerPayload = JSON.stringify({ model: 'gpt-oss:120b', messages: plannerMessages, stream: false });

  console.log('\nRequesting plan from Ollama Cloud...');
  const planResponse = await makeRequest({ payload: plannerPayload, key: apiKey });
  const planText = extractContent(planResponse);
  const plan = JSON.parse(planText);
  console.log('Planner summary:', plan.summary || '(none)');
  console.log('Plan batch length:', Array.isArray(plan.batch) ? plan.batch.length : 0);

  const planJson = JSON.stringify({ summary: plan.summary, risks: plan.risks, batch: plan.batch });
  const actorMessages = buildActorMessages(planJson, actorPrompt);
  const actorPayload = JSON.stringify({ model: 'gpt-oss:120b', messages: actorMessages, stream: false });

  console.log('\nRequesting batch from Ollama Cloud...');
  const actorResponse = await makeRequest({ payload: actorPayload, key: apiKey });
  const batchText = extractContent(actorResponse);
  const batchEnvelope = JSON.parse(batchText);
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
