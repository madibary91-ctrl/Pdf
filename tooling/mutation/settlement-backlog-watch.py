#!/usr/bin/env python3
"""
آزمون جهشی «پایشِ زندهٔ پسماندِ زنگِ تسویه» (برش م۳‑ه‑۴‑الف‑۲‑۱؛ ADR-0042): هر جهش یک تغییر کوچکِ معنادار در یکی از فایل‌های منبعِ
`src/modules/settlement-backlog-watch/` است؛ آزمون‌های بی‌پایگاهِ همان ماژول باید قرمز شوند.
اجرا:  python3 tooling/mutation/settlement-backlog-watch.py            (همه)
       python3 tooling/mutation/settlement-backlog-watch.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22؛ پایگاه نمی‌خواهد؛ جزو CI نیست. فقط Python 3 استاندارد.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متنِ اصلیِ هر جهش دقیقاً یک بار در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement-backlog-watch/"
TESTS = [B + n for n in ("config.test.ts", "env.test.ts", "view.test.ts", "probe.test.ts", "watch.test.ts", "purity.test.ts")]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


W, V, P, C, N = "watch.ts", "view.ts", "probe.ts", "config.ts", "env.ts"

# ── watch.ts: حلقه، نسل‌ها، stop
m(W, '    if (g !== gen) return; // رهاشده: هیچ‌چیز را دست نمی‌زند.\n', '', "خواندنِ رهاشده کش را بازنویسی می‌کند و تایمر می‌سازد")
m(W, 'if (g !== gen) return;\n    reading = true;', 'reading = true;', "tick نسلِ قدیمی را رد نمی‌کند (زمان‌سنجِ لغوناپذیر حلقهٔ دوم می‌سازد)")
m(W, '    } catch {\n      phase = "stalled";\n    }', '    } catch {\n      phase = "running";\n    }', "شکستِ زمان‌سنج فاز را stalled نمی‌کند")
m(W, 'if (phase === "running") return Object.freeze({ started: false as const, reason: "ALREADY_RUNNING" as const });', 'if (phase === "running" && false) return Object.freeze({ started: false as const, reason: "ALREADY_RUNNING" as const });', "start دوم حلقهٔ دوم می‌سازد")
m(W, '      gen += 1;\n      reading = false;', '      reading = false;', "stop نسل را عوض نمی‌کند (پاسخِ دیرهنگام پس از stop کش را می‌نویسد)")
m(W, 'const abandonedRead = reading;', 'const abandonedRead = false;', "abandonedRead همیشه false است")
m(W, '      reading = false;\n      if (phase !== "idle")', '      if (phase !== "idle")', "reading پس از stop پاک نمی‌شود")
m(W, 'if (phase !== "idle") phase = "stopped";', 'phase = "stopped";', "stop پیش از start فاز را stopped می‌کند")
m(W, '      const abandonedRead = reading;\n      cancelTimer();', '      const abandonedRead = reading;', "stop زمان‌سنجِ فاصله را لغو نمی‌کند")
m(W, '    if (!hasHandle) return;\n    hasHandle = false;', '    hasHandle = false;', "لغوِ بی‌دستگیره (cancel با undefined)")
m(W, '        handle = h;\n        hasHandle = true;', '        handle = h;\n        hasHandle = false;', "دستگیره ثبت نمی‌شود (stop نمی‌تواند لغو کند)")
m(W, '        lastGood = sample as GoodSample;\n        failure = null;', '        lastGood = sample as GoodSample;', "نمونهٔ سالمِ بعدی failure را پاک نمی‌کند")
m(W, '    reading = false;\n    record(sample);', '    record(sample);', "reading پس از پایانِ خواندن پاک نمی‌شود")
m(W, '    record(sample);\n    schedule(g);', '    record(sample);', "پس از نمونه، نمونهٔ بعد زمان‌بندی نمی‌شود")
m(W, 'tick(g);\n      }, s.intervalMs);', 'tick(g);\n      }, s.intervalMs * 2);', "فاصلهٔ زمان‌بندی دو برابر می‌شود")
m(W, 'nowMs: readClock(s.clock)', 'nowMs: 0', "ساعتِ نما ثابت صفر است")
# ── view.ts
m(V, 'return failClosedView(i.phase, i.readyPolicy);', 'return failClosedView("idle", "report");', "استثنای ارزیاب ⇒ نمای شکستِ بسته با فاز/سیاستِ غلط")
m(V, '  try {\n    return buildView(i);\n  } catch {', '  try {\n    return buildView(i);\n  } catch (e) {\n    void e;', "catch با متغیر (نشتِ پیام ممکن می‌شود)")
m(V, 'failure === null ? ("unknown" as const) : ("degraded" as const)', '"ok" as const', "بی‌نمونه ok شمرده می‌شود")
m(V, 'failure === null ? ("unknown" as const) : ("degraded" as const)', '"unknown" as const', "بی‌نمونه با شکست degraded نمی‌شود")
m(V, 'failure === null ? ("unknown" as const) : ("degraded" as const)', '"degraded" as const', "بی‌نمونه و بی‌شکست degraded می‌شود (نه unknown)")
m(V, 'reasons: Object.freeze(failure === null ? [] : [UNREADABLE]),', 'reasons: Object.freeze([]),', "بی‌نمونه با شکست دلیل ندارد")
m(V, 'if (!reasons.some((r) => r.code === "SAMPLE_UNREADABLE")) reasons.push(UNREADABLE);', 'reasons.push(UNREADABLE);', "SAMPLE_UNREADABLE تکراری می‌شود")
m(V, 'if (!reasons.some((r) => r.code === "SAMPLE_UNREADABLE")) reasons.push(UNREADABLE);', '', "تلاشِ ناموفق دلیلی اضافه نمی‌کند")
m(V, 'if (status === "ok") status = "degraded";', 'status = "degraded";', "تلاشِ ناموفق down را به degraded تنزل می‌دهد")
m(V, 'if (status === "ok") status = "degraded";', '', "تلاشِ ناموفق روی نمونهٔ ok اثری ندارد")
m(V, '[...reasons.filter((r) => r.severity === "down"), ...reasons.filter((r) => r.severity !== "down")]', '[...reasons]', "مرتب‌سازیِ دلیل‌ها حذف می‌شود")
m(V, '[...reasons.filter((r) => r.severity === "down"), ...reasons.filter((r) => r.severity !== "down")]', '[...reasons.filter((r) => r.severity !== "down"), ...reasons.filter((r) => r.severity === "down")]', "degraded پیش از down می‌آید")
m(V, 'i.evaluate({ sample: lastGood, nowMs: i.nowMs })', 'i.evaluate({ sample: lastGood, nowMs: 0 })', "ارزیاب nowMs را نمی‌گیرد")
m(V, 'reasons: Object.freeze(ordered),', 'reasons: ordered,', "دلیل‌های نما منجمد نیستند")
m(V, '{ code: "SAMPLE_UNREADABLE" as const, severity: "degraded" as const }', '{ code: "SAMPLE_UNREADABLE" as const, severity: "down" as const }', "SAMPLE_UNREADABLE شدتِ down می‌گیرد")
m(V, '{ code: "INPUT_INVALID" as const, severity: "down" as const }', '{ code: "INPUT_INVALID" as const, severity: "degraded" as const }', "INPUT_INVALIDِ شکستِ بسته degraded است")
m(V, '    status: "down" as const,\n    reasons: Object.freeze([INVALID]),', '    status: "degraded" as const,\n    reasons: Object.freeze([INVALID]),', "نمای شکستِ بسته down نیست")
m(V, '    count: h.count,', '    count: null,', "count عبور نمی‌کند")
m(V, '    truncated: h.truncated,', '    truncated: null,', "truncated عبور نمی‌کند")
m(V, '    oldestAgeMs: h.oldestAgeMs,', '    oldestAgeMs: null,', "oldestAgeMs عبور نمی‌کند")
m(V, '    sampleAgeMs: h.sampleAgeMs,', '    sampleAgeMs: null,', "sampleAgeMs عبور نمی‌کند")
m(V, '    byReason: h.byReason,\n    failure,\n    readyPolicy,', '    byReason: null,\n    failure,\n    readyPolicy,', "byReason عبور نمی‌کند")
m(V, '    byReason: h.byReason,\n    failure,\n    readyPolicy,', '    byReason: h.byReason,\n    failure: null,\n    readyPolicy,', "failure عبور نمی‌کند")
# ── probe.ts
m(P, 'if (kind !== "ready" && kind !== "startup") return NONE;', 'if (kind !== "ready" && kind !== "startup" && kind !== "live") return NONE;', "live گزارش می‌شود")
m(P, 'const blocks = kind === "ready" && parsed !== null', 'const blocks = parsed !== null', "startup هم می‌تواند مسدود کند")
m(P, 'const blocks = kind === "ready" && parsed !== null', 'const blocks = kind === "ready"', "ready بی‌نگاه به وضعیت مسدود می‌کند")
m(P, '&& parsed.status === "down" &&', '&& parsed.status !== "ok" &&', "degraded هم ready را مسدود می‌کند")
m(P, '&& parsed.status === "down" &&', '&& parsed.status === "unknown" &&', "فقط unknown مسدود می‌کند")
m(P, 'parsed.policy === "gate_down";', 'parsed.policy !== "x";', "سیاستِ report هم مسدود می‌کند")
m(P, 'status: "unknown" as const, count: null, truncated: null, oldestAgeMs: null, reasons: Object.freeze([]), policy: "report" as const', 'status: "ok" as const, count: null, truncated: null, oldestAgeMs: null, reasons: Object.freeze([]), policy: "report" as const', "نمای خراب ok گزارش می‌شود")
m(P, 'const STATUSES: readonly string[] = ["ok", "degraded", "down", "unknown"];', 'const STATUSES: readonly string[] = ["ok", "degraded", "down"];', "unknown وضعیتِ معتبر نیست")
m(P, 'const POLICIES: readonly string[] = ["report", "gate_down"];', 'const POLICIES: readonly string[] = ["report"];', "gate_down سیاستِ معتبر نیست")
m(P, '  "AGE_UNKNOWN",\n];', '];', "AGE_UNKNOWN کدِ معتبر نیست")
m(P, 'const MAX_REASONS = 16;', 'const MAX_REASONS = 17;', "سقفِ دلیل‌ها ۱۷ است")
m(P, 'reasonsRaw.length > MAX_REASONS', 'reasonsRaw.length >= MAX_REASONS', "۱۶ دلیل رد می‌شود")
m(P, 'Number.isSafeInteger(v) && v >= 0;', 'Number.isSafeInteger(v);', "عددِ منفی پذیرفته می‌شود")
m(P, 'typeof v === "number" && Number.isSafeInteger(v) && v >= 0;', 'typeof v === "number" && v >= 0;', "عددِ اعشاری پذیرفته می‌شود")
m(P, '!(truncated === null || typeof truncated === "boolean") || ', '', "truncated اعتبارسنجی نمی‌شود")
m(P, '    return Object.freeze({ section, blocks });', '    return { section, blocks };', "نتیجه منجمد نیست")
m(P, 'reasons: Object.freeze(codes),', 'reasons: codes,', "کدهای دلیل منجمد نیستند")
m(P, 'if (typeof code !== "string" || !CODES.includes(code)) return null;', 'if (typeof code !== "string") return null;', "کدِ ناشناخته پذیرفته می‌شود")
# ── config.ts
m(C, '  degradedCount: 1,\n  downCount: 10,', '  degradedCount: 2,\n  downCount: 10,', "پیش‌فرضِ degradedCount عوض شد")
m(C, '  downCount: 10,\n  degradedAfterMs', '  downCount: 11,\n  degradedAfterMs', "پیش‌فرضِ downCount عوض شد")
m(C, '  degradedAfterMs: 3_600_000,\n  downAfterMs: 86_400_000,', '  degradedAfterMs: 3_000_000,\n  downAfterMs: 86_400_000,', "پیش‌فرضِ degradedAfterMs عوض شد")
m(C, '  downAfterMs: 86_400_000,\n  sampleLimit', '  downAfterMs: 80_000_000,\n  sampleLimit', "پیش‌فرضِ downAfterMs عوض شد")
m(C, '  intervalMs: 30_000,\n  timeoutMs: 5_000,', '  intervalMs: 60_000,\n  timeoutMs: 5_000,', "پیش‌فرضِ intervalMs عوض شد")
m(C, '  timeoutMs: 5_000,\n  degradedCount', '  timeoutMs: 10_000,\n  degradedCount', "پیش‌فرضِ timeoutMs عوض شد")
m(C, 'readyPolicy: "report" as BacklogReadyPolicy,\n});', 'readyPolicy: "gate_down" as BacklogReadyPolicy,\n});', "پیش‌فرضِ readyPolicy مسدودکننده شد")
m(C, 'const floor = intervalMs + 2 * timeoutMs;', 'const floor = intervalMs + timeoutMs;', "کفِ کهنگی سست شد")
m(C, '2 * intervalMs + 4 * timeoutMs', '2 * intervalMs + 2 * timeoutMs', "کهنگیِ پیش‌فرض کم شد")
m(C, 'else if (sampleMaxAgeMs < floor)', 'else if (sampleMaxAgeMs <= floor)', "کفِ کهنگی اکید شد")
m(C, '  minIntervalMs: 1,', '  minIntervalMs: 0,', "فاصلهٔ صفر پذیرفته می‌شود")
m(C, '  maxIntervalMs: 3_600_000,', '  maxIntervalMs: 3_600_001,', "سقفِ فاصله یکی بیشتر شد")
m(C, 'readyPolicies: Object.freeze(["report", "gate_down"] as const),', 'readyPolicies: Object.freeze(["report"] as const),', "gate_down پذیرفته نمی‌شود")
m(C, 'raw[key] === undefined ? dflt : raw[key]', 'raw[key] ?? dflt', "null مثلِ نبود پیش‌فرض می‌گیرد")
m(C, 'if (!WATCH_KEYS.includes(k)) issues.push', 'if (false) issues.push', "کلیدِ ناشناخته نادیده گرفته می‌شود")
m(C, 'JSON.stringify(k.slice(0, 40))', 'JSON.stringify(k)', "نامِ کلیدِ ناشناخته کوتاه نمی‌شود")
m(C, 'if (!made.ok) return configError(made.error.issues);', 'if (!made.ok) return configError([]);', "خطای مانیتور بی‌دلیل عبور می‌کند")
m(C, '      sampleMaxAgeMs,\n      sampleLimit,\n    });', '      sampleMaxAgeMs,\n    });', "sampleLimit به مانیتور نمی‌رسد")
m(C, '      timer,\n      timeoutMs,\n', '      timer,\n', "timeoutMs به مانیتور نمی‌رسد")
m(C, 'readyPolicy: policyRaw as BacklogReadyPolicy,\n      }),', 'readyPolicy: "report" as BacklogReadyPolicy,\n      }),', "readyPolicy نادیده گرفته می‌شود")
m(C, 'intervalMs: intervalMs as number,', 'intervalMs: 30_000,', "intervalMs نادیده گرفته می‌شود")
m(C, 'issues: Object.freeze([...issues]) }) };', 'issues: [...issues] }) };', "issues منجمد نیست")
m(C, 'hasFns(timer, ["after", "cancel"])', 'hasFns(timer, ["after"])', "cancel برای timer الزامی نیست")
# ── env.ts
m(N, '/^[1-9][0-9]{0,15}$/', '/^[0-9]{1,16}$/', "صفر و صفرِ پیشرو پذیرفته می‌شود")
m(N, '/^[1-9][0-9]{0,15}$/', '/^[1-9][0-9]{0,14}$/', "حدِّ رقم‌ها یکی کم است")
m(N, ' || !Number.isSafeInteger(Number(v))', '', "عددِ ناایمن پذیرفته می‌شود")
m(N, 'if (v === undefined || v === "") continue;', 'if (v === undefined) continue;', "رشتهٔ خالی خطاست")
m(N, 'if (k.startsWith(PREFIX) && !NAMES.includes(k))', 'if (!NAMES.includes(k))', "هر متغیرِ بی‌ربطِ محیط خطاست")
m(N, 'if (k.startsWith(PREFIX) && !NAMES.includes(k))', 'if (k.startsWith(PREFIX) && false)', "متغیرِ ناشناخته نادیده گرفته می‌شود")
m(N, 'if (p === "report" || p === "gate_down") out["readyPolicy"] = p;', 'if (p === "report") out["readyPolicy"] = p;', "gate_down از env پذیرفته نمی‌شود")
m(N, '  downCount: "SETTLEMENT_BACKLOG_DOWN_COUNT",', '  downCount: "SETTLEMENT_BACKLOG_DOWN_COUNTS",', "نامِ متغیرِ downCount عوض شد")
m(N, 'return { ok: true, value: Object.freeze(out) as BacklogEnvOverrides };', 'return { ok: true, value: out as BacklogEnvOverrides };', "خروجیِ env منجمد نیست")
m(N, 'out[key] = Number(v);', 'out[key] = Number(v) + 1;', "مقدارِ عددی دست‌کاری می‌شود")

# جهش‌های هم‌ارز (با دلیل): رفتارِ بیرونی یکی است و تنها به آزمونِ ساختگیِ زمان‌سنجِ همگام (که حلقهٔ بی‌پایان می‌سازد) فرق می‌کند.
EQUIVALENT = {}

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
