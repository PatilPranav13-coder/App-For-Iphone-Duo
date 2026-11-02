export async function askAnthropic({ apiKey, model, question, context, history, signal }) {
  const messages = history.concat([{ role: 'user', content: question }]).map(function (message) {
    return { role: message.role, content: message.content };
  });
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      system: systemInstructions(context),
      messages,
      max_tokens: 900
    }),
    signal
  });
  const payload = await response.json().catch(function () { return {}; });
  if (!response.ok) throw providerError(response.status, payload?.error?.message, 'Anthropic');
  const text = (payload.content || []).filter(function (part) { return part.type === 'text'; }).map(function (part) { return part.text; }).join('\n');
  if (!text) throw new Error('Anthropic returned an empty response.');
  return {
    text,
    provider: 'anthropic',
    model,
    usage: {
      inputTokens: payload.usage?.input_tokens ?? null,
      outputTokens: payload.usage?.output_tokens ?? null
    }
  };
}

function systemInstructions(context) {
  return [
    'You are Tessera, a careful data-analysis assistant.',
    'Use only the supplied computed profile, findings, selected chart point, and explicitly included sample rows.',
    'Never invent or estimate dataset values, counts, statistical results, or causal explanations.',
    'If the available evidence cannot answer the question, say what calculation or comparison is needed next.',
    'When citing a result, name its calculation or source field when available.',
    'Clearly distinguish correlation from causation. Keep the answer concise and practical.',
    'Current analysis context (computed by Tessera):',
    JSON.stringify(context)
  ].join('\n\n');
}

function providerError(status, detail, name) {
  const error = new Error(detail || name + ' request failed with status ' + status + '.');
  error.status = status === 401 || status === 403 ? 502 : 503;
  return error;
}
