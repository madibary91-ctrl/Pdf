/**
 * اعتبارسنجی و «انجمادِ» پیکربندی. پیکربندی از JSON/محیط هم می‌آید، پس `unknown` فرض می‌شود.
 * کلید ناشناخته رد می‌شود: غلط املایی مثل `usageSInk` نباید ثبت مصرف را بی‌صدا خاموش کند.
 * نتیجه یک کپی ثابت است؛ ویرایشِ شیء ورودی پس از ساخت رفتار دروازه را عوض نمی‌کند.
 */
import { DEFAULT_TIMERS } from "./deadline";
import { parsePrice } from "./pricing";
import type { Clock, ModelProvider, PriceSpec, Timers, UsageSink } from "./types";

export const LIMITS = Object.freeze({
  maxTimeoutMs: 600_000,
  maxInputChars: 10_000_000,
  maxOutputTokens: 1_000_000,
  defaultTimeoutMs: 60_000,
  defaultSinkTimeoutMs: 5000,
});

const NAME_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
const CONFIG_KEYS: ReadonlySet<string> = new Set(["providers", "models", "clock", "timers", "usageSink", "defaultTimeoutMs", "sinkTimeoutMs"]);
const MODEL_KEYS: ReadonlySet<string> = new Set(["provider", "providerModel", "maxInputChars", "maxOutputTokens", "price", "timeoutMs"]);

export type ResolvedModel = Readonly<{
  name: string;
  provider: string;
  providerModel: string;
  maxInputChars: number;
  maxOutputTokens: number;
  price: PriceSpec | null;
  timeoutMs: number;
}>;

export type ResolvedConfig = Readonly<{
  providers: ReadonlyMap<string, ModelProvider>;
  models: ReadonlyMap<string, ResolvedModel>;
  clock: Clock;
  timers: Timers;
  usageSink: UsageSink | null;
  sinkTimeoutMs: number;
}>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isFn = (v: unknown): boolean => typeof v === "function";

/** تابع‌ها هنگام ساخت «گرفته» می‌شوند (bind)؛ جایگزین‌کردنِ بعدیِ متد روی شیء ورودی اثری ندارد. */
const snapshotProvider = (p: Record<string, unknown>): ModelProvider => {
  const complete = (p["complete"] as ModelProvider["complete"]).bind(p);
  return Object.freeze({ complete });
};

function readModel(name: string, v: unknown, providers: ReadonlyMap<string, ModelProvider>, defaultTimeoutMs: number, issues: string[]): ResolvedModel | null {
  const at = `models[${JSON.stringify(name)}]`;
  if (!isRecord(v)) {
    issues.push(`${at} باید شیء باشد.`);
    return null;
  }
  const before = issues.length;
  for (const k of Object.keys(v)) if (!MODEL_KEYS.has(k)) issues.push(`${at}: کلید ناشناخته ${JSON.stringify(k.slice(0, 40))}.`);
  const provider = v["provider"];
  if (typeof provider !== "string" || !providers.has(provider)) issues.push(`${at}.provider باید کلیدی از providers باشد.`);
  const providerModel = v["providerModel"];
  if (typeof providerModel !== "string" || providerModel.trim() === "" || providerModel.length > 200) issues.push(`${at}.providerModel باید متن غیرتهیِ ≤۲۰۰ نویسه باشد.`);
  if (!isIntIn(v["maxInputChars"], 1, LIMITS.maxInputChars)) issues.push(`${at}.maxInputChars باید عدد صحیح ۱ تا ${LIMITS.maxInputChars} باشد.`);
  if (!isIntIn(v["maxOutputTokens"], 1, LIMITS.maxOutputTokens)) issues.push(`${at}.maxOutputTokens باید عدد صحیح ۱ تا ${LIMITS.maxOutputTokens} باشد.`);
  if (v["timeoutMs"] !== undefined && !isIntIn(v["timeoutMs"], 1, LIMITS.maxTimeoutMs)) issues.push(`${at}.timeoutMs باید عدد صحیح ۱ تا ${LIMITS.maxTimeoutMs} باشد.`);
  let price: PriceSpec | null = null;
  if (!("price" in v)) {
    issues.push(`${at}.price باید صریح باشد (شیء قیمت، یا null برای «بدون قیمت»).`);
  } else if (v["price"] !== null) {
    const p = parsePrice(v["price"]);
    if (p.ok) price = p.value;
    else for (const i of p.issues) issues.push(`${at}.${i}`);
  }
  if (issues.length > before) return null;
  return Object.freeze({
    name,
    provider: provider as string,
    providerModel: providerModel as string,
    maxInputChars: v["maxInputChars"] as number,
    maxOutputTokens: v["maxOutputTokens"] as number,
    price,
    timeoutMs: v["timeoutMs"] === undefined ? defaultTimeoutMs : (v["timeoutMs"] as number),
  });
}

