import { AsyncLocalStorage } from 'node:async_hooks';

// One context per record, never shared between concurrent lookups. No keys,
// request URLs containing credentials, or raw exception messages are recorded.
const storage = new AsyncLocalStorage();
export const lookupContext = () => storage.getStore();
export function noteLookup(reason, detail = {}) {
  const ctx = lookupContext();
  if (!ctx) return;
  const entry = { reason, ...detail };
  if (ctx.notes.length < 30) ctx.notes.push(entry);
  ctx.reason = reason;
}
export const hasLookupIssue = (...reasons) => Boolean(lookupContext()?.notes.some(n => reasons.includes(n.reason)));

export async function withLookupContext(task, { signal, timeoutMs = 45000, maxRequests = 120 } = {}) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
  const ctx = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    requests: 0, maxRequests, notes: [], reason: '', cache: new Map() };
  return storage.run(ctx, async () => {
    let meta;
    try { meta = await task(); }
    catch { noteLookup(ctx.signal.aborted ? 'lookup-timeout' : 'lookup-error'); }
    const status = meta === undefined ? 'unavailable' : meta ? 'matched' :
      hasLookupIssue('source-credits-conflict', 'media-type-conflict', 'override-conflict', 'scoped-match-needs-review') ? 'review' : 'unresolved';
    const reason = ctx.signal.aborted && meta === undefined ? 'lookup-timeout' :
      meta ? (meta.originalLanguage ? meta.match || 'matched' : 'original-language-missing') :
      ctx.reason || (status === 'unavailable' ? 'lookup-incomplete' : 'no-safe-match');
    return { meta, status, reason, requests: ctx.requests, notes: ctx.notes };
  });
}
