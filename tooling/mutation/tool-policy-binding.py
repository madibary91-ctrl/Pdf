#!/usr/bin/env python3
"""
آزمون جهشیِ «پیوند سیاست به دروازه» (ماژول tool-policy-binding؛ برش CT‑5c‑2c‑2b‑2a، ADR-0077): هر جهش یک تغییر کوچکِ معنادار در منبع است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  python3 tooling/mutation/tool-policy-binding.py            (همه)
       python3 tooling/mutation/tool-policy-binding.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22. به پایگاه نیاز ندارد؛ جزو CI نیست. فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/tool-policy-binding/"
TESTS = [B, "tooling/tool-policy-binding.integration.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


BD, VL = B + "binding.ts", B + "validate.ts"
FP = "const fingerprint = JSON.stringify(snap.projection);"
KEYS = "return keys.length === expected.length && expected.every((k) => keys.includes(k));"
# ── binding.ts
m(BD, 'if (highest !== null && snap.version < highest) return reject("VERSION_REGRESSED");', "", "عقب‌گردِ نسخه پذیرفته می‌شود")
m(BD, "if (highest !== null && snap.version < highest)", "if (highest !== null && snap.version <= highest)", "هم‌نسخه عقب‌گرد حساب می‌شود")
m(BD, 'if (current.fingerprint !== fingerprint) return reject("VERSION_CONTENT_MISMATCH");', "", "هم‌نسخهٔ ناهم‌محتوا پذیرفته می‌شود")
m(BD, FP, 'const fingerprint = "";', "هویتِ محتوا ثابت است")
m(BD, "        highest = snap.version;\n", "", "ترازو هرگز بالا نمی‌رود")
m(BD, 'if (entry.instance === null) return reject("BUILD_FAILED");', "", "شکستِ ساخت نادیده گرفته می‌شود")
m(BD, "if (current !== null && snap.version === current.version) {", "if (false) {", "هر acquire دوباره می‌سازد")
m(BD, 'if (typeof r === "object" && r !== null && r.ok === true) {', 'if (typeof r === "object" && r !== null) {', "ok:false ساخت موفق حساب می‌شود")
m(BD, 'if ((typeof v === "object" && v !== null) || typeof v === "function") built = { value: v as T };', "built = { value: v as T };", "نمونهٔ غیرِ شیء پذیرفته می‌شود")
m(BD, "if (built === null) buildFailures = buildFailures + 1;", "if (built === null) buildFailures = buildFailures;", "شمارندهٔ شکستِ ساخت نمی‌شمارد")
m(BD, "activations = activations + 1;\n", "", "شمارندهٔ فعال‌سازی نمی‌شمارد")
m(BD, "const previous = current !== null && current.instance !== null ? current.version : null;", "const previous = current !== null ? current.version : null;", "previous به نسخهٔ شکسته اشاره می‌کند")
m(BD, 'emit({ type: "policy.activated", version: snap.version, previousVersion: previous });', "", "رویدادِ activated نمی‌آید")
m(BD, "if (lastUnavailable !== reason) {", "if (true) {", "unavailable به‌ازای هر درخواست می‌آید")
m(BD, 'emit({ type: "policy.recovered", version: entry.version });', "", "رویدادِ recovered نمی‌آید")
m(BD, "        lastUnavailable = null;\n        emit", "        emit", "حالتِ unavailable پاک نمی‌شود")
m(BD, "void Promise.resolve(r).then(undefined, () => undefined);", "", "ردِ ناهمگامِ ناظر بلعیده نمی‌شود")
m(BD, "    } catch {\n      /* ناظر هرگز مسیرِ پول را نمی‌شکند */\n    }", "    } finally {\n    }", "پرتابِ ناظر مسیر را می‌شکند")
m(BD, "projection: snap.projection, instance: entry.instance.value }", "projection: { ...snap.projection }, instance: entry.instance.value }", "اجاره projectionِ یخ‌نشده می‌دهد")
m(BD, "return { ok: true, value: Object.freeze({ acquire, status }) };", "return { ok: true, value: { acquire, status } };", "پیوند یخ‌زده نیست")
m(BD, "value: Object.freeze({ version: snap.version,", "value: ({ version: snap.version,", "اجاره یخ‌زده نیست")
m(BD, "activeVersion: current !== null && current.instance !== null && lastUnavailable === null ? current.version : null,", "activeVersion: current !== null ? current.version : null,", "activeVersion شکست را نمی‌بیند")
m(BD, 'if (!isFn(snapshot)) issues.push("source.snapshot باید تابع باشد.");', "", "source بی‌snapshot پذیرفته می‌شود")
m(BD, 'if (!isFn(build)) issues.push("build باید تابع باشد.");', "", "build غیرتابع پذیرفته می‌شود")
m(BD, "if (observer !== undefined && !isFn(observer))", "if (false)", "observerِ غیرتابع پذیرفته می‌شود")
# ── validate.ts
m(VL, "if (!isRecord(raw) || !sameKeys(raw, Object.keys(SHAPE))) return null;", "if (!isRecord(raw)) return null;", "بخشِ اضافه/کم در projection پذیرفته می‌شود")
m(VL, "if (!isRecord(s) || !sameKeys(s, keys)) return null;", "if (!isRecord(s)) return null;", "کلیدِ اضافه/کمِ بخش پذیرفته می‌شود")
m(VL, KEYS, "return expected.every((k) => keys.includes(k));", "کلیدِ اضافه پذیرفته می‌شود")
m(VL, KEYS, "return keys.length === expected.length;", "کلیدِ جایگزین پذیرفته می‌شود")
m(VL, "return r.ok ? r.value : null;", "return r.ok ? (raw as never) : null;", "شیءِ خام به‌جای بازساخته برمی‌گردد")
m(VL, 'model: { name: g("service", "model"), timeoutMs: g("gatewayModel", "timeoutMs") },', 'model: { name: g("service", "model") },', "مهلتِ مدل به سیاست نمی‌رسد")
m(VL, ', reservationTtlMs: g("durable", "reservationTtlMs") },', " },", "ttl به سیاست نمی‌رسد")
m(VL, 'run: { totalTimeoutMs: g("service", "totalTimeoutMs"), ', "run: { ", "مهلتِ کل به سیاست نمی‌رسد")
m(VL, ', onUnknownCost: g("durable", "onUnknownCost") },', " },", "onUnknownCost به سیاست نمی‌رسد")
m(VL, ', maxOutputTokens: g("service", "maxOutputTokens") },', " },", "سقفِ توکن به سیاست نمی‌رسد")
m(VL, "loop: { ...read.loop },", "loop: {},", "کرانِ حلقه به سیاست نمی‌رسد")
m(VL, 'if ((version === 0) !== (source === "defaults")) return bad("SOURCE_INVALID");', "", "نسخهٔ ۰ با source ناهمخوان پذیرفته می‌شود")
m(VL, 'if (typeof drift !== "boolean") return bad("SOURCE_INVALID");', "", "driftِ بدنوع پذیرفته می‌شود")
m(VL, 'if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) return bad("SOURCE_INVALID");', 'if (typeof ageMs !== "number") return bad("SOURCE_INVALID");', "ageMsِ منفی/نامتناهی پذیرفته می‌شود")
m(VL, 'if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return bad("SOURCE_INVALID");', 'if (typeof version !== "number") return bad("SOURCE_INVALID");', "نسخهٔ ناصحیح/منفی پذیرفته می‌شود")
m(VL, 'if (source !== "defaults" && source !== "stored") return bad("SOURCE_INVALID");', "", "sourceِ ناشناخته پذیرفته می‌شود")
m(VL, 'if (ok !== true) return bad("SOURCE_INVALID");', "", "okِ غیرِ true موفقیت حساب می‌شود")
m(VL, 'return typeof code === "string" && SOURCE_CLOSED.includes(code) ? bad(code as PolicyUnavailableReason) : bad("SOURCE_INVALID");', "return bad(code as PolicyUnavailableReason);", "کدِ خطای ناشناخته عیناً عبور می‌کند")
m(VL, 'const SOURCE_CLOSED: readonly string[] = ["NOT_LOADED", "STALE", "CLOCK_INVALID"];', 'const SOURCE_CLOSED: readonly string[] = ["NOT_LOADED", "STALE"];', "CLOCK_INVALID شناخته نیست")
m(VL, 'if (projection === null) return bad("PROJECTION_INVALID");', "", "projectionِ نامعتبر عبور می‌کند")

EQUIVALENT = {28: "کلیدِ جایگزین (هم‌تعداد) پیش‌تر رد می‌شود: خواندنِ کلیدِ مورد‌انتظار undefined می‌دهد و projectToolPolicy آن را نامعتبر می‌داند؛ فقط شمارِ کلید لازم است تا کلیدِ اضافه رد شود"}
env = dict(os.environ)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
origs = {}
for i, (f, old, new, why) in enumerate(M):  # پیش‌بازرسی
    p = os.path.join(ROOT, f)
    origs.setdefault(f, open(p, encoding="utf8").read())
    if origs[f].count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد در {f}: {old[:80]!r}"); sys.exit(2)
    if new == old:
        print(f"[{i}] جهش بی‌اثر است: {why}"); sys.exit(2)
if not tests_pass():
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, f)
    open(path, "w", encoding="utf8").write(origs[f].replace(old, new, 1))
    try:
        ok = tests_pass()
    finally:
        open(path, "w", encoding="utf8").write(origs[f])
    if ok and i not in EQUIVALENT:
        alive.append((i, why)); print(f"[{i:02d}] ✗ زنده: {why}", flush=True)
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
