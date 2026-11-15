import { GoogleGenerativeAI } from '@google/generative-ai';
import chalk from 'chalk';
import readline from 'readline';
import { getConfig } from './config.js';

function getMultilineInput() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    const lines = [];
    rl.on('line', (line) => {
      if (line.trim().toUpperCase() === 'DONE') {
        rl.close();
        resolve(lines.join('\n').trim());
      } else {
        lines.push(line);
      }
    });
  });
}

export function hasGeminiKey(apiKey) {
  return Boolean(apiKey && apiKey.toLowerCase() !== 'antigravity' && apiKey.toLowerCase() !== 'bridge');
}

/**
 * Generates LLM completions via Gemini API or Antigravity Agent Bridge (interactive paste fallback).
 */
export async function generateText({
  systemPrompt,
  userPrompt,
  modelName = 'gemini-2.5-flash',
  jsonMode = false,
  allowInteractiveBridge = true
}) {
  const config = getConfig();
  const apiKey = config.geminiApiKey;

  if (!hasGeminiKey(apiKey)) {
    if (!allowInteractiveBridge) {
      return null;
    }
    console.log(chalk.bold.yellow('\n==================== ANTIGRAVITY AGENT BRIDGE ===================='));
    console.log(chalk.cyan(`Mode: Interactive Antigravity Bridge (JSON Mode: ${jsonMode ? 'ON' : 'OFF'})`));
    console.log(chalk.green('\n--- SYSTEM PROMPT ---'));
    console.log(systemPrompt);
    console.log(chalk.green('\n--- USER PROMPT ---'));
    console.log(userPrompt);
    console.log(chalk.bold.yellow('=================================================================='));
    console.log(chalk.yellow('Send the prompt above to your Antigravity AI Assistant, paste its reply below,'));
    console.log(chalk.yellow('then type "DONE" on a new line and press Enter (or press Ctrl+C to cancel).'));

    const text = await getMultilineInput();
    if (!text) {
      throw new Error('Antigravity Bridge received an empty response.');
    }
    return text;
  }

  const resolvedModel = modelName === 'antigravity' ? 'gemini-2.5-flash' : modelName;
  const genAI = new GoogleGenerativeAI(apiKey);
  const generationConfig = jsonMode ? { responseMimeType: 'application/json' } : {};

  const model = genAI.getGenerativeModel({
    model: resolvedModel,
    systemInstruction: systemPrompt,
    generationConfig
  });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }]
  });

  const responseText = result.response.text();
  if (!responseText) {
    throw new Error('Gemini API returned an empty response.');
  }
  return responseText;
}
