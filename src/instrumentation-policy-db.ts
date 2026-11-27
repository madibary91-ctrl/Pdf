/**
 * استخرِ اختصاصیِ میزبانِ سیاستِ ابزار (ADR-0083؛ بستنِ شکافِ معماریِ ADR-0082).
 * تا امروز میزبان از استخرِ مشترکِ `@/db` (همان `DATABASE_URL`ِ کلِ برنامه) می‌خواند و نقشِ کمترینِ امتیازِ ADR-0081 در تولید قابلِ‌اتصال نبود.
 * این‌جا فقط **انتخابِ بازکننده** و ساختنِ استخرِ جدا است:
 *  - `POLICY_DATABASE_URL` تنظیم‌نشده یا خالی ⇒ بازکنندهٔ مشترکِ امروز **همان شیء** برمی‌گردد (رفتارِ امروز بی‌تغییر).
 *  - تنظیم‌شده ⇒ استخرِ جدا با همان رشته: اجارهٔ جدا، بستنِ مستقل، سقفِ اتصالِ کوچک، `application_name` ثابت. استخرِ مشترکِ `@/db` اصلاً بارگذاری نمی‌شود.
 *  - **شکست‌بسته:** رشتهٔ نامعتبر ⇒ بازکننده می‌پرتابد (⇒ `DATABASE_UNAVAILABLE`) و **هرگز** بی‌صدا به استخرِ مشترکِ پرامتیاز برنمی‌گردد؛
 *    کسی که رشتهٔ جدا داده انتظارِ کمترین امتیاز دارد. نبودنِ پایگاه با رشتهٔ جدا هم همین است (بازتلاشِ میزبان؛ نه جایگزینی).
 *  - نامِ متغیر عمداً بیرون از پیشوندِ `TOOL_POLICY_` است (bootstrap با `on` هر کلیدِ ناشناختهٔ آن پیشوند را رد می‌کند).
 *  - لاگ فقط رویدادِ بسته است: هرگز رشتهٔ اتصال، مقدارِ env یا متنِ خطای پایگاه (ممکن است نشانی/کاربر داشته باشد)؛ فقط کدِ کوتاهِ خطا.
 *  - `release` (شکستِ بوت) و `close` (خاموشیِ تمیز) هر دو استخر را (یک بار) می‌بندند: برخلافِ استخرِ مشترک، دیگری آن را نمی‌خواند و نبستنش اتصالِ نشتی است.
 *  - `pool.on("error")` همیشه نصب است؛ بدونِ آن، قطعِ یک اتصالِ بی‌کارِ پایگاه (ری‌استارت، لغوِ نقش) فرایند را با رویدادِ کنترل‌نشده می‌اندازد.
 * فقط سیم‌کشی است؛ رفتار با PostgreSQL واقعی در `tooling/tool-policy-dedicated-pool.pg.test.ts` سنجیده می‌شود.
 */

export const POLICY_DATABASE_URL_ENV = "POLICY_DATABASE_URL";
/** میزبان یک حلقهٔ رفرشِ سریالی است؛ دو اتصال برای هم‌زمانیِ پروبِ بوت و رفرش بس است. */
export const POLICY_POOL_MAX = 2;
export const POLICY_CONNECT_TIMEOUT_MS = 5_000;
/** در `pg_stat_activity` شناسایی و در آزمون‌ها شمارش می‌شود. */
export const POLICY_APPLICATION_NAME = "legal-platform-tool-policy";

export type PolicyPoolEvent =
  | Readonly<{ type: "pool.opened"; mode: "dedicated" }>
  | Readonly<{ type: "pool.closed" }>
  | Readonly<{ type: "pool.close-failed" }>
  | Readonly<{ type: "pool.error"; code: string }>
  | Readonly<{ type: "pool.config-invalid"; env: typeof POLICY_DATABASE_URL_ENV }>;

export type PolicyPoolOptions = Readonly<{
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  application_name: string;
}>;

export type PolicyPoolLike = Readonly<{
  end: () => Promise<unknown>;
  on: (event: "error", listener: (error: unknown) => void) => unknown;
}>;

