// Explicit test doubles. These are never imported by the production application.
export const assignmentText = 'Assignment Omega: Submit one PDF by November 14, 2026 at 3 PM. Late submission is NOT allowed.';
export function item(patch = {}) {
  return {
    operation: 'new', targetTaskId: null, title: 'Assignment Omega', kind: 'assignment', channel: 'bb',
    deadlineAt: '2026-11-14T15:00:00+08:00', deadlineDate: '2026-11-14', opensAt: null, closesAt: null,
    fixedStart: null, fixedEnd: null, location: null, sectionOptions: [], sections: [], condition: null,
    requirements: ['提交一个 PDF'], removeRequirements: [], clearFields: [], latePolicy: 'not_allowed',
    attempts: 'unknown', scoring: 'unknown', durationMinutes: null, estimatedMinutes: 120,
    estimateReason: '测试用时建议，不是课程事实。', splittable: true, optional: false,
    evidence: [{ documentId: 'source-omega', quote: assignmentText, fields: ['deadlineAt', 'deadlineDate', 'requirements', 'policy'] }],
    uncertainties: [], reason: '原文要求交件，并明确给出截止时刻。', ...patch
  };
}
export function operation(patch = {}) {
  return { type: 'add_busy', taskId: null, start: '2026-11-12T19:00:00+08:00', end: '2026-11-12T21:00:00+08:00', minutes: null,
    day: null, startClock: null, endClock: null, title: '小组会', reason: '用户明确说今晚这段时间有会。', ...patch };
}
export function fakeProvider(values) {
  const queue = [...values], calls = [];
  let config = { configured: true, consent: true, keyStored: true, model: 'TEST-DOUBLE', endpoint: 'http://test.invalid', format: 'json_schema' };
  return {
    calls, info: () => config, configure: input => (config = { ...config, ...input, apiKey: undefined }),
    async complete(messages) {
      calls.push(messages);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('Test double queue exhausted');
      return { value: typeof next === 'function' ? next(messages) : next, meta: { transport: 'test_double', model: 'TEST-DOUBLE', responseId: `test-${calls.length}`, elapsedMs: 1, usage: { total_tokens: 1 }, endpointHost: 'test.invalid' } };
    }
  };
}
