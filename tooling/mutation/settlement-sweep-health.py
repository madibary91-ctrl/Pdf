#!/usr/bin/env python3
"""
آزمون جهشی «ارزیابِ سلامتِ رفتگر» در ماژول settlement (برش م۳‑ه‑۱؛ ADR-0030): هر جهش یک تغییر کوچکِ معنادار در `health.ts` است؛ `health.test.ts` باید قرمز شود.
اجرا:  python3 tooling/mutation/settlement-sweep-health.py            (همه)
       python3 tooling/mutation/settlement-sweep-health.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22؛ آزمونِ این برش پایگاه نمی‌خواهد؛ جزو CI نیست. فقط Python 3 استاندارد.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل اصلی پس از هر جهش همیشه برمی‌گردد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement/"
F = "health.ts"
TESTS = [B + "health.test.ts"]
M = []


def m(old, new, why):
    M.append((old, new, why))


# ── جدول‌های مجاز
m("{ stopped: true, running: true, stopping: true, stalled: true }", "{ stopped: true, running: true, stopping: true }", "stalled از وضعیت‌های مجاز حذف می‌شود")
m("  DEAD_ACK_FAILED: true,\n};", "};", "یک نوعِ شکست از فهرستِ مجاز حذف می‌شود")
m("Object.prototype.hasOwnProperty.call(table, key)", "key in table", "کلیدهای prototype (toString/constructor) مجاز می‌شوند")
# ── اعتبارسنجی
m("typeof v === \"object\" && v !== null && !Array.isArray(v);", "typeof v === \"object\" && !Array.isArray(v);", "null شیء شمرده می‌شود")
m("typeof v === \"object\" && v !== null && !Array.isArray(v);", "typeof v === \"object\" && v !== null;", "آرایه شیء شمرده می‌شود")
m("typeof v === \"number\" && Number.isSafeInteger(v) && v >= 0;\nconst isCount", "typeof v === \"number\" && Number.isSafeInteger(v);\nconst isCount", "زمانِ منفی پذیرفته می‌شود")
m("typeof v === \"number\" && Number.isSafeInteger(v) && v >= 0;\nconst isCount", "typeof v === \"number\" && v >= 0;\nconst isCount", "زمانِ اعشاری/ناایمن پذیرفته می‌شود")
m("if (!isState(state) || !isCount(runs) || !isCount(consecutiveFailures)) return null;", "if (!isState(state) || !isCount(consecutiveFailures)) return null;", "runs اعتبارسنجی نمی‌شود")
m("if (!isState(state) || !isCount(runs) || !isCount(consecutiveFailures)) return null;", "if (!isState(state) || !isCount(runs)) return null;", "consecutiveFailures اعتبارسنجی نمی‌شود")
m("if (!isState(state) || !isCount(runs) || !isCount(consecutiveFailures)) return null;", "if (!isCount(runs) || !isCount(consecutiveFailures)) return null;", "state اعتبارسنجی نمی‌شود")
m("if (lastSuccessAtMs !== null && !isTime(lastSuccessAtMs)) return null;", "", "lastSuccessAtMs اعتبارسنجی نمی‌شود")
m("if (lastSuccessAtMs !== null && !isTime(lastSuccessAtMs)) return null;", "if (lastSuccessAtMs !== null && lastSuccessAtMs !== undefined && !isTime(lastSuccessAtMs)) return null;", "lastSuccessAtMs ناموجود (undefined) پذیرفته می‌شود")
m("if (lastFault !== null && !isFault(lastFault)) return null;", "", "lastFault اعتبارسنجی نمی‌شود (متنِ دلخواه به نتیجه می‌رسد)")
m("if (lastFault !== null && !isFault(lastFault)) return null;", "if (lastFault !== null && lastFault !== undefined && !isFault(lastFault)) return null;", "lastFault ناموجود (undefined) پذیرفته می‌شود")
m("return Object.freeze({ state, runs, consecutiveFailures, lastSuccessAtMs, lastFault });\n}", "return Object.freeze({ ...raw, state, runs, consecutiveFailures, lastSuccessAtMs, lastFault }) as ParsedStatus;\n}", "فیلدهای اضافهٔ status به نتیجه نشت می‌کنند")
# ── سکوت
m("const ref = ok === null ? sinceMs : sinceMs === null ? ok : Math.max(ok, sinceMs);", "const ref = ok === null ? sinceMs : ok;", "sinceMs پس از ریستارت نادیده گرفته می‌شود")
m("const ref = ok === null ? sinceMs : sinceMs === null ? ok : Math.max(ok, sinceMs);", "const ref = ok === null ? sinceMs : sinceMs === null ? ok : Math.min(ok, sinceMs);", "مرجع قدیمی‌ترین است نه دیرترین")
m("s.runs === 0 ? \"NOT_YET_RUN\" : \"NO_SUCCESS_SINCE_START\", \"degraded\")", "s.runs === 0 ? \"NO_SUCCESS_SINCE_START\" : \"NOT_YET_RUN\", \"degraded\")", "کدهای NOT_YET_RUN و NO_SUCCESS_SINCE_START جابه‌جا می‌شوند")
m("reason(s.runs === 0 ? \"NOT_YET_RUN\" : \"NO_SUCCESS_SINCE_START\", \"degraded\")], silenceMs: null", "reason(s.runs === 0 ? \"NOT_YET_RUN\" : \"NO_SUCCESS_SINCE_START\", \"down\")], silenceMs: null", "بی‌مرجع down می‌شود")
m("if (ref === null) return { reasons: [reason(s.runs === 0 ? \"NOT_YET_RUN\" : \"NO_SUCCESS_SINCE_START\", \"degraded\")], silenceMs: null };", "if (ref === null) return { reasons: [], silenceMs: null };", "بی‌مرجع ok شمرده می‌شود")
m("if (silence < 0) return", "if (silence < -1) return", "یک میلی‌ثانیه عقب‌ماندنِ ساعت CLOCK_BEHIND نمی‌شود")
m("if (silence < 0) return", "if (silence <= 0) return", "سکوتِ صفر CLOCK_BEHIND شمرده می‌شود")
m("if (silence < 0) return { reasons: [reason(\"CLOCK_BEHIND\", \"degraded\")], silenceMs: null };", "if (silence < 0) return { reasons: [reason(\"CLOCK_BEHIND\", \"down\")], silenceMs: null };", "CLOCK_BEHIND down می‌شود")
m("if (silence < 0) return { reasons: [reason(\"CLOCK_BEHIND\", \"degraded\")], silenceMs: null };", "if (silence < 0) return { reasons: [], silenceMs: null };", "عقب‌ماندنِ ساعت نادیده گرفته می‌شود")
m("const code: HealthReasonCode = ok !== null && ref === ok ?", "const code: HealthReasonCode = ok !== null ?", "کدِ دلیل همیشه STALE_SUCCESS است وقتی موفقیتی بوده")
m("ok !== null && ref === ok ? \"STALE_SUCCESS\" : \"NO_SUCCESS_SINCE_START\"", "\"STALE_SUCCESS\"", "کدِ NO_SUCCESS_SINCE_START هرگز تولید نمی‌شود")
m("if (silence > th.downAfterMs) return", "if (silence >= th.downAfterMs) return", "مرزِ down شاملِ برابری می‌شود")
m("if (silence > th.downAfterMs) return", "if (silence > th.downAfterMs + 1) return", "مرزِ down یک میلی‌ثانیه گشاد می‌شود")
m("if (silence > th.degradedAfterMs) return", "if (silence >= th.degradedAfterMs) return", "مرزِ degraded شاملِ برابری می‌شود")
m("if (silence > th.degradedAfterMs) return", "if (silence > th.degradedAfterMs + 1) return", "مرزِ degraded یک میلی‌ثانیه گشاد می‌شود")
m("return { reasons: [reason(code, \"degraded\")], silenceMs: silence };", "return { reasons: [reason(code, \"down\")], silenceMs: silence };", "باندِ degraded حذف می‌شود")
m("return { reasons: [], silenceMs: silence };\n}", "return { reasons: [], silenceMs: null };\n}", "سکوتِ سالم گزارش نمی‌شود")
# ── ساخت نتیجه
m("const sorted = [...reasons.filter((r) => r.severity === \"down\"), ...reasons.filter((r) => r.severity === \"degraded\")];", "const sorted = [...reasons.filter((r) => r.severity === \"degraded\"), ...reasons.filter((r) => r.severity === \"down\")];", "degraded پیش از down می‌آید")
m("const sorted = [...reasons.filter((r) => r.severity === \"down\"), ...reasons.filter((r) => r.severity === \"degraded\")];", "const sorted = [...reasons];", "مرتب‌سازیِ دلیل‌ها حذف می‌شود")
m("sorted.length === 0 ? \"ok\" : sorted[0]?.severity === \"down\" ? \"down\" : \"degraded\"", "sorted.length === 0 ? \"ok\" : \"degraded\"", "down هرگز وضعیتِ نهایی نیست")
m("sorted.length === 0 ? \"ok\" : sorted[0]?.severity === \"down\" ? \"down\" : \"degraded\"", "sorted.length === 0 ? \"ok\" : \"down\"", "هر دلیلی down است")
m("reasons: Object.freeze(sorted),", "reasons: sorted,", "فهرستِ دلیل‌ها منجمد نیست")
m("return Object.freeze({\n    status,", "return ({\n    status,", "نتیجه منجمد نیست")
m("const reason = (code: HealthReasonCode, severity: \"degraded\" | \"down\", fault: LoopFaultKind | null = null): HealthReason => Object.freeze({ code, severity, fault });", "const reason = (code: HealthReasonCode, severity: \"degraded\" | \"down\", fault: LoopFaultKind | null = null): HealthReason => ({ code, severity, fault });", "دلیل‌ها منجمد نیستند")
m("consecutiveFailures: s === null ? null : s.consecutiveFailures,", "consecutiveFailures: null,", "شمارندهٔ شکست در نتیجه نیست")
m("lastFault: s === null ? null : s.lastFault,\n    degradedAfterMs", "lastFault: null,\n    degradedAfterMs", "آخرین شکست در نتیجه نیست")
# ── ارزیابی
m("if (!isRecord(input)) return build(th, [reason(\"STATUS_INVALID\", \"down\"), reason(\"CLOCK_INVALID\", \"down\")], null, null);", "if (!isRecord(input)) return build(th, [reason(\"STATUS_INVALID\", \"down\")], null, null);", "ورودیِ غیرشیء فقط یک دلیل می‌دهد")
m("const since = sinceMs === undefined || sinceMs === null ? null : isTime(sinceMs) ? sinceMs : undefined;", "const since = sinceMs === undefined || sinceMs === null ? null : isTime(sinceMs) ? sinceMs : null;", "sinceMs نامعتبر نادیده گرفته می‌شود")
m("if (s === null) invalid.push(reason(\"STATUS_INVALID\", \"down\"));", "", "دلیلِ STATUS_INVALID ثبت نمی‌شود")
m("if (!isTime(nowMs) || since === undefined) invalid.push(reason(\"CLOCK_INVALID\", \"down\"));", "if (!isTime(nowMs)) invalid.push(reason(\"CLOCK_INVALID\", \"down\"));", "sinceMs نامعتبر دلیلِ CLOCK_INVALID نمی‌دهد")
m("if (s === null || !isTime(nowMs) || since === undefined) return build(th, invalid, null, s);", "if (s === null || !isTime(nowMs) || since === undefined) return build(th, invalid, null, null);", "حالتِ status در ساعتِ نامعتبر گم می‌شود")
m("return build(th, [reason(\"LOOP_STOPPED\", \"down\")], null, s);", "return build(th, [reason(\"LOOP_STOPPED\", \"degraded\")], null, s);", "stopped فقط degraded است")
m("return build(th, [reason(\"LOOP_STALLED\", \"down\")], null, s);", "return build(th, [reason(\"LOOP_STALLED\", \"degraded\")], null, s);", "stalled فقط degraded است")
m("return build(th, [reason(\"LOOP_STOPPING\", \"degraded\")], null, s);", "return build(th, [reason(\"LOOP_STOPPING\", \"down\")], null, s);", "stopping down است")
m("return build(th, [reason(\"LOOP_STOPPING\", \"degraded\")], null, s);", "return build(th, [], null, s);", "stopping سالم شمرده می‌شود")
m("if (s.consecutiveFailures > 0) out.push(", "if (s.consecutiveFailures > 1) out.push(", "نخستین شکست دیده نمی‌شود")
m("if (s.consecutiveFailures > 0) out.push(reason(\"LOOP_FAULTING\", \"degraded\", s.lastFault));", "if (s.consecutiveFailures > 0) out.push(reason(\"LOOP_FAULTING\", \"degraded\"));", "نوعِ شکست در دلیل نیست")
m("if (s.consecutiveFailures > 0) out.push(reason(\"LOOP_FAULTING\", \"degraded\", s.lastFault));", "if (s.consecutiveFailures > 0) out.push(reason(\"LOOP_FAULTING\", \"down\", s.lastFault));", "شکستِ پیاپی down است")
m("return build(th, [...out, ...sil.reasons], sil.silenceMs, s);", "return build(th, [...out], sil.silenceMs, s);", "سکوتِ رفتگر در حکم نمی‌آید")
m("return build(th, [...out, ...sil.reasons], sil.silenceMs, s);", "return build(th, [...sil.reasons], sil.silenceMs, s);", "شکستِ پیاپی در حکم نمی‌آید")
m("return build(th, [...out, ...sil.reasons], sil.silenceMs, s);", "return build(th, [...sil.reasons, ...out], sil.silenceMs, s);", "ترتیبِ قاعده‌ها در یک سطح برعکس می‌شود")
m("      return evaluateRaw(fixed, input);\n      } catch {\n        return build(fixed, [reason(\"STATUS_INVALID\", \"down\")], null, null);", "      return evaluateRaw(fixed, input);\n      } catch {\n        return build(fixed, [], null, null);", "پرتابِ داخلی ⇒ ok (شکستِ باز)")
# ── پیکربندی
m("const graceOk = isIntIn(grace, 2, max);", "const graceOk = isIntIn(grace, 1, max);", "graceMs=۱ پذیرفته می‌شود")
m("const graceOk = isIntIn(grace, 2, max);", "const graceOk = isIntIn(grace, 2, max + 1);", "سقفِ graceMs یکی بالا می‌رود")
m("Math.floor(grace / 2)", "Math.ceil(grace / 2)", "پیش‌فرضِ degraded گرد به بالا می‌شود")
m("Math.floor(grace / 2)", "grace", "پیش‌فرضِ degraded برابر grace می‌شود")
m("d === undefined ? (graceOk ? Math.floor(grace / 2) : null) : isIntIn(d, 1, max) ? d : null;", "d === undefined ? (graceOk ? Math.floor(grace / 2) : null) : isIntIn(d, 0, max) ? d : null;", "degradedAfterMs=۰ پذیرفته می‌شود")
m("u === undefined ? (graceOk ? grace : null) : isIntIn(u, 1, max) ? u : null;", "u === undefined ? (graceOk ? grace : null) : isIntIn(u, 0, max) ? u : null;", "downAfterMs=۰ پذیرفته می‌شود")
m("isIntIn(u, 1, max) ? u : null;", "isIntIn(u, 1, max + 1) ? u : null;", "سقفِ downAfterMs بالا می‌رود")
m("isIntIn(d, 1, max) ? d : null;", "isIntIn(d, 1, max + 1) ? d : null;", "سقفِ degradedAfterMs بالا می‌رود")
m("if (degraded !== null && down !== null && degraded > down) issues.push(", "if (degraded !== null && down !== null && degraded >= down) issues.push(", "degraded = down رد می‌شود")
m("if (degraded !== null && down !== null && degraded > down) issues.push(\"degradedAfterMs نباید از downAfterMs بیشتر باشد.\");", "", "degraded > down پذیرفته می‌شود")
m("const allowed = new Set([\"graceMs\", \"degradedAfterMs\", \"downAfterMs\"]);", "const allowed = new Set([\"graceMs\", \"degradedAfterMs\", \"downAfterMs\", \"policy\"]);", "کلیدِ ناشناخته پذیرفته می‌شود")
m("if (!isRecord(raw)) return configError([\"پیکربندی باید یک شیء ساده باشد.\"]);", "if (typeof raw !== \"object\") return configError([\"پیکربندی باید یک شیء ساده باشد.\"]);", "null/آرایه به‌عنوان پیکربندی پذیرفته می‌شود")
m("  } catch {\n    return configError([\"پیکربندی قابل‌خواندن نیست.\"]);", "  } catch {\n    return { ok: true, value: Object.freeze({ evaluate: () => { throw new Error(); } }) } as never;", "پیکربندیِ خراب پذیرفته می‌شود")
m("const check: SweepHealthCheck = Object.freeze({", "const check: SweepHealthCheck = ({", "ارزیاب منجمد نیست")
# ── کدِ HTTP
m("return status === \"ok\" || status === \"degraded\" ? 200 : 503;", "return status === \"down\" ? 503 : 200;", "نتیجهٔ خراب ⇒ ۲۰۰ (شکستِ باز)")
m("return status === \"ok\" || status === \"degraded\" ? 200 : 503;", "return status === \"ok\" ? 200 : 503;", "degraded ⇒ ۵۰۳")
m("return status === \"ok\" || status === \"degraded\" ? 200 : 503;", "return 200;", "همیشه ۲۰۰")
m("    return 503;\n  }\n}", "    return 200;\n  }\n}", "پرتابِ داخلی در کدِ HTTP ⇒ ۲۰۰")

EQUIVALENT: dict[int, str] = {
    14: "`ParsedStatus` فقط درونی است و `build()` از آن فقط `consecutiveFailures` و `lastFault` (هر دو اعتبارسنجی‌شده) را برمی‌دارد؛ فیلدِ اضافه هرگز به نتیجه نمی‌رسد و جهش رفتارِ قابل‌مشاهده‌ای ندارد (نشتِ خروجی را آزمونِ «فیلدهای اضافه» از همین راه می‌سنجد).",
}

env = dict(os.environ)


def tests_pass(tests):
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *tests, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
path = os.path.join(ROOT, B, F)
orig = open(path, encoding="utf8").read()
for i, (old, new, why) in enumerate(M):  # پیش‌بازرسی
    if orig.count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {old[:80]!r}"); sys.exit(2)
    if new == old:
        print(f"[{i}] جهش بی‌اثر است: {why}"); sys.exit(2)
if not tests_pass(TESTS):
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    open(path, "w", encoding="utf8").write(orig.replace(old, new, 1))
    try:
        ok = tests_pass(TESTS)
    finally:
        open(path, "w", encoding="utf8").write(orig)
    if ok and i not in EQUIVALENT:
        alive.append((i, why)); print(f"[{i:02d}] ✗ زنده: {why}", flush=True)
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
