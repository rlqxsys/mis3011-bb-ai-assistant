import { randomUUID } from 'node:crypto';
import { analysisSchema, commandSchema, pingSchema } from './contracts.mjs';
import { analysisMessages, commandMessages } from './prompts.mjs';
import { compileAnalysis, applyAnalysis } from './analysis.mjs';
import { compileCommand, applyCommand } from './commands.mjs';

export function createAIService(provider) {
  const previews = new Map();
  async function ping() {
    const response = await provider.complete([{ role: 'system', content: 'Return JSON with ok=true and message="连接成功".' }, { role: 'user', content: 'Check structured JSON connection only. No course data.' }], pingSchema, 'connection_test');
    if (response.value?.ok !== true) throw new Error('服务可访问，但返回格式未通过连接测试。');
    return { connected: true, ...response.meta };
  }
  async function analyze(documents, state, { force = false } = {}) {
    if (!documents.length) throw new Error('请先选择或导入课程正文。');
    if (documents.reduce((n, d) => n + d.text.length, 0) > 60_000) throw new Error('本次文本超过 60,000 字符，请按作业或公告分批选择；没有截断或发送材料。');
    if (!force && documents.every(d => state.aiSources?.[d.id]?.version === d.version)) return { state, skipped: true, message: '这些资料的相同版本已处理，未重复调用模型或创建任务。' };
    if (!force) documents = documents.filter(d => state.aiSources?.[d.id]?.version !== d.version);
    const id = `ai:${randomUUID()}`;
    const response = await provider.complete(analysisMessages(documents, state, analysisSchema), analysisSchema, 'course_analysis');
    const compiled = compileAnalysis(response.value, documents, state, id);
    const run = { id, type: 'document_analysis', at: state.now, documents, rawOutput: response.value, ...response.meta };
    return { state: applyAnalysis(state, compiled, run), runId: id, decisions: compiled.decisions, questions: compiled.questions };
  }
  async function command(instruction, state, { apply = false } = {}) {
    if (typeof instruction !== 'string' || !instruction.trim()) throw new Error('请输入你希望调整或试算的内容。');
    const id = `ai:${randomUUID()}`;
    const response = await provider.complete(commandMessages(instruction, state, commandSchema), commandSchema, 'planning_intent');
    const compiled = compileCommand(response.value, state, id);
    const run = { id, type: 'planning_intent', at: state.now, instruction, rawOutput: response.value, ...response.meta };
    const execute = apply === true || (apply === 'auto' && response.value.intent === 'apply');
    if (execute && !compiled.questions.length) return { state: applyCommand(state, compiled, run), runId: id, preview: compiled, applied: true };
    previews.set(id, { compiled, run });
    if (previews.size > 30) previews.delete(previews.keys().next().value);
    return { runId: id, preview: compiled, applied: false, meta: response.meta };
  }
  function applyPreview(id, state) {
    const entry = previews.get(id);
    if (!entry) throw new Error('该预览不存在或服务已重启，请重新试算。');
    const next = applyCommand(state, entry.compiled, entry.run);
    previews.delete(id);
    return next;
  }
  return { ping, analyze, command, applyPreview };
}
