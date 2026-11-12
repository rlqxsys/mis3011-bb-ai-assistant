export const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Keys exist only in the process environment / memory, never in exported state.
export function createProvider({ env = process.env, fetcher = fetch } = {}) {
  let config = {
    endpoint: env.AI_ENDPOINT || DEFAULT_ENDPOINT, model: env.AI_MODEL || '',
    apiKey: env.AI_API_KEY || env.OPENROUTER_API_KEY || '',
    format: env.AI_FORMAT || 'json_schema', consent: false
  };
  function info() {
    return { endpoint: config.endpoint, model: config.model, format: config.format,
      configured: Boolean(config.apiKey && config.model), consent: config.consent, keyStored: Boolean(config.apiKey) };
  }
  function configure(input) {
    const next = { ...config, ...input };
    const url = new URL(next.endpoint);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入不含凭据的模型接口 URL。');
    if (!['json_schema', 'json_object', 'text'].includes(next.format)) throw new Error('未知响应格式。');
    next.consent = input.consent === true;
    if (input.apiKey === '' && url.origin !== new URL(config.endpoint).origin && config.apiKey) throw new Error('切换模型服务时请填写该服务的 key，不会复用原服务凭据。');
    if (input.apiKey === '') next.apiKey = config.apiKey;
    if (input.apiKey === null) next.apiKey = '';
    config = next;
    return info();
  }
  async function complete(messages, schema, name) {
    if (!config.apiKey || !config.model) throw new Error('请先在 AI 课程助理中配置接口、模型和 API key。');
    if (!config.consent) throw new Error('请先确认允许将选中的脱敏文本发送给所配置的模型服务。');
    const payload = { model: config.model, messages, temperature: 0.1, max_tokens: 6500 };
    // Course extraction uses non-thinking mode; no hidden reasoning token budget.
    if (new URL(config.endpoint).hostname === 'api.deepseek.com') payload.thinking = { type: 'disabled' };
    if (config.format === 'json_schema') payload.response_format = { type: 'json_schema', json_schema: { name, strict: true, schema } };
    if (config.format === 'json_object') payload.response_format = { type: 'json_object' };
    const started = Date.now();
    try {
      const response = await fetcher(config.endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000), redirect: 'error'
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.error) throw new Error(`模型服务返回 ${response.status}：${String(data?.error?.message || '请检查模型、额度、响应格式和凭据').slice(0, 350)}`);
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('模型输出被长度上限截断，请减少本次材料，不会应用不完整结果。');
      if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error(`模型未正常完成（${choice.finish_reason}），未应用结果。`);
      let content = choice?.message?.content;
      if (Array.isArray(content)) content = content.map(c => c.text || '').join('');
      if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回可读取的 JSON 内容。');
      const value = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      return { value, meta: { transport: 'live_http', model: data.model || config.model,
        responseId: data.id || null, elapsedMs: Date.now() - started,
        usage: data.usage || null, endpointHost: new URL(config.endpoint).hostname } };
    } catch (error) {
      const message = error.name === 'TimeoutError' ? '模型调用超时，请减少材料后重试。' : error.message;
      throw new Error(String(message).split(config.apiKey).join('[redacted]'));
    }
  }
  return { info, configure, complete };
}