export function resolveConfig(input: unknown): Readonly<{ ok: true; value: ResolvedConfig }> | Readonly<{ ok: false; issues: readonly string[] }> {
  try {
    if (!isRecord(input)) return { ok: false, issues: ["پیکربندی باید شیء باشد."] };
    const issues: string[] = [];
    for (const k of Object.keys(input)) if (!CONFIG_KEYS.has(k)) issues.push(`کلید ناشناختهٔ ${JSON.stringify(k.slice(0, 40))} در پیکربندی (مجاز: ${[...CONFIG_KEYS].join("، ")}).`);

    const providers = new Map<string, ModelProvider>();
    const rawProviders = input["providers"];
    if (!isRecord(rawProviders) || Object.keys(rawProviders).length === 0) {
      issues.push("providers باید شیءِ غیرتهی باشد.");
    } else {
      for (const name of Object.keys(rawProviders)) {
        const p = rawProviders[name];
        if (!NAME_RE.test(name)) issues.push(`نام ارائه‌دهنده ${JSON.stringify(name.slice(0, 40))} نامعتبر است.`);
        else if (!isRecord(p) || !isFn(p["complete"])) issues.push(`providers[${JSON.stringify(name)}] باید تابع complete داشته باشد.`);
        else providers.set(name, snapshotProvider(p));
      }
    }

    const rawClock = input["clock"];
    let clock: Clock | null = null;
    if (!isRecord(rawClock) || !isFn(rawClock["nowMs"])) issues.push("clock با تابع nowMs الزامی است (ساعت سیستم پیش‌فرض ندارد).");
    else clock = Object.freeze({ nowMs: (rawClock["nowMs"] as Clock["nowMs"]).bind(rawClock) });

    let timers: Timers = DEFAULT_TIMERS;
    if (input["timers"] !== undefined) {
      const t = input["timers"];
      if (!isRecord(t) || !isFn(t["setTimeout"]) || !isFn(t["clearTimeout"])) issues.push("timers باید setTimeout و clearTimeout داشته باشد.");
      else {
        const setT = (t["setTimeout"] as Timers["setTimeout"]).bind(t);
        const clearT = (t["clearTimeout"] as Timers["clearTimeout"]).bind(t);
        timers = Object.freeze({ setTimeout: setT, clearTimeout: clearT });
      }
    }

    let usageSink: UsageSink | null = null;
    if (input["usageSink"] !== undefined) {
      const s = input["usageSink"];
      if (!isRecord(s) || !isFn(s["record"])) issues.push("usageSink باید تابع record داشته باشد.");
      else usageSink = Object.freeze({ record: (s["record"] as UsageSink["record"]).bind(s) });
    }

    const dt = input["defaultTimeoutMs"];
    if (dt !== undefined && !isIntIn(dt, 1, LIMITS.maxTimeoutMs)) issues.push(`defaultTimeoutMs باید عدد صحیح ۱ تا ${LIMITS.maxTimeoutMs} باشد.`);
    const defaultTimeoutMs = typeof dt === "number" ? dt : LIMITS.defaultTimeoutMs;
    const st = input["sinkTimeoutMs"];
    if (st !== undefined && !isIntIn(st, 1, LIMITS.maxTimeoutMs)) issues.push(`sinkTimeoutMs باید عدد صحیح ۱ تا ${LIMITS.maxTimeoutMs} باشد.`);
    const sinkTimeoutMs = typeof st === "number" ? st : LIMITS.defaultSinkTimeoutMs;

    const models = new Map<string, ResolvedModel>();
    const rawModels = input["models"];
    if (!isRecord(rawModels) || Object.keys(rawModels).length === 0) {
      issues.push("models باید شیءِ غیرتهی باشد.");
    } else {
      for (const name of Object.keys(rawModels)) {
        if (!NAME_RE.test(name)) {
          issues.push(`نام مدل ${JSON.stringify(name.slice(0, 40))} نامعتبر است.`);
          continue;
        }
        const m = readModel(name, rawModels[name], providers, defaultTimeoutMs, issues);
        if (m !== null) models.set(name, m);
      }
    }

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: Object.freeze({ providers, models, clock: clock as Clock, timers, usageSink, sinkTimeoutMs }) };
  } catch {
    return { ok: false, issues: ["پیکربندی قابل خواندن نیست."] };
  }
}
