"""
آزمون جهشی دستی برای ai-gateway برش ۲ (تاب‌آوری: تلاش دوباره و جایگزین): هر جهش را اعمال می‌کند، تست‌های همین برش را اجرا
می‌کند و فایل را برمی‌گرداند. هر جهش باید «KILLED» شود (تست قرمز). «SURVIVED» = تست ضعیف یا کد مرده/هم‌ارز.
فقط Python 3 استاندارد؛ جزو CI نیست. نیاز: Node ≥ 22. به پایگاه نیاز ندارد.
اجرا: python3 tooling/mutation/ai-gateway-resilience.py          (همه)
      python3 tooling/mutation/ai-gateway-resilience.py 3 9      (فقط جهش‌های ۳ تا ۹)
هر جهش یک بار (و فقط نخستین رخداد) اعمال می‌شود. پیش از هر اجرا همهٔ عبارت‌های اصلی یک‌جا بررسی می‌شود؛ اگر یکی پیدا نشود
(کد عوض شده) هیچ جهشی اجرا نمی‌شود و فهرست باید به‌روز شود. مهلتِ هر تست ۴ ثانیه است تا جهشِ «گیرکننده» زود کشته شود.
هم‌ارزهای شناخته‌شده (عمداً جهش نمی‌خورند): `typeof u === "number"` در `sanitizeUnit` (برای تنگ‌شدن نوع TS لازم است و `Number.isFinite` خودش رشته را نمی‌پذیرد)؛
`"ABORTED"` در `BEFORE_PROVIDER` (دفاعی: لغوِ پیش از فراخوانی را بالای حلقه می‌گیریم و هسته بی‌رویداد ABORTED نمی‌دهد).
(تست‌های برش ۱ هم‌چنان با `python3 tooling/mutation/ai-gateway.py` سنجیده می‌شوند؛ این فایل آن را عوض نمی‌کند.)
"""
import subprocess, sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
D = os.path.join(ROOT, 'src/modules/ai-gateway') + '/'
TESTS = [
    'src/modules/ai-gateway/backoff.test.ts',
    'src/modules/ai-gateway/decision.test.ts',
    'src/modules/ai-gateway/resilience-policy.test.ts',
    'src/modules/ai-gateway/resilience.test.ts',
    'src/modules/ai-gateway/resilience.property.test.ts',
]
M = [
 # backoff.ts
 ('backoff.ts', 'u >= 0 && u <= 1 ? u : 1', 'u > 0 && u <= 1 ? u : 1'),
 ('backoff.ts', 'u >= 0 && u <= 1 ? u : 1', 'u >= 0 && u <= 1 ? u : 0'),
 ('backoff.ts', 'if (random === null) return 1;', 'if (random === null) return 0;'),
 ('backoff.ts', '} catch {\n    return 1;', '} catch {\n    return 0;'),
 ('backoff.ts', 'Math.max(1, Math.floor(input.retryNumber))', 'Math.floor(input.retryNumber)'),
 ('backoff.ts', 'Number.isFinite(input.retryNumber) ?', 'true ?'),
 ('backoff.ts', ': 1;\n  const raw', ': 2;\n  const raw'),
 ('backoff.ts', 'Math.min(k - 1, MAX_EXPONENT)', 'Math.min(k, MAX_EXPONENT)'),
 ('backoff.ts', 'const raw = Math.min(input.maxDelayMs,', 'const raw = Math.max(input.maxDelayMs,'),
 ('backoff.ts', 'MAX_EXPONENT = 30', 'MAX_EXPONENT = 3'),
 ('backoff.ts', 'return Math.floor(raw * u);', 'return Math.round(raw * u);'),
 ('backoff.ts', 'Math.floor(raw / 2 + (raw / 2) * u)', 'Math.floor(raw * u)'),
 ('backoff.ts', 'Math.floor(raw / 2 + (raw / 2) * u)', 'Math.ceil(raw / 2 + (raw / 2) * u)'),
 ('backoff.ts', 'const u = sanitizeUnit(input.unit);', 'const u = input.unit;'),
 ('backoff.ts', 'default:\n      return raw;', 'default:\n      return 0;'),
 # decision.ts
 ('decision.ts', 'if (i.code === "ABORTED") return stop("aborted");', ''),
 ('decision.ts', 'i.code === "INVALID_REQUEST" && i.position > 0', 'i.code === "INVALID_REQUEST" && i.position >= 0'),
 ('decision.ts', 'return hasNext ? { kind: "next_model" } : stop("chain_exhausted");', 'return stop("chain_exhausted");'),
 ('decision.ts', 'if (NEVER_RETRIED.has(i.code)) return stop("non_retryable");', ''),
 ('decision.ts', '"INVALID_CONFIG", "INTERNAL_ERROR"]', '"INVALID_CONFIG"]'),
 ('decision.ts', 'i.callsMade >= p.maxTotalAttempts', 'i.callsMade > p.maxTotalAttempts'),
 ('decision.ts', 'if (i.callsMade >= p.maxTotalAttempts) return stop("budget_exhausted");', ''),
 ('decision.ts', 'p.retryOn.has(i.code) && i.retryable;', 'p.retryOn.has(i.code);'),
 ('decision.ts', 'p.retryOn.has(i.code) && i.retryable;', 'i.retryable;'),
 ('decision.ts', 'i.modelAttempt < p.maxAttemptsPerModel', 'i.modelAttempt <= p.maxAttemptsPerModel'),
 ('decision.ts', 'wait + 1 <= i.remainingMs', 'wait <= i.remainingMs'),
 ('decision.ts', 'wait + 1 <= i.remainingMs', 'wait + 1 < i.remainingMs'),
 ('decision.ts', 'i.retryAfterMs > p.maxDelayMs) return null;', 'i.retryAfterMs >= p.maxDelayMs) return null;'),
 ('decision.ts', 'if (i.retryAfterMs !== null && i.retryAfterMs > p.maxDelayMs) return null;', ''),
 ('decision.ts', 'Math.max(backoff, i.retryAfterMs)', 'Math.min(backoff, i.retryAfterMs)'),
 ('decision.ts', 'i.retryAfterMs === null ? backoff : Math.max(backoff, i.retryAfterMs)', 'i.retryAfterMs === null ? backoff : i.retryAfterMs'),
 ('decision.ts', 'unit: p.jitter === "none" ? 1 : i.jitterUnit(),', 'unit: i.jitterUnit(),'),
 ('decision.ts', 'retryNumber: i.modelAttempt,', 'retryNumber: i.modelAttempt + 1,'),
 ('decision.ts', 'if (hasNext && p.fallbackOn.has(i.code))', 'if (hasNext)'),
 ('decision.ts', 'if (hasNext && p.fallbackOn.has(i.code))', 'if (p.fallbackOn.has(i.code))'),
 ('decision.ts', 'if (blockedByTime) return stop("deadline");', ''),
 ('decision.ts', 'if (retryAfterTooLong) return stop("retry_after_too_long");', ''),
 ('decision.ts', 'if (i.chainLength > 1 && !hasNext && p.fallbackOn.has(i.code)) return stop("chain_exhausted");', ''),
 ('decision.ts', 'stop(retryEligible ? "attempts_exhausted" : "non_retryable")', 'stop(retryEligible ? "non_retryable" : "attempts_exhausted")'),
 ('decision.ts', 'const hasNext = i.position + 1 < i.chainLength;', 'const hasNext = i.position + 1 <= i.chainLength;'),
 ('decision.ts', 'if (wait === null) retryAfterTooLong = true;', 'if (wait === null) blockedByTime = true;'),
 # resilience-policy.ts
 ('resilience-policy.ts', 'isIntIn(maxAttemptsPerModel, 1, POLICY_LIMITS.maxAttemptsPerModel)', 'isIntIn(maxAttemptsPerModel, 0, POLICY_LIMITS.maxAttemptsPerModel)'),
 ('resilience-policy.ts', 'isIntIn(maxTotalAttempts, 1, POLICY_LIMITS.maxTotalAttempts)', 'isIntIn(maxTotalAttempts, 0, POLICY_LIMITS.maxTotalAttempts)'),
 ('resilience-policy.ts', 'isIntIn(totalTimeoutMs, 1, POLICY_LIMITS.maxTotalTimeoutMs)', 'isIntIn(totalTimeoutMs, 0, POLICY_LIMITS.maxTotalTimeoutMs)'),
 ('resilience-policy.ts', 'maxAttemptsPerModel: 10,', 'maxAttemptsPerModel: 11,'),
 ('resilience-policy.ts', 'maxTotalAttempts: 20,', 'maxTotalAttempts: 21,'),
 ('resilience-policy.ts', 'maxTotalTimeoutMs: 3_600_000,', 'maxTotalTimeoutMs: 3_600_001,'),
 ('resilience-policy.ts', 'maxBaseDelayMs: 60_000,', 'maxBaseDelayMs: 60_001,'),
 ('resilience-policy.ts', 'maxDelayMs: 600_000,', 'maxDelayMs: 600_001,'),
 ('resilience-policy.ts', 'maxFallbacksPerModel: 5,', 'maxFallbacksPerModel: 6,'),
 ('resilience-policy.ts', '&& max < base)', '&& max <= base)'),
 ('resilience-policy.ts', '&& max < base)', '&& false)'),
 ('resilience-policy.ts', 'for (const k of Object.keys(input)) if (!POLICY_KEYS.has(k))', 'for (const k of [] as string[]) if (!POLICY_KEYS.has(k))'),
 ('resilience-policy.ts', 'for (const k of Object.keys(b)) if (!BACKOFF_KEYS.has(k))', 'for (const k of [] as string[]) if (!BACKOFF_KEYS.has(k))'),
 ('resilience-policy.ts', '!allowed.includes(c)', 'false'),
 ('resilience-policy.ts', 'else if (out.has(c))', 'else if (false)'),
 ('resilience-policy.ts', 'Array.isArray(input["retryOn"]) && retryOn.size === 0', 'Array.isArray(input["retryOn"]) && retryOn.size === 99'),
 ('resilience-policy.ts', 'isIntIn(maxAttemptsPerModel, 2, POLICY_LIMITS.maxAttemptsPerModel)', 'isIntIn(maxAttemptsPerModel, 1, POLICY_LIMITS.maxAttemptsPerModel)'),
 ('resilience-policy.ts', 'fallbacks.size > 0 && Array.isArray', 'fallbacks.size > 99 && Array.isArray'),
 ('resilience-policy.ts', 'chain.length < 1 ||', 'chain.length < 0 ||'),
 ('resilience-policy.ts', 'chain.length > POLICY_LIMITS.maxFallbacksPerModel', 'chain.length >= POLICY_LIMITS.maxFallbacksPerModel'),
 ('resilience-policy.ts', 'else if (m === name)', 'else if (false)'),
 ('resilience-policy.ts', 'else if (seen.has(m))', 'else if (false)'),
 ('resilience-policy.ts', 'if (modelNames !== null && !modelNames.has(name))', 'if (false)'),
 ('resilience-policy.ts', 'if (modelNames !== null && !modelNames.has(m))', 'if (false)'),
 ('resilience-policy.ts', 'fallbacks.set(name, Object.freeze([...seen]));', 'fallbacks.set(name, chain as string[]);'),
 ('resilience-policy.ts', 'random = Object.freeze({ next: (r["next"] as RandomSource["next"]).bind(r) });', 'random = r as unknown as RandomSource;'),
 ('resilience-policy.ts', '} else if (jitter !== "none" && isRecord(b)', '} else if (false && isRecord(b)'),
 ('resilience-policy.ts', 'typeof j !== "string" || !JITTERS.has(j)', 'typeof j !== "string"'),
 ('resilience-policy.ts', 'typeof r["next"] !== "function"', 'false'),
 ('resilience-policy.ts', 'value: Object.freeze({\n        maxAttemptsPerModel: maxAttemptsPerModel as number,', 'value: ({\n        maxAttemptsPerModel: maxAttemptsPerModel as number,'),
 ('resilience-policy.ts', '["TIMEOUT", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE"] as const', '["PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE"] as const'),
 ('resilience-policy.ts', '  "PROVIDER_ERROR",\n] as const', '] as const'),
 ('resilience-policy.ts', 'if (!isRecord(input)) return { ok: false, issues: ["policy باید شیء باشد."] };', ''),
 # resilience.ts
 ('resilience.ts', '["INVALID_REQUEST", "UNKNOWN_MODEL", "ABORTED"]', '["UNKNOWN_MODEL", "ABORTED"]'),
 ('resilience.ts', 'if (reached) callsMade++;', ''),
 ('resilience.ts', 'const reached = seen.event !== null || (!res.ok && !BEFORE_PROVIDER.has(res.error.code));', 'const reached = seen.event !== null;'),
 ('resilience.ts', 'if (signal?.aborted) return stopWith("aborted");', ''),
 ('resilience.ts', 'if (remaining < 1) return stopWith("deadline");', 'if (remaining < 0) return stopWith("deadline");'),
 ('resilience.ts', 'Math.min(explicitTimeoutMs ?? spec.timeoutMs, remaining)', 'Math.max(explicitTimeoutMs ?? spec.timeoutMs, remaining)'),
 ('resilience.ts', 'Math.min(explicitTimeoutMs ?? spec.timeoutMs, remaining)', 'explicitTimeoutMs ?? spec.timeoutMs'),
 ('resilience.ts', 'req.timeoutMs === 0 ? null : req.timeoutMs', 'req.timeoutMs'),
 ('resilience.ts', 'return m === undefined ? undefined : { ...m, timeoutMs: 0 };', 'return m;'),
 ('resilience.ts', '...(req.requestId === null ? {} : { requestId: req.requestId }),', ''),
 ('resilience.ts', '[req.model, ...(policy.fallbacks.get(req.model) ?? [])]', '[req.model]'),
 ('resilience.ts', 'if (reached) lastReached = err;', 'lastReached = err;'),
 ('resilience.ts', 'const rep = lastReached ?? firstFailure ?? makeError("TIMEOUT");', 'const rep = firstFailure ?? lastReached ?? makeError("TIMEOUT");'),
 ('resilience.ts', 'retryAfterMs: rep.retryAfterMs ?? null, issues: rep.issues', 'retryAfterMs: null, issues: rep.issues'),
 ('resilience.ts', 'retryAfterMs: rep.retryAfterMs ?? null, issues: rep.issues', 'retryAfterMs: rep.retryAfterMs ?? null'),
 ('resilience.ts', 'if (reason === "aborted") return errorResult(trace, makeError("ABORTED"), reason);', ''),
 ('resilience.ts', 'await sleep(decision.waitMs, cfg.timers, signal);\n      waitedMs = decision.waitMs;', 'await sleep(decision.waitMs, cfg.timers, signal);\n      waitedMs = 0;'),
 ('resilience.ts', 'let waitedMs = 0;', 'let waitedMs = 7;'),
 ('resilience.ts', 'if (decision.kind === "next_model") break;', 'if (decision.kind === "next_model") return stopWith("chain_exhausted");'),
 ('resilience.ts', 'jitterUnit: () => drawUnit(policy.random),', 'jitterUnit: () => 0,'),
 ('resilience.ts', 'remainingMs: Math.floor(deadlineAt - readClock(cfg.clock)),', 'remainingMs: remaining,'),
]
M += [
 ('resilience.ts', 'a.modelAttempt > 1) && !out.includes("RETRIED")', 'a.modelAttempt > 2) && !out.includes("RETRIED")'),
 ('resilience.ts', 'a.model !== trace.requestedModel', 'a.model === trace.requestedModel'),
 ('resilience.ts', 'const reached = trace.attempts.filter((a) => a.reachedProvider);', 'const reached = trace.attempts;'),
 ('resilience.ts', 'if (!a.reachedProvider) continue;', ''),
 ('resilience.ts', 'if (a.cost === null) costUnknownAttempts++;', 'if (a.cost === null) costUnknownAttempts += 0;'),
 ('resilience.ts', 'total <= MAX_SAFE ? Number(total) : null', 'Number(total)'),
 ('resilience.ts', '(sums.get(a.cost.currency) ?? BigInt(0)) + BigInt(a.cost.micros)', 'BigInt(a.cost.micros)'),
 ('resilience.ts', 'warnings: Object.freeze(warningsOf(trace)), report: buildReport(trace, reason) }) }', 'report: buildReport(trace, reason) }) }'),
 ('resilience.ts', 'report: buildReport(trace, "success")', 'report: buildReport(trace, "attempts_exhausted")'),
 ('resilience.ts', 'if (!trace.warnings.includes(w)) trace.warnings.push(w);', 'trace.warnings.push(w);'),
 ('resilience.ts', 'addWarnings(trace, res.ok ? res.value.warnings : res.error.warnings);', 'addWarnings(trace, res.ok ? [] : res.error.warnings);'),
 ('resilience.ts', 'usage: seen.event === null ? null : seen.event.usage,', 'usage: null,'),
 ('resilience.ts', 'latencyMs: seen.event === null ? 0 : seen.event.latencyMs,', 'latencyMs: 0,'),
 ('resilience.ts', 'index: trace.attempts.length + 1,', 'index: trace.attempts.length,'),
 ('resilience.ts', 'const deadlineAt = readClock(cfg.clock) + policy.totalTimeoutMs;', 'const deadlineAt = readClock(cfg.clock) - policy.totalTimeoutMs;'),
 ('resilience.ts', '...(cfg.ok ? [] : cfg.issues), ...(pol.ok ? [] : pol.issues)', '...(cfg.ok ? [] : cfg.issues)'),
 ('resilience.ts', 'cfg.ok ? new Set(cfg.value.models.keys()) : null', 'null'),
 ('resilience.ts', 'priced: m.price !== null', 'priced: true'),
 ('resilience.ts', 'return errorResult(trace, makeError("INTERNAL_ERROR"), "non_retryable");', 'return errorResult(trace, makeError("PROVIDER_ERROR"), "non_retryable");'),
 ('resilience.ts', '(s !== undefined && !(typeof AbortSignal !== "undefined" && s instanceof AbortSignal))', 'false'),
 ('resilience.ts', 'if (!parsed.ok) return errorResult(trace, parsed.error, "non_retryable");', 'if (!parsed.ok) return errorResult(trace, parsed.error, "deadline");'),
 ('resilience.ts', 'trace.requestedModel = req.model;', ''),
 ('resilience.ts', 'signal === undefined ? undefined : { signal }', 'undefined'),
 # gateway.ts: نقطهٔ مشاهده (ADR-0015 §۹)
 ('gateway.ts', '      observe(event);\n', ''),
 ('gateway.ts', 'return await run(cfg, input, options, observe);', 'return await run(cfg, input, options);'),
 ('gateway.ts', '      // مشاهده‌گر هرگز نتیجهٔ فراخوانی را عوض نمی‌کند.\n', '      throw new Error("rethrow");\n'),
 ('gateway.ts', '  try {\n    return await run(cfg, input, options, observe);\n  } catch {\n    return fail("INTERNAL_ERROR");', '  try {\n    return await run(cfg, input, options, observe);\n  } catch {\n    return fail("PROVIDER_ERROR");'),
 ('gateway.ts', 'if (observe !== undefined) {', 'if (observe === undefined) {'),
]
lo = int(sys.argv[1]) if len(sys.argv) > 1 else 1
hi = int(sys.argv[2]) if len(sys.argv) > 2 else len(M)

