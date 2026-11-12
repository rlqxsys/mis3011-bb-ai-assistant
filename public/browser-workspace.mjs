import { applyEvent, createState, reconcile, summarize, validateProfile } from '../core/engine.mjs';
import { loadScenario, scenarioEvents, scenarios } from '../demo/scenarios.mjs';
import { createTask } from '../core/model.mjs';
import { ms, validTime } from '../core/time.mjs';

// The public view reuses the exact core engine; AI results come from a captured run.
export function createPublicWorkspace({ feed, evidence, storage = null }) {
  const storageKey = 'bb-companion:public:v1';
  const initial = () => {
    const state = createState({ now: evidence.now, mode: 'replay', tasks: evidence.tasks });
    state.aiRuns = structuredClone(evidence.modelRuns);
    state.workspace = 'public';
    state.planningEnabled = true;
    return reconcile(state);
  };
  let state = initial();
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) || 'null');
    if (saved?.schemaVersion === 1 && saved.workspace === 'public') {
      validateProfile(saved.profile);
      if (validTime(saved.now) && Array.isArray(saved.tasks)) state = saved;
    }
  } catch { /* Start with the published run when browser storage is unavailable. */ }
  const view = () => structuredClone({ ...state, summary: summarize(state), scenarios });
  const commit = next => {
    state = next;
    state.workspace = 'public';
    try { storage?.setItem(storageKey, JSON.stringify(state)); } catch { /* The current tab still works. */ }
    return view();
  };
  async function request(path, body) {
    if (body === undefined) {
      if (path === '/api/state' || path === '/api/export') return view();
      if (path === '/api/catalog') return { stats: feed.stats };
      throw new Error('此入口由仓库中的 Node 服务提供。');
    }
    if (path === '/public/restore') return commit(initial());
    if (path === '/api/events') {
      let next = state;
      for (const event of body.events || [body]) next = applyEvent(next, event);
      return commit(next);
    }
    if (path === '/api/import') return commit(loadScenario(feed, body.scenario || 'submission', evidence.now));
    if (path === '/api/demo/event') {
      if (!state.scenario) throw new Error('先选择一组经典演示。');
      let next = state;
      for (const event of scenarioEvents(feed, state)) {
        if (event.type !== 'CLOCK_ADVANCED' || ms(event.to) > ms(next.now)) next = applyEvent(next, event);
      }
      return commit(next);
    }
    if (path === '/api/tasks/import') {
      if (!Array.isArray(body.tasks) || !body.tasks.length) throw new Error('请选择包含 tasks 数组的任务文件。');
      if (!validTime(body.now)) throw new Error('历史任务文件需要有效的 now 回放时间。');
      const next = createState({ now: body.now, mode: 'replay', tasks: body.tasks.map(createTask), profile: body.profile });
      validateProfile(next.profile);
      return commit(reconcile(next));
    }
    if (path === '/api/reset') return commit(createState({ now: evidence.now, mode: 'replay' }));
    throw new Error('AI 连接与新资料自动处理请运行仓库中的 Node 服务。');
  }
  return { request };
}
