/**
 * منبعِ تازه‌شوندهٔ سیاستِ ابزار (ADR-0071، CT‑5c‑2c‑1): آخرین سیاستِ **معتبر** را همگام و بی‌I/O در اختیارِ مسیرِ داغ می‌گذارد.
 * - شکستِ خواندن/نگاشت نسخهٔ خوبِ قبلی را نگه می‌دارد (آخرین‌خوبِ‌شناخته)، اما فقط تا `maxStaleMs`؛ پس از آن `snapshot()` بسته می‌شود (`STALE`).
 * - هرگز بی‌صدا به پیش‌فرض‌های کد برنمی‌گردد؛ بدونِ بارِ موفق `NOT_LOADED`.
 * - نسخه عقب نمی‌رود؛ نسخهٔ یکسان با محتوای متفاوت رد می‌شود. تلاشِ هم‌زمان شریک است؛ تلاشِ بسیار قدیمی رها و نتیجه‌اش دورریخته می‌شود.
 * - هرگز نمی‌پرتابد و متنِ استثنای خواننده را نمی‌گیرد. ساعت فقط از پورتِ تزریقی؛ تایمر/محیط/شبکه ندارد.
 */
import { parseOptions } from "./config";
import { evaluate, type Held } from "./evaluate";
import type {
  PolicySnapshot,
  PolicySource,
  RefreshErrorCode,
  RefreshResult,
  SnapshotErrorCode,
  SnapshotResult,
  SourceConfigError,
  SourceHealth,
  SourceState,
} from "./types";

const REFRESH_MESSAGES: Readonly<Record<RefreshErrorCode, string>> = Object.freeze({
  INVALID_CLOCK: "ساعتِ تزریق‌شده مقدارِ معتبر نداد.",
  READ_FAILED: "خواندنِ سیاست ناموفق بود؛ نسخهٔ قبلی (اگر تازه باشد) می‌ماند.",
  STORED_POLICY_INVALID: "سیاستِ ذخیره‌شده با کدِ جاری معتبر نیست؛ نسخهٔ قبلی (اگر تازه باشد) می‌ماند.",
  INVALID_RESPONSE: "پاسخِ خواننده شکلِ معتبر نداشت.",
  PROJECTION_INVALID: "سیاستِ خوانده‌شده قابلِ نگاشت نبود.",
  VERSION_REGRESSED: "نسخهٔ خوانده‌شده از نسخهٔ نگه‌داشته‌شده عقب‌تر است؛ رد شد.",
  VERSION_CONTENT_MISMATCH: "همان نسخه محتوای دیگری داد؛ رد شد.",
  SUPERSEDED: "تلاشِ رهاشده بود؛ نتیجه دورریخته شد.",
});
const SNAPSHOT_MESSAGES: Readonly<Record<SnapshotErrorCode, string>> = Object.freeze({
  NOT_LOADED: "هنوز سیاستی با موفقیت بارگذاری نشده است.",
  STALE: "آخرین تأییدِ سیاست از سقفِ سنِ مجاز کهنه‌تر است.",
  CLOCK_INVALID: "ساعتِ تزریق‌شده معتبر یا یکنوا نیست.",
});

const rfail = (code: RefreshErrorCode): RefreshResult => ({ ok: false, error: Object.freeze({ code, message: REFRESH_MESSAGES[code] }) });
const sfail = (code: SnapshotErrorCode): SnapshotResult => ({ ok: false, error: Object.freeze({ code, message: SNAPSHOT_MESSAGES[code] }) });
const validNow = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

type Attempt = { id: number; startedAtMs: number; promise: Promise<RefreshResult> };

