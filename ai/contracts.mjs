const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const list = items => ({ type: 'array', items });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const choice = values => ({ type: 'string', enum: values });

export const analysisSchema = object({
  summary: text,
  items: list(object({
    operation: choice(['new', 'update', 'supplement', 'cancel', 'reinstate', 'conflict', 'ignore']),
    targetTaskId: nullableText, title: text,
    kind: choice(['assignment', 'quiz', 'exam', 'presentation', 'upload', 'tutorial']),
    channel: choice(['bb', 'external', 'offline']),
    deadlineAt: nullableText, deadlineDate: nullableText, opensAt: nullableText, closesAt: nullableText,
    fixedStart: nullableText, fixedEnd: nullableText, location: nullableText,
    sectionOptions: list(object({ sections: list(text), start: text, end: text, location: nullableText })),
    sections: list(text), condition: { type: ['string', 'null'], enum: ['classroom-computer', null] },
    requirements: list(text), removeRequirements: list(text), clearFields: list(choice(['deadline', 'fixed', 'condition', 'sections', 'sectionOptions'])),
    latePolicy: choice(['not_allowed', 'penalty', 'unknown']),
    attempts: choice(['single', 'multiple', 'unlimited', 'unknown']),
    scoring: choice(['last', 'highest', 'unknown']),
    durationMinutes: nullableNumber, estimatedMinutes: nullableNumber, estimateReason: text,
    splittable: { type: 'boolean' }, optional: { type: 'boolean' },
    evidence: list(object({ documentId: text, quote: text, fields: list(text) })),
    uncertainties: list(object({ field: text, question: text })), reason: text
  })),
  questions: list(text)
});

export const commandSchema = object({
  summary: text,
  intent: choice(['apply', 'preview', 'clarify']),
  operations: list(object({
    type: choice(['add_busy', 'remove_busy', 'set_estimate', 'defer', 'set_quiet', 'set_daily_limit', 'set_weekly_window', 'pause', 'snooze', 'clarify']),
    taskId: nullableText, start: nullableText, end: nullableText,
    minutes: nullableNumber, day: { type: ['integer', 'null'] },
    startClock: nullableText, endClock: nullableText, title: text, reason: text
  })),
  questions: list(text)
});

export const pingSchema = object({ ok: { type: 'boolean' }, message: text });
