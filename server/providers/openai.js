export async function askOpenAI({ apiKey, model, question, context, history, signal }) {
  const messages = history.concat([{ role: 'user', content: question }]).map(function (message) {
    return { role: message.role, content: message.content };
  });
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions: systemInstructions(context),
      input: messages,
      max_output_tokens: 900,
      store: false
    }),
    signal
  });
  const payload = await response.json().catch(function () { return {}; });
  if (!response.ok) throw providerError(response.status, payload?.error?.message, 'OpenAI');
  const text = payload.output_text || (payload.output || []).flatMap(function (item) {
    return (item.content || []).filter(function (part) { return part.type === 'output_text'; }).map(function (part) { return part.text; });
  }).join('\n');
  if (!text) throw new Error('OpenAI returned an empty response.');
  return {
    text,
    provider: 'openai',
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