export function createPolicySource(options: unknown): { ok: true; value: PolicySource } | { ok: false; error: SourceConfigError } {
  const parsed = parseOptions(options);
  if (!parsed.ok) return parsed;
  const { read, now, maxStaleMs, refreshTimeoutMs } = parsed.value;

  let held: Held | null = null;
  let inflight: Attempt | null = null;
  let seq = 0;
  let failures = 0;
  let lastFailure: RefreshErrorCode | null = null;
  let lastAttemptAtMs: number | null = null;
  let lastSuccessAtMs: number | null = null;

  const readNow = (): number | null => {
    try {
      const v = now();
      return validNow(v) ? v : null;
    } catch {
      return null;
    }
  };

  const noteFailure = (code: RefreshErrorCode, at: number | null): RefreshResult => {
    failures += 1;
    lastFailure = code;
    if (at !== null) lastAttemptAtMs = at;
    return rfail(code);
  };

  async function run(attempt: Attempt): Promise<RefreshResult> {
    let raw: unknown;
    let readFailed = false;
    try {
      raw = await read();
    } catch {
      readFailed = true;
    }
    if (inflight === null || inflight.id !== attempt.id) return rfail("SUPERSEDED");
    inflight = null;
    if (readFailed) return noteFailure("READ_FAILED", attempt.startedAtMs);
    const d = evaluate(raw, held);
    if (d.kind === "reject") return noteFailure(d.code, attempt.startedAtMs);
    const c = d.candidate;
    const loadedAtMs = d.outcome === "unchanged" && held !== null ? held.loadedAtMs : attempt.startedAtMs;
    held = { version: c.version, source: c.source, projection: c.projection, fingerprint: c.fingerprint, drift: c.drift, loadedAtMs, confirmedAtMs: attempt.startedAtMs }; // داخلی؛ هرگز بیرون نمی‌رود (snapshot کپیِ یخ‌زده می‌دهد)
    failures = 0;
    lastFailure = null;
    lastAttemptAtMs = attempt.startedAtMs;
    lastSuccessAtMs = attempt.startedAtMs;
    return { ok: true, value: Object.freeze({ outcome: d.outcome, version: c.version }) };
  }

  function refresh(): Promise<RefreshResult> {
    const t = readNow();
    if (t === null) return Promise.resolve(noteFailure("INVALID_CLOCK", null));
    const cur = inflight;
    if (cur !== null && t >= cur.startedAtMs && t - cur.startedAtMs <= refreshTimeoutMs) return cur.promise;
    seq += 1;
    const attempt: Attempt = { id: seq, startedAtMs: t, promise: Promise.resolve(rfail("SUPERSEDED")) };
    inflight = attempt; // پیش از run: هر تلاشِ پیشین از همین لحظه رها شده است
    attempt.promise = run(attempt);
    return attempt.promise;
  }

  function classify(): { state: SourceState; ageMs: number | null } {
    if (held === null) return { state: "NOT_LOADED", ageMs: null };
    const t = readNow();
    if (t === null || t < held.confirmedAtMs) return { state: "CLOCK_INVALID", ageMs: null };
    const age = t - held.confirmedAtMs;
    return { state: age > maxStaleMs ? "STALE" : "FRESH", ageMs: age };
  }

  function snapshot(): SnapshotResult {
    const c = classify();
    if (c.state !== "FRESH" || held === null || c.ageMs === null) return sfail(c.state === "FRESH" ? "NOT_LOADED" : (c.state as SnapshotErrorCode));
    const h = held;
    const snap: PolicySnapshot = Object.freeze({
      version: h.version,
      source: h.source,
      projection: h.projection,
      drift: h.drift,
      loadedAtMs: h.loadedAtMs,
      confirmedAtMs: h.confirmedAtMs,
      ageMs: c.ageMs,
    });
    return { ok: true, value: snap };
  }

  function health(): SourceHealth {
    const c = classify();
    return Object.freeze({
      state: c.state,
      version: held === null ? null : held.version,
      ageMs: c.ageMs,
      drift: held === null ? null : held.drift,
      consecutiveFailures: failures,
      lastFailure,
      lastAttemptAtMs,
      lastSuccessAtMs,
    });
  }

  return { ok: true, value: Object.freeze({ refresh, snapshot, health }) };
}
