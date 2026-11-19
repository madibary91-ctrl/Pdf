#!/usr/bin/env python3
"""
آزمون جهشی «پایشِ پسماندِ زنگِ تسویه» (برش م۳‑ه‑۴‑الف‑۱؛ ADR-0039): هر جهش یک تغییر کوچکِ معنادار در یکی از فایل‌های منبعِ
`src/modules/settlement-backlog/` است؛ آزمون‌های بی‌پایگاهِ همان ماژول باید قرمز شوند.
اجرا:  python3 tooling/mutation/settlement-backlog.py            (همه)
       python3 tooling/mutation/settlement-backlog.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22؛ پایگاه نمی‌خواهد؛ جزو CI نیست. فقط Python 3 استاندارد.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متنِ اصلیِ هر جهش دقیقاً یک بار در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement-backlog/"
TESTS = [B + n for n in ("config.test.ts", "sample.test.ts", "evaluate.test.ts", "evaluate.property.test.ts", "backlog.integration.test.ts", "purity.test.ts")]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


E, S, C, K = "evaluate.ts", "sample.ts", "config.ts", "monitor.ts"

# ── evaluate.ts: جدول‌ها و اعتبارسنجی
m(E, '{ CLOCK_INVALID: true, LIST_FAILED: true, BAD_LIST: true, TIMEOUT: true }', '{ CLOCK_INVALID: true, LIST_FAILED: true, BAD_LIST: true }', "TIMEOUT از کدهای مجازِ شکست حذف می‌شود")
m(E, 'Object.prototype.hasOwnProperty.call(table, key)', 'key in table', "کلیدهای prototype به‌عنوان کدِ شکست مجاز می‌شوند")
m(E, 'typeof v === "object" && v !== null && !Array.isArray(v);\nconst isTime', 'typeof v === "object" && !Array.isArray(v);\nconst isTime', "null شیء شمرده می‌شود")
m(E, 'typeof v === "object" && v !== null && !Array.isArray(v);\nconst isTime', 'typeof v === "object" && v !== null;\nconst isTime', "آرایه شیء شمرده می‌شود")
m(E, 'Number.isSafeInteger(v) && v >= 0;\nconst isFailure', 'Number.isSafeInteger(v);\nconst isFailure', "زمانِ منفی پذیرفته می‌شود")
m(E, 'typeof v === "number" && Number.isSafeInteger(v) && v >= 0;\nconst isFailure', 'typeof v === "number" && v >= 0;\nconst isFailure', "زمانِ اعشاری/ناایمن پذیرفته می‌شود")
m(E, 'if (keys.length !== REASON_KEYS.length) return null;', '', "کلیدِ اضافه در byReason پذیرفته می‌شود")
m(E, 'typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return null;\n    out[k]', 'typeof v !== "number" || !Number.isSafeInteger(v)) return null;\n    out[k]', "مقدارِ منفیِ byReason پذیرفته می‌شود")
m(E, 'typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return null;\n    out[k]', 'typeof v !== "number" || v < 0) return null;\n    out[k]', "مقدارِ اعشاریِ byReason پذیرفته می‌شود")
m(E, 'if (!(atMs === null || isTime(atMs)) || !isFailure(code)) return null;', 'if (!(atMs === null || isTime(atMs))) return null;', "کدِ شکستِ نمونه اعتبارسنجی نمی‌شود")
m(E, 'if (!(atMs === null || isTime(atMs)) || !isFailure(code)) return null;', 'if (!isTime(atMs) || !isFailure(code)) return null;', "atMs=null در نمونهٔ ناموفق رد می‌شود")
m(E, 'if (!(atMs === null || isTime(atMs)) || !isFailure(code)) return null;', 'if (!isFailure(code)) return null;', "atMs نمونهٔ ناموفق اعتبارسنجی نمی‌شود")
m(E, '  if (ok !== true) return null;\n', '', "ok غیربولی نمونهٔ سالم شمرده می‌شود")
m(E, 'count < 0 || count > ctx.sampleLimit) return null;', 'count < 0 || count > ctx.sampleLimit + 1) return null;', "count تا یک بیش از سقف پذیرفته می‌شود")
m(E, 'count < 0 || count > ctx.sampleLimit) return null;', 'count < 0) return null;', "count بیش از سقف پذیرفته می‌شود")
m(E, '!Number.isSafeInteger(count) || count < 0', '!Number.isSafeInteger(count)', "count منفی پذیرفته می‌شود")
m(E, 'typeof count !== "number" || !Number.isSafeInteger(count)', 'typeof count !== "number" || !(count === count)', "count اعشاری پذیرفته می‌شود")
m(E, 'undated < 0 || undated > count) return null;', 'undated < 0 || undated > count + 1) return null;', "undated تا یک بیش از count پذیرفته می‌شود")
m(E, 'undated < 0 || undated > count) return null;', 'undated < 0) return null;', "undated بیش از count پذیرفته می‌شود")
m(E, 'typeof undated !== "number" || !Number.isSafeInteger(undated) || undated < 0', 'typeof undated !== "number" || !Number.isSafeInteger(undated)', "undated منفی پذیرفته می‌شود")
m(E, '  if (truncated !== (count === ctx.sampleLimit)) return null;\n', '', "ناسازگاریِ truncated با سقف نادیده گرفته می‌شود")
m(E, 'truncated !== (count === ctx.sampleLimit)', 'truncated !== (count >= ctx.sampleLimit)', "truncated با >= سنجیده می‌شود (هم‌ارزِ نظری؛ به‌خاطر سقفِ count)")
m(E, '  if (oldestDeadAtMs !== null && !isTime(oldestDeadAtMs)) return null;\n', '', "oldestDeadAtMs اعتبارسنجی نمی‌شود")
m(E, '  if ((oldestDeadAtMs === null) !== (undated === count)) return null;\n', '', "ناسازگاریِ oldest با undated نادیده گرفته می‌شود")
m(E, '  if (REASON_KEYS.reduce((a, k) => a + byReason[k], 0) !== count) return null;\n', '', "جمعِ byReason با count سنجیده نمی‌شود")
m(E, '  return Object.freeze({ ok: true as const, atMs, count, truncated, oldestDeadAtMs, undated, byReason });', '  return Object.freeze({ ...raw, ok: true as const, atMs, count, truncated, oldestDeadAtMs, undated, byReason }) as ParsedSample;', "فیلدهای اضافهٔ نمونه نگه داشته می‌شوند")
# ── evaluate.ts: ساخت نتیجه
m(E, 'const reason = (code: BacklogReasonCode, severity: "degraded" | "down"): BacklogReason => Object.freeze({ code, severity });', 'const reason = (code: BacklogReasonCode, severity: "degraded" | "down"): BacklogReason => ({ code, severity });', "دلیل‌ها منجمد نیستند")
m(E, 'const sorted = [...reasons.filter((r) => r.severity === "down"), ...reasons.filter((r) => r.severity === "degraded")];', 'const sorted = [...reasons.filter((r) => r.severity === "degraded"), ...reasons.filter((r) => r.severity === "down")];', "degraded پیش از down می‌آید")
m(E, 'const sorted = [...reasons.filter((r) => r.severity === "down"), ...reasons.filter((r) => r.severity === "degraded")];', 'const sorted = [...reasons];', "مرتب‌سازیِ دلیل‌ها حذف می‌شود")
m(E, 'sorted.length === 0 ? "ok" : sorted[0]?.severity === "down" ? "down" : "degraded"', 'sorted.length === 0 ? "ok" : "degraded"', "down هرگز وضعیتِ نهایی نیست")
m(E, 'sorted.length === 0 ? "ok" : sorted[0]?.severity === "down" ? "down" : "degraded"', 'sorted.length === 0 ? "ok" : "down"', "هر دلیلی down است")
m(E, 'return Object.freeze({ status, reasons: Object.freeze(sorted), ...view, thresholds: th });', 'return ({ status, reasons: Object.freeze(sorted), ...view, thresholds: th }) as BacklogHealth;', "نتیجه منجمد نیست")
m(E, 'return Object.freeze({ status, reasons: Object.freeze(sorted), ...view, thresholds: th });', 'return Object.freeze({ status, reasons: sorted, ...view, thresholds: th });', "فهرستِ دلیل‌ها منجمد نیست")
# ── evaluate.ts: ارزیابی
m(E, '  if (s === null || !isTime(nowMs)) return build(th, [reason("INPUT_INVALID", "down")], EMPTY_VIEW);', '  if (s === null) return build(th, [reason("INPUT_INVALID", "down")], EMPTY_VIEW);', "nowMs نامعتبر نادیده گرفته می‌شود")
m(E, '  if (s === null || !isTime(nowMs)) return build(th, [reason("INPUT_INVALID", "down")], EMPTY_VIEW);', '  if (!isTime(nowMs)) return build(th, [reason("INPUT_INVALID", "down")], EMPTY_VIEW);', "نمونهٔ نامعتبر نادیده گرفته می‌شود")
m(E, 'return build(th, [reason("INPUT_INVALID", "down")], EMPTY_VIEW);\n  const nowMs', 'return build(th, [], EMPTY_VIEW);\n  const nowMs', "ورودیِ غیرشیء ok شمرده می‌شود")
m(E, 'reason("SAMPLE_UNREADABLE", "degraded")', 'reason("SAMPLE_UNREADABLE", "down")', "نمونهٔ ناخوانا down می‌شود")
m(E, '  if (!s.ok) return build(th, [reason("SAMPLE_UNREADABLE", "degraded")], { ...EMPTY_VIEW, failure: s.code });', '  if (!s.ok) return build(th, [], { ...EMPTY_VIEW, failure: s.code });', "نمونهٔ ناخوانا ok شمرده می‌شود")
m(E, '{ ...EMPTY_VIEW, failure: s.code }', 'EMPTY_VIEW', "کدِ شکست در نتیجه نیست")
m(E, '  if (sampleAge < 0) behind = true;', '  if (sampleAge <= 0) behind = true;', "سنِ صفرِ نمونه عقب‌ماندگی شمرده می‌شود")
m(E, '  if (sampleAge < 0) behind = true;', '  if (sampleAge < -1) behind = true;', "یک میلی‌ثانیه عقب‌ماندنِ ساعت دیده نمی‌شود")
m(E, 'if (sampleAge > th.sampleMaxAgeMs) out.push(reason("SAMPLE_STALE", "degraded"));', 'if (sampleAge >= th.sampleMaxAgeMs) out.push(reason("SAMPLE_STALE", "degraded"));', "مرزِ کهنگی شاملِ برابری می‌شود")
m(E, 'if (sampleAge > th.sampleMaxAgeMs) out.push(reason("SAMPLE_STALE", "degraded"));', 'if (sampleAge > th.sampleMaxAgeMs + 1) out.push(reason("SAMPLE_STALE", "degraded"));', "مرزِ کهنگی یک میلی‌ثانیه گشاد می‌شود")
m(E, 'reason("SAMPLE_STALE", "degraded")', 'reason("SAMPLE_STALE", "down")', "کهنگیِ نمونه down می‌شود")
m(E, '    sampleAgeMs = sampleAge;\n', '', "سنِ نمونه گزارش نمی‌شود")
m(E, '  if (s.count >= th.downCount) out.push(reason("COUNT_CRITICAL", "down"));', '  if (s.count > th.downCount) out.push(reason("COUNT_CRITICAL", "down"));', "مرزِ down شمار اکیداً بیشتر می‌شود")
m(E, 'else if (s.count >= th.degradedCount) out.push(reason("COUNT_HIGH", "degraded"));', 'else if (s.count > th.degradedCount) out.push(reason("COUNT_HIGH", "degraded"));', "مرزِ degraded شمار اکیداً بیشتر می‌شود")
m(E, '  if (s.count >= th.downCount) out.push(reason("COUNT_CRITICAL", "down"));\n  else if', '  if (s.count >= th.downCount) out.push(reason("COUNT_CRITICAL", "down"));\n  if', "COUNT_HIGH کنارِ COUNT_CRITICAL هم می‌آید")
m(E, 'reason("COUNT_CRITICAL", "down")', 'reason("COUNT_CRITICAL", "degraded")', "COUNT_CRITICAL فقط degraded است")
m(E, 'reason("COUNT_HIGH", "degraded")', 'reason("COUNT_HIGH", "down")', "COUNT_HIGH down می‌شود")
m(E, '    if (age < 0) behind = true;', '    if (age <= 0) behind = true;', "سنِ صفرِ قدیمی‌ترین عقب‌ماندگی شمرده می‌شود")
m(E, '    if (age < 0) behind = true;', '    if (age < -1) behind = true;', "یک میلی‌ثانیه عقب‌ماندگیِ مرگ دیده نمی‌شود")
m(E, '      oldestAgeMs = age;\n', '', "سنِ قدیمی‌ترین گزارش نمی‌شود")
m(E, 'if (age > th.downAfterMs) out.push(reason("OLDEST_STUCK", "down"));', 'if (age >= th.downAfterMs) out.push(reason("OLDEST_STUCK", "down"));', "مرزِ down سن شاملِ برابری می‌شود")
m(E, 'if (age > th.downAfterMs) out.push(reason("OLDEST_STUCK", "down"));', 'if (age > th.downAfterMs + 1) out.push(reason("OLDEST_STUCK", "down"));', "مرزِ down سن یک میلی‌ثانیه گشاد می‌شود")
m(E, 'else if (age > th.degradedAfterMs) out.push(reason("OLDEST_AGED", "degraded"));', 'else if (age >= th.degradedAfterMs) out.push(reason("OLDEST_AGED", "degraded"));', "مرزِ degraded سن شاملِ برابری می‌شود")
m(E, 'else if (age > th.degradedAfterMs) out.push(reason("OLDEST_AGED", "degraded"));', 'else if (age > th.degradedAfterMs + 1) out.push(reason("OLDEST_AGED", "degraded"));', "مرزِ degraded سن یک میلی‌ثانیه گشاد می‌شود")
m(E, 'reason("OLDEST_STUCK", "down")', 'reason("OLDEST_STUCK", "degraded")', "OLDEST_STUCK فقط degraded است")
m(E, '  if (s.undated > 0) out.push(reason("AGE_UNKNOWN", "degraded"));', '', "مردهٔ بی‌زمان دیده نمی‌شود")
m(E, 'reason("AGE_UNKNOWN", "degraded")', 'reason("AGE_UNKNOWN", "down")', "AGE_UNKNOWN down می‌شود")
m(E, '  if (behind) out.push(reason("CLOCK_BEHIND", "degraded"));', '', "عقب‌ماندگیِ ساعت دیده نمی‌شود")
m(E, 'reason("CLOCK_BEHIND", "degraded")', 'reason("CLOCK_BEHIND", "down")', "CLOCK_BEHIND down می‌شود")
m(E, '    return build(ctx.thresholds, [reason("INPUT_INVALID", "down")], EMPTY_VIEW);\n  }', '    return build(ctx.thresholds, [], EMPTY_VIEW);\n  }', "پرتابِ داخلی ok شمرده می‌شود")
# ── sample.ts
m(S, 'const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;', 'const isId = (v: unknown): v is string => typeof v === "string";', "شناسهٔ تهی پذیرفته می‌شود")
m(S, 'if (state !== "dead" || !isId(tenantId)', 'if (!isId(tenantId)', "رکوردِ غیرِ‌مرده پذیرفته می‌شود")
m(S, '|| !isId(accountId) || !isId(reservationId)) return null;', '|| !isId(reservationId)) return null;', "accountId اعتبارسنجی نمی‌شود")
m(S, 'typeof deadReason !== "string" || !has(DEAD_REASONS, deadReason)', 'typeof deadReason !== "string"', "دلیلِ مرگِ ناشناخته پذیرفته می‌شود")
m(S, 'has(DEAD_REASONS, deadReason)', 'deadReason in DEAD_REASONS', "کلیدِ prototype دلیلِ مرگ شمرده می‌شود")
m(S, '    if (settledAtMs !== null && !isTime(settledAtMs)) return null;\n', '', "settledAtMs اعتبارسنجی نمی‌شود")
m(S, '    if (seen.has(key)) return null;', '    if (seen.has(key) && false) return null;', "رکوردِ تکراری پذیرفته می‌شود")
m(S, 'const key = JSON.stringify([tenantId, accountId, reservationId]);', 'const key = [tenantId, accountId, reservationId].join("");', "کلیدِ یکتایی با الحاقِ بی‌جداکننده ساخته می‌شود (تصادم)")
m(S, 'byReason[deadReason as DeadReason] += 1;', 'byReason[deadReason as DeadReason] += 2;', "تفکیکِ دلیل دو برابر می‌شود")
m(S, '    if (settledAtMs === null) undated += 1;\n    else if (oldest === null || settledAtMs < oldest) oldest = settledAtMs;', '    if (settledAtMs === null) undated += 1;\n    else if (oldest === null || settledAtMs > oldest) oldest = settledAtMs;', "جدیدترین به‌جای قدیمی‌ترین")
m(S, '    if (settledAtMs === null) undated += 1;\n    else if (oldest === null || settledAtMs < oldest) oldest = settledAtMs;', '    if (settledAtMs === null) undated += 1;\n    if (oldest === null || (settledAtMs !== null && settledAtMs < oldest)) oldest = settledAtMs;', "بی‌زمان قدیمی‌ترین را null می‌کند")
m(S, 'count: list.length,', 'count: list.length + undated,', "شمار با undated دوباره شمرده می‌شود")
m(S, '    if (atMs === null) return fail("CLOCK_INVALID", null);', '', "ساعتِ نامعتبر نادیده گرفته می‌شود")
m(S, '    if (got.kind === "timeout") return fail("TIMEOUT", atMs);', '', "مهلت نادیده گرفته می‌شود")
m(S, 'if (got.kind === "threw") return fail("LIST_FAILED", atMs);', 'if (got.kind === "threw") return fail("BAD_LIST", atMs);', "پرتابِ outbox به BAD_LIST نگاشته می‌شود")
m(S, '!isRecord(r) || typeof r["ok"] !== "boolean"', '!isRecord(r)', "ok غیربولیِ پاسخ پذیرفته می‌شود")
m(S, '    if (r["ok"] === false) return fail("LIST_FAILED", atMs);', '', "خطای ok:false نادیده گرفته می‌شود")
m(S, '!Array.isArray(value) || value.length > s.sampleLimit', '!Array.isArray(value) || value.length > s.sampleLimit + 1', "یک بیش از سقف پذیرفته می‌شود")
m(S, '!Array.isArray(value) || value.length > s.sampleLimit', '!Array.isArray(value)', "بیش از سقف پذیرفته می‌شود")
m(S, '    if (agg === null || !agg.ok) return fail("BAD_LIST", atMs);', '    if (agg === null || !agg.ok) return fail("LIST_FAILED", atMs);', "فهرستِ بدشکل LIST_FAILED شمرده می‌شود")
m(S, 'truncated: agg.count === s.sampleLimit', 'truncated: agg.count > s.sampleLimit', "truncated هرگز true نمی‌شود")
m(S, '    return fail("BAD_LIST", atMs);\n  }\n}', '    return fail("LIST_FAILED", atMs);\n  }\n}', "پرتابِ داخلی LIST_FAILED شمرده می‌شود")
m(S, '    return fail("BAD_LIST", atMs);\n  }\n}', '    return fail("BAD_LIST", null);\n  }\n}', "ساعتِ نمونه در مسیرِ پرتابِ داخلی گم می‌شود")
m(S, '    return isTime(v) ? v : null;', '    return typeof v === "number" ? v : null;', "ساعتِ نامعتبر (NaN/منفی) پذیرفته می‌شود")
m(S, '      if (armed && r.kind !== "timeout") {', '      if (armed) {', "تایمرِ شلیک‌شده هم لغو می‌شود")
m(S, '      if (armed && r.kind !== "timeout") {', '      if (r.kind !== "timeout") {', "لغو بدونِ سنجشِ ساخته‌شدنِ تایمر")
m(S, '      if (armed && r.kind !== "timeout") {', '      if (false) {', "تایمر هرگز لغو نمی‌شود (نشت)")
m(S, '    const done = (r: Listed): void => {\n      if (settled) return;', '    const done = (r: Listed): void => {\n      if (settled && false) return;', "پایانِ دوباره مجاز است")
m(S, 'call = Promise.resolve(s.outbox.listUnacknowledgedDead(Object.freeze({ limit: s.sampleLimit })));', 'call = Promise.resolve(s.outbox.listUnacknowledgedDead({ limit: s.sampleLimit }));', "پرسش منجمد نیست")
m(S, 'call = Promise.resolve(s.outbox.listUnacknowledgedDead(Object.freeze({ limit: s.sampleLimit })));', 'call = Promise.resolve(s.outbox.listUnacknowledgedDead(Object.freeze({ limit: s.sampleLimit + 1 })));', "سقفِ خواندن یکی بیشتر داده می‌شود")
m(S, '    if (s.timer !== null) {\n      try {\n        handle = s.timer.after(() => done({ kind: "timeout" }), s.timeoutMs);', '    if (s.timer !== null) {\n      try {\n        handle = s.timer.after(() => done({ kind: "timeout" }), s.timeoutMs + 1);', "مهلت یک میلی‌ثانیه بلندتر ساخته می‌شود")
m(S, '        armed = true;\n      } catch {\n        done({ kind: "threw" });', '        armed = true;\n      } catch {\n        done({ kind: "timeout" });', "پرتابِ زمان‌سنج TIMEOUT شمرده می‌شود")
m(S, 'Object.freeze({ ok: false as const, atMs, code })', '({ ok: false as const, atMs, code })', "نمونهٔ ناموفق منجمد نیست")
m(S, '    byReason: Object.freeze(byReason) as BacklogByReason,', '    byReason: byReason as BacklogByReason,', "byReason نمونه منجمد نیست")
# ── config.ts
m(C, 'hasFns(outbox, ["listUnacknowledgedDead"])', 'hasFns(outbox, [])', "outbox بدونِ متدِ لازم پذیرفته می‌شود")
m(C, 'hasFns(clock, ["nowMs"])', 'hasFns(clock, [])', "clock بدونِ nowMs پذیرفته می‌شود")
m(C, 'if (dcOk && ucOk && degradedCount > downCount)', 'if (dcOk && ucOk && degradedCount >= downCount)', "برابریِ آستانه‌های شمار رد می‌شود")
m(C, 'if (dcOk && ucOk && degradedCount > downCount)', 'if (false)', "وارونگیِ آستانه‌های شمار پذیرفته می‌شود")
m(C, 'if (daOk && uaOk && degradedAfterMs > downAfterMs)', 'if (daOk && uaOk && degradedAfterMs >= downAfterMs)', "برابریِ آستانه‌های سن رد می‌شود")
m(C, 'if (daOk && uaOk && degradedAfterMs > downAfterMs)', 'if (false)', "وارونگیِ آستانه‌های سن پذیرفته می‌شود")
m(C, 'const dcOk = isIntIn(degradedCount, 1, limOk ? lim : SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);', 'const dcOk = isIntIn(degradedCount, 0, limOk ? lim : SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);', "degradedCount=0 مجاز می‌شود")
m(C, 'const dcOk = isIntIn(degradedCount, 1, limOk ? lim : SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);', 'const dcOk = isIntIn(degradedCount, 1, SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);', "degradedCount از sampleLimit بیشتر می‌شود")
m(C, 'const ucOk = isIntIn(downCount, 1, limOk ? lim : SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);', 'const ucOk = isIntIn(downCount, 1, SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);', "downCount از sampleLimit بیشتر می‌شود (بریدنِ فهرست آستانه را پنهان می‌کند)")
m(C, 'const ucOk = isIntIn(downCount, 1, limOk ? lim : SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);', 'const ucOk = isIntIn(downCount, 0, limOk ? lim : SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);', "downCount=0 مجاز می‌شود")
m(C, 'const daOk = isIntIn(degradedAfterMs, 1, maxAge);', 'const daOk = isIntIn(degradedAfterMs, 0, maxAge);', "degradedAfterMs=0 مجاز می‌شود")
m(C, 'const uaOk = isIntIn(downAfterMs, 1, maxAge);', 'const uaOk = isIntIn(downAfterMs, 1, maxAge + 1);', "downAfterMs فراتر از یک سال مجاز می‌شود")
m(C, 'const smOk = isIntIn(sampleMaxAgeMs, 1, maxAge);', 'const smOk = isIntIn(sampleMaxAgeMs, 0, maxAge);', "sampleMaxAgeMs=0 مجاز می‌شود")
m(C, 'const smOk = isIntIn(sampleMaxAgeMs, 1, maxAge);', 'const smOk = true;', "sampleMaxAgeMs اعتبارسنجی نمی‌شود")
m(C, 'const limOk = isIntIn(lim, 1, SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);', 'const limOk = isIntIn(lim, 0, SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);', "sampleLimit=0 مجاز می‌شود")
m(C, 'const limOk = isIntIn(lim, 1, SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);', 'const limOk = isIntIn(lim, 1, SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit + 1);', "sampleLimit بیش از سقفِ outbox مجاز می‌شود")
m(C, 'const lim = sampleLimitRaw === undefined ? SETTLEMENT_BACKLOG_LIMITS.defaultSampleLimit : sampleLimitRaw;', 'const lim = sampleLimitRaw === undefined || sampleLimitRaw === null ? SETTLEMENT_BACKLOG_LIMITS.defaultSampleLimit : sampleLimitRaw;', "sampleLimit=null پیش‌فرض می‌شود")
m(C, 'if (timer === undefined) issues.push("timeoutMs بدونِ timer معنا ندارد.");', 'if (false) issues.push("timeoutMs بدونِ timer معنا ندارد.");', "timeoutMs بدونِ timer پذیرفته می‌شود")
m(C, 'else if (!isIntIn(timeoutMs, 1, SETTLEMENT_BACKLOG_LIMITS.maxTimeoutMs))', 'else if (!isIntIn(timeoutMs, 0, SETTLEMENT_BACKLOG_LIMITS.maxTimeoutMs))', "timeoutMs=0 مجاز می‌شود")
m(C, 'else if (!isIntIn(timeoutMs, 1, SETTLEMENT_BACKLOG_LIMITS.maxTimeoutMs))', 'else if (!isIntIn(timeoutMs, 1, SETTLEMENT_BACKLOG_LIMITS.maxTimeoutMs + 1))', "timeoutMs بیش از سقف مجاز می‌شود")
m(C, 'if (hasFns(timer, ["after", "cancel"])) timerOk = timer as LoopTimer;', 'if (hasFns(timer, ["after"])) timerOk = timer as LoopTimer;', "timer بدونِ cancel پذیرفته می‌شود")
m(C, 'defaultTimeoutMs: 5_000,', 'defaultTimeoutMs: 6_000,', "مهلتِ پیش‌فرض تغییر می‌کند")
m(C, 'for (const k of Object.keys(raw)) if (!KEYS.has(k))', 'for (const k of Object.keys(raw)) if (false)', "کلیدِ ناشناخته پذیرفته می‌شود")
m(C, 'k.slice(0, 40)', 'k', "نامِ کلیدِ ناشناخته کوتاه نمی‌شود")
m(C, '  } catch {\n    return configError(["پیکربندی قابل‌خواندن نیست."]);', '  } catch {\n    return configError([]);', "پیامِ پیکربندیِ ناخوانا حذف می‌شود")
m(C, 'Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندی پایشِ پسماندِ زنگ نامعتبر است.", issues: Object.freeze([...issues]) })', '({ code: "INVALID_CONFIG" as const, message: "پیکربندی پایشِ پسماندِ زنگ نامعتبر است.", issues: [...issues] })', "خطای پیکربندی منجمد نیست")
# ── monitor.ts
m(K, 'evaluateBacklog(ctx, { sample, nowMs: safeNow(s.clock) })', 'evaluateBacklog(ctx, { sample, nowMs: sample.atMs ?? 0 })', "check از ساعتِ نمونه به‌جای ساعتِ لحظهٔ ارزیابی استفاده می‌کند")
m(K, 'const ctx = Object.freeze({ thresholds: s.thresholds, sampleLimit: s.sampleLimit });', 'const ctx = Object.freeze({ thresholds: s.thresholds, sampleLimit: s.sampleLimit + 1 });', "سقفِ ارزیابی با سقفِ نمونه‌گیری یکی نیست")
m(K, 'const monitor: BacklogMonitor = Object.freeze({', 'const monitor: BacklogMonitor = ({', "مانیتور منجمد نیست")

EQUIVALENT: dict[int, str] = {
    2: "`isRecord(null)` در `parseSample`: `null[\"ok\"]` پرتاب می‌کند و `evaluateBacklog` آن را به `INPUT_INVALID` می‌گیرد؛ رفتارِ بیرونی یکی است (دفاعِ چندلایه، نه رفتارِ جدا).",
    3: "`isRecord([])`: آرایه کلیدِ `ok` ندارد ⇒ `ok !== true` ⇒ `null`؛ در `parseByReason` هم `Object.keys` ≠ ۳ یا مقدارها `undefined` ⇒ `null`. رفتارِ بیرونی یکی است.",
    15: "`count < 0` زائد است: `undated ≥ 0` و `undated > count` برای countِ منفی همیشه رد می‌کند.",
    16: "`isSafeInteger(count)` برای عددِ اعشاری زائد است: جمعِ مقدارهای صحیحِ `byReason` هرگز با countِ اعشاری برابر نمی‌شود ⇒ رد.",
    21: "`count === sampleLimit` و `count >= sampleLimit` هم‌ارزند چون `count ≤ sampleLimit` پیش‌تر اجبار شده است.",
    25: "`ParsedSample` درونی است و `build()`/`evaluateRaw` فقط فیلدهای اعتبارسنجی‌شده را برمی‌دارند؛ فیلدِ اضافه هرگز به نتیجه نمی‌رسد (آزمونِ «فیلدهای اضافه» نشت را از همین راه می‌سنجد).",
    34: "حذفِ شاخهٔ `s === null`: بعدش `s.ok` روی `null` پرتاب می‌کند و `evaluateBacklog` همان `INPUT_INVALID` را می‌دهد؛ رفتارِ بیرونی یکی است.",
    73: "در این ترکیب اگر `settledAtMs` تهی باشد `oldest` یا از پیش تهی است (انتساب بی‌اثر) یا مقدارِ قبلی می‌ماند؛ هر دو همان نتیجهٔ نسخهٔ اصلی را می‌دهند.",
}

env = dict(os.environ)


def tests_pass(tests):
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *tests, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
sources = {f: open(os.path.join(ROOT, B, f), encoding="utf8").read() for f in {x[0] for x in M}}
for i, (f, old, new, why) in enumerate(M):  # پیش‌بازرسی
    n = sources[f].count(old)
    if n != 1:
        print(f"[{i}] قطعه {n} بار در {f} هست (باید دقیقاً یک بار): {old[:80]!r}"); sys.exit(2)
    if new == old:
        print(f"[{i}] جهش بی‌اثر است: {why}"); sys.exit(2)
if not tests_pass(TESTS):
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, B, f)
    open(path, "w", encoding="utf8").write(sources[f].replace(old, new, 1))
    try:
        ok = tests_pass(TESTS)
    finally:
        open(path, "w", encoding="utf8").write(sources[f])
    if ok and i not in EQUIVALENT:
        alive.append((i, f, why)); print(f"[{i:02d}] ✗ زنده ({f}): {why}", flush=True)
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
