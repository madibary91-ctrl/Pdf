"""
آزمون جهشی دستی برای ai-gateway (برش ۱: هسته): هر جهش را اعمال می‌کند، تست‌های ماژول را اجرا می‌کند و فایل را برمی‌گرداند.
هر جهش باید «KILLED» شود (تست قرمز). «SURVIVED» = تست ضعیف یا کد مرده/هم‌ارز. فقط Python 3 استاندارد؛ جزو CI نیست.
نیاز: Node ≥ 22. (ai-gateway به پایگاه نیاز ندارد.)
اجرا: python3 tooling/mutation/ai-gateway.py          (همه)
      python3 tooling/mutation/ai-gateway.py 3 9      (فقط جهش‌های ۳ تا ۹)
هر جهش یک بار (و فقط نخستین رخداد) اعمال می‌شود؛ اگر متن اصلی پیدا نشود اجرا متوقف می‌شود (کد عوض شده و فهرست باید به‌روز شود).
"""
import subprocess, sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
D = os.path.join(ROOT, 'src/modules/ai-gateway') + '/'
TESTS = ['src/modules/ai-gateway']
M = [
 # gateway.ts — لغو، مهلت، حسابداری، هشدارها
 ('gateway.ts', 'if (signal?.aborted) return fail("ABORTED");', ''),
 ('gateway.ts', 'if (settled.kind !== "value") controller.abort();', 'if (false) controller.abort();'),
 ('gateway.ts', 'Math.max(0, Math.floor(readClock(cfg.clock) - startedAtMs))', 'Math.floor(readClock(cfg.clock) - startedAtMs)'),
 ('gateway.ts', 'Math.max(0, Math.floor(readClock(cfg.clock) - startedAtMs))', 'Math.max(0, readClock(cfg.clock) - startedAtMs)'),
 ('gateway.ts', 'const startedAtMs = readClock(cfg.clock);', 'const startedAtMs = 0;'),
 ('gateway.ts', 'if (usage === null) warnings.push("USAGE_MISSING");', ''),
 ('gateway.ts', 'if (model.price === null) warnings.push("UNPRICED");', ''),
 ('gateway.ts', 'interpreted.reply.finishReason === "length"', 'interpreted.reply.finishReason === "stop"'),
 ('gateway.ts', 'interpreted.reply.text.trim() === ""', 'interpreted.reply.text === ""'),
 ('gateway.ts', 'usage !== null && model.price !== null ? Object.freeze(computeCost(usage, model.price)) : null', 'usage !== null ? Object.freeze(computeCost(usage, model.price as never)) : null'),
 ('gateway.ts', 'usage = salvageUsage(settled.value);', 'usage = null;'),
 ('gateway.ts', 'settled.kind === "timeout" ? "TIMEOUT" : "ABORTED"', 'settled.kind === "timeout" ? "ABORTED" : "TIMEOUT"'),
 ('gateway.ts', 'settled.kind === "timeout" ? "USAGE_SINK_TIMEOUT" : "USAGE_SINK_FAILED"', 'settled.kind === "timeout" ? "USAGE_SINK_FAILED" : "USAGE_SINK_TIMEOUT"'),
 ('gateway.ts', 'if (sink === null) return [];', ''),
 ('gateway.ts', 'outcome: interpreted.kind === "ok" ? "ok" : interpreted.failure.code,', 'outcome: "ok",'),
 ('gateway.ts', '{ ...interpreted.failure.extra, warnings: sinkWarnings }', '{ ...interpreted.failure.extra, warnings: [] }'),
 ('gateway.ts', '{ ...interpreted.failure.extra, warnings: sinkWarnings }', '{ warnings: sinkWarnings }'),
 ('gateway.ts', 'if (usage !== null) usage = Object.freeze({ ...usage });', ''),
 ('gateway.ts', 'return fail("INTERNAL_ERROR");\n      }\n    },', 'return fail("PROVIDER_ERROR");\n      }\n    },'),
 ('gateway.ts', 'temperature: req.temperature,', 'temperature: 0,'),
 ('gateway.ts', 'model: model.providerModel,\n    messages', 'model: req.model,\n    messages'),
 ('gateway.ts', 'servedModel: interpreted.kind === "ok" ? interpreted.reply.servedModel : null,', 'servedModel: null,'),
 ('gateway.ts', 'typeof t !== "number" || !Number.isFinite(t)', 'false'),
 ('gateway.ts', 'priced: m.price !== null', 'priced: true'),
 ('gateway.ts', '(s !== undefined && !(typeof AbortSignal !== "undefined" && s instanceof AbortSignal))', 'false'),
 ('gateway.ts', 'if (!parsed.ok) return parsed;', ''),
 # errors.ts
 ('errors.ts', 'r >= 0 && r <= MAX_RETRY_AFTER_MS', 'r <= MAX_RETRY_AFTER_MS'),
 ('errors.ts', 'r <= MAX_RETRY_AFTER_MS ? r : null', 'r <= MAX_RETRY_AFTER_MS + 1 ? r : null'),
 ('errors.ts', 'typeof r === "number" && Number.isInteger(r) &&', 'typeof r === "number" &&'),
 ('errors.ts', 'return { code: "PROVIDER_AUTH", retryAfterMs: null };', 'return { code: "PROVIDER_REJECTED", retryAfterMs: null };'),
 ('errors.ts', 'return { code: "PROVIDER_RATE_LIMITED", retryAfterMs: e.retryAfterMs };', 'return { code: "PROVIDER_RATE_LIMITED", retryAfterMs: null };'),
 ('errors.ts', 'return { code: "PROVIDER_UNAVAILABLE", retryAfterMs: e.retryAfterMs };', 'return { code: "PROVIDER_UNAVAILABLE", retryAfterMs: null };'),
 ('errors.ts', 'مهلت مقرر پاسخ نداد.", retryable: true', 'مهلت مقرر پاسخ نداد.", retryable: false'),
 ('errors.ts', 'با خطای پیش‌بینی‌نشده شکست خورد.", retryable: false', 'با خطای پیش‌بینی‌نشده شکست خورد.", retryable: true'),
 ('errors.ts', 'پذیرفته نشد.", retryable: false }', 'پذیرفته نشد.", retryable: true }'),
 ('errors.ts', 'extra.retryAfterMs === undefined || extra.retryAfterMs === null ? {}', 'extra.retryAfterMs === undefined ? {}'),
 # pricing.ts
 ('pricing.ts', 'numerator + MILLION - BigInt(1)', 'numerator'),
 ('pricing.ts', 'BigInt(usage.outputTokens) * BigInt(price.outputMicrosPerMTok)', 'BigInt(usage.outputTokens) * BigInt(price.inputMicrosPerMTok)'),
 ('pricing.ts', 'totalTokens: i + o', 'totalTokens: i'),
 ('pricing.ts', 'isIntIn(i, 0, PRICE_LIMITS.maxTokens)', 'isIntIn(i, 1, PRICE_LIMITS.maxTokens)'),
 ('pricing.ts', 'maxMicrosPerMTok: 1_000_000_000_000', 'maxMicrosPerMTok: 1_000_000_000_001'),
 ('pricing.ts', 'maxTokens: 1_000_000_000 }', 'maxTokens: 1_000_000_001 }'),
 ('pricing.ts', '/^[A-Z]{3}$/', '/^[A-Za-z]{3}$/'),
 ('pricing.ts', 'for (const k of Object.keys(v)) if (!PRICE_KEYS.has(k))', 'for (const k of []) if (!PRICE_KEYS.has(k as string))'),
 # deadline.ts
 ('deadline.ts', 'timers.clearTimeout(handle);', ''),
 ('deadline.ts', 'signal.removeEventListener("abort", onAbort);', ''),
 ('deadline.ts', 'if (signal.aborted) {', 'if (false) {'),
 ('deadline.ts', '(error: unknown) => finish({ kind: "threw", error }),', '(error: unknown) => finish({ kind: "timeout" }),'),
 # reply.ts
 ('reply.ts', 'm.length > MAX_SERVED_MODEL_CHARS', 'm.length > MAX_SERVED_MODEL_CHARS + 1'),
 ('reply.ts', 'typeof m !== "string" || m === "" ||', 'typeof m !== "string" ||'),
 ('reply.ts', 'if (usage === null) issues.push("reply.usage', 'if (false) issues.push("reply.usage'),
 ('reply.ts', '"stop", "length", "content_filter", "other"]', '"stop", "length", "content_filter"]'),
 ('reply.ts', 'return isRecord(raw) ? parseUsage(raw["usage"]) : null;', 'return null;'),
 # request.ts
 ('request.ts', 'raw.length < 1 || raw.length > REQUEST_LIMITS.maxMessages', 'raw.length < 1 || raw.length >= REQUEST_LIMITS.maxMessages'),
 ('request.ts', 'role === "system" && i !== 0', 'role === "system" && i !== 1'),
 ('request.ts', 'total > model.maxInputChars', 'total >= model.maxInputChars'),
 ('request.ts', 'content.trim() === ""', 'content === ""'),
 ('request.ts', 'if (!s.isWellFormed())', 'if (false)'),
 ('request.ts', 'if (s.includes("\\u0000"))', 'if (false)'),
 ('request.ts', '["role"] !== "user") issues.push("messages: آخرین', '["role"] !== "assistant") issues.push("messages: آخرین'),
 ('request.ts', 't < 0 || t > REQUEST_LIMITS.maxTemperature', 't < 0 || t >= REQUEST_LIMITS.maxTemperature'),
 ('request.ts', 'let temperature = 0;', 'let temperature = 1;'),
 ('request.ts', 'typeof r !== "string" || !REQUEST_ID_RE.test(r)', 'typeof r !== "string"'),
 ('request.ts', 'raw.length > REQUEST_LIMITS.maxStopSequences', 'raw.length >= REQUEST_LIMITS.maxStopSequences'),
 ('request.ts', 'else if (out.includes(s))', 'else if (false)'),
 ('request.ts', 'for (const k of Object.keys(input)) if (!KEYS.has(k))', 'for (const k of []) if (!KEYS.has(k as string))'),
 ('request.ts', 'for (const k of Object.keys(m)) if (!MESSAGE_KEYS.has(k))', 'for (const k of []) if (!MESSAGE_KEYS.has(k as string))'),
 ('request.ts', 'if (model === undefined) return fail("UNKNOWN_MODEL", { issues });', 'if (model === undefined) return fail("INVALID_REQUEST", { issues });'),
 ('request.ts', 'if (!isIntIn(mot, 1, model.maxOutputTokens))', 'if (!isIntIn(mot, 1, model.maxOutputTokens + 1))'),
 ('request.ts', 'if (!isIntIn(t, 1, LIMITS.maxTimeoutMs))', 'if (!isIntIn(t, 0, LIMITS.maxTimeoutMs))'),
 ('request.ts', 'let timeoutMs = model.timeoutMs;', 'let timeoutMs = 60000;'),
 ('request.ts', 'content.length > REQUEST_LIMITS.maxMessageChars', 'content.length > REQUEST_LIMITS.maxMessageChars + 1'),
 # config.ts
 ('config.ts', 'return Object.freeze({ complete });', 'return p as unknown as ModelProvider;'),
 ('config.ts', 'clock = Object.freeze({ nowMs: (rawClock["nowMs"] as Clock["nowMs"]).bind(rawClock) });', 'clock = rawClock as unknown as Clock;'),
 ('config.ts', 'if (p.ok) price = p.value;', 'if (p.ok) price = v["price"] as PriceSpec;'),
 ('config.ts', 'isIntIn(v["maxInputChars"], 1, LIMITS.maxInputChars)', 'isIntIn(v["maxInputChars"], 0, LIMITS.maxInputChars)'),
 ('config.ts', 'v["timeoutMs"] === undefined ? defaultTimeoutMs :', 'v["timeoutMs"] === undefined ? LIMITS.defaultTimeoutMs :'),
 ('config.ts', 'typeof st === "number" ? st : LIMITS.defaultSinkTimeoutMs', 'typeof st === "number" ? st : 1'),
 ('config.ts', 'for (const k of Object.keys(input)) if (!CONFIG_KEYS.has(k))', 'for (const k of []) if (!CONFIG_KEYS.has(k as string))'),
 ('config.ts', 'timers = Object.freeze({ setTimeout: setT, clearTimeout: clearT });', 'timers = t as unknown as Timers;'),
 ('config.ts', 'else usageSink = Object.freeze({ record: (s["record"] as UsageSink["record"]).bind(s) });', 'else usageSink = s as unknown as UsageSink;'),
]
lo = int(sys.argv[1]) if len(sys.argv) > 1 else 1
hi = int(sys.argv[2]) if len(sys.argv) > 2 else len(M)
survived, killed = [], 0
for i, (f, old, new) in enumerate(M, 1):
    if i < lo or i > hi:
        continue
    path = D + f
    src = open(path, encoding='utf-8').read()
    if old not in src:
        print(f'#{i} {f}: متن اصلی پیدا نشد؛ فهرست جهش‌ها باید به‌روز شود'); sys.exit(2)
    try:
        open(path, 'w', encoding='utf-8').write(src.replace(old, new, 1))
        r = subprocess.run(['node_modules/.bin/vitest', 'run', *TESTS], cwd=ROOT, capture_output=True, text=True, timeout=300)
        red = r.returncode != 0
    except subprocess.TimeoutExpired:
        red = True  # گیرکردن هم «کشته شدن» است
    finally:
        open(path, 'w', encoding='utf-8').write(src)
    if red:
        killed += 1
    else:
        survived.append(i)
    print(f'#{i:02d} {f:12s} {"KILLED" if red else "SURVIVED"}  {old[:60]!r}', flush=True)
print(f'\nکشته: {killed}  زنده: {len(survived)} {survived}')
sys.exit(1 if survived else 0)
