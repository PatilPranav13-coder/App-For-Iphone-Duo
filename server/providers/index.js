import { askOpenAI } from './openai.js';
import { askAnthropic } from './anthropic.js';

export function configuredProviders() {
  return {
    openai: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL)
  };
}

export async function answerWithProvider({ requestedProvider, question, context, history, signal }) {
  const available = configuredProviders();
  const selected = requestedProvider === 'auto'
    ? (available.openai ? 'openai' : available.anthropic ? 'anthropic' : null)
    : requestedProvider;
  if (!selected || !available[selected]) {
    const error = new Error('The selected AI provider is not configured. Add its API key and model ID in the server .env file.');
    error.status = 503;
    throw error;
  }
  if (selected === 'openai') {
    try {
      return await askOpenAI({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, question, context, history, signal });
    } catch (error) {
      if (requestedProvider !== 'auto' || !available.anthropic) throw error;
      return askAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL, question, context, history, signal });
    }
  }
  if (selected === 'anthropic') {
    return askAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL, question, context, history, signal });
  }
  const error = new Error('Unknown AI provider.');
  error.status = 400;
  throw error;
}