# پیش‌بررسی: همهٔ عبارت‌های اصلی باید وجود داشته باشند (وگرنه فهرست کهنه است)
missing = [(i, f, old[:70]) for i, (f, old, new) in enumerate(M, 1) if old not in open(D + f, encoding='utf-8').read()]
if missing:
    for i, f, o in missing:
        print(f'#{i} {f}: متن اصلی پیدا نشد: {o!r}')
    print('فهرست جهش‌ها باید به‌روز شود؛ هیچ جهشی اجرا نشد.')
    sys.exit(2)

survived, killed = [], 0
for i, (f, old, new) in enumerate(M, 1):
    if i < lo or i > hi:
        continue
    path = D + f
    src = open(path, encoding='utf-8').read()
    try:
        open(path, 'w', encoding='utf-8').write(src.replace(old, new, 1))
        r = subprocess.run(['node_modules/.bin/vitest', 'run', '--testTimeout=4000', *TESTS], cwd=ROOT, capture_output=True, text=True, timeout=300)
        red = r.returncode != 0
    except subprocess.TimeoutExpired:
        red = True  # گیرکردن هم «کشته شدن» است
    finally:
        open(path, 'w', encoding='utf-8').write(src)
    if red:
        killed += 1
    else:
        survived.append(i)
    print(f'#{i:03d} {f:22s} {"KILLED" if red else "SURVIVED"}  {old[:60]!r}', flush=True)
print(f'\nکشته: {killed}  زنده: {len(survived)} {survived}')
sys.exit(1 if survived else 0)