export type PolicyPoolDriver = Readonly<{
  createPool: (options: PolicyPoolOptions) => PolicyPoolLike;
  wrap: (pool: PolicyPoolLike) => unknown;
}>;

export type OpenedPolicyDatabase = Readonly<{ db: unknown; close: () => Promise<void>; release: () => void }>;
export type PolicyDatabaseOpener = () => Promise<OpenedPolicyDatabase>;

export type SelectPolicyOpenerConfig = Readonly<{
  env: Readonly<Record<string, unknown>>;
  /** بازکنندهٔ مشترکِ امروز؛ وقتی رشتهٔ جدا نیست عیناً همین برمی‌گردد. */
  shared: PolicyDatabaseOpener;
  log: (event: PolicyPoolEvent) => unknown;
  /** پیش‌فرض: `pg` + `drizzle-orm/node-postgres` با بارگذاریِ تنبل. */
  driver?: () => Promise<PolicyPoolDriver>;
}>;

export const nodePostgresDriver = async (): Promise<PolicyPoolDriver> => {
  const [{ Pool }, { drizzle }] = await Promise.all([import("pg"), import("drizzle-orm/node-postgres")]);
  return {
    createPool: (options) => new Pool({ ...options }) as unknown as PolicyPoolLike,
    wrap: (pool) => drizzle(pool as never),
  };
};

/** فقط `postgres://` یا `postgresql://` و قابلِ‌تجزیه؛ مقدار هرگز در پیام یا لاگ نمی‌آید. */
export function isValidPolicyDatabaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value === "") return false;
  try {
    const u = new URL(value);
    return (u.protocol === "postgres:" || u.protocol === "postgresql:") && u.hostname !== "";
  } catch {
    return false;
  }
}

const safeLog = (log: (event: PolicyPoolEvent) => unknown, event: PolicyPoolEvent): void => {
  try {
    const r = log(event);
    if (typeof r === "object" && r !== null && typeof (r as { then?: unknown }).then === "function") Promise.resolve(r).then(undefined, () => undefined);
  } catch {
    // لاگِ خراب نباید بازکردن یا بستنِ استخر را بشکند.
  }
};

/** کدِ خطا فقط اگر کوتاه و از حروفِ لاتین/رقم/خط‌زیر باشد؛ وگرنه ثابت. هرگز `message`. */
const safeCode = (e: unknown): string => {
  const c = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof c === "string" && /^[A-Za-z0-9_]{1,16}$/.test(c) ? c : "UNKNOWN";
};

export function selectPolicyDatabaseOpener(config: SelectPolicyOpenerConfig): PolicyDatabaseOpener {
  const raw = config.env[POLICY_DATABASE_URL_ENV];
  if (raw === undefined || raw === "") return config.shared;
  const { log } = config;
  const load = config.driver ?? nodePostgresDriver;

  if (!isValidPolicyDatabaseUrl(raw)) {
    return () => {
      safeLog(log, { type: "pool.config-invalid", env: POLICY_DATABASE_URL_ENV });
      return Promise.reject(new Error("POLICY_DATABASE_URL_INVALID"));
    };
  }
  const url = raw;

  return async () => {
    const driver = await load();
    const pool = driver.createPool({
      connectionString: url,
      max: POLICY_POOL_MAX,
      connectionTimeoutMillis: POLICY_CONNECT_TIMEOUT_MS,
      application_name: POLICY_APPLICATION_NAME,
    });
    pool.on("error", (e) => safeLog(log, { type: "pool.error", code: safeCode(e) }));
    const db = driver.wrap(pool);
    let ended: Promise<void> | null = null;
    const end = (): Promise<void> => {
      if (ended === null) {
        ended = Promise.resolve()
          .then(() => pool.end())
          .then(
            () => safeLog(log, { type: "pool.closed" }),
            (e: unknown) => {
              safeLog(log, { type: "pool.close-failed" });
              throw e;
            },
          );
      }
      return ended;
    };
    safeLog(log, { type: "pool.opened", mode: "dedicated" });
    return { db, close: end, release: () => void end().catch(() => undefined) };
  };
}
