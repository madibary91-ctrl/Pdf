/**
 * طرحِ حقوق و سنجشِ حقوقِ مؤثر (خالص، داخلی؛ ADR-0081).
 *
 * `planStatements` دستورهای **همگراکننده** می‌سازد: ابتدا همهٔ حقِ نقش بر شِما، همهٔ جدول‌ها و دنباله‌های شِما گرفته می‌شود (`REVOKE ALL`)، سپس دقیقاً
 * قراردادِ زمانِ اجرا داده می‌شود. پس اجرای دوباره idempotent است و حقِ زیادیِ باقی‌مانده از اجراهای قبلی/دست‌کاری را هم پاک می‌کند.
 * تنها شناسه‌های اعتبارسنجی‌شده (`[a-z0-9_]`) با نقل‌قول در SQL می‌نشینند؛ هیچ مقدارِ محیطی در دستور نیست.
 *
 * سنجش روی **حقوقِ مؤثر** است (`has_*_privilege` شاملِ PUBLIC، عضویت و مالکیت)، نه روی ACLِ خام: حقی که از PUBLIC یا نقشِ دیگر می‌رسد هم دیده می‌شود.
 * ورودیِ `assess*` پاسخِ ناشناختهٔ پورت است و شکلش سخت‌گیرانه سنجیده می‌شود؛ بدشکل ⇒ `null` (فراخواننده `INTERNAL` می‌دهد، هرگز «خوب» نمی‌شود).
 */
import { CONTRACT_TABLES, RUNTIME_CONTRACT, SCHEMA_PRIVILEGES, TABLE_PRIVILEGES, type TableName } from "./contract";

const q = (name: string): string => `"${name}"`;

/** سقفِ سمتِ سرورِ اعمال = نیمِ مهلتِ کل (کف ۵۰۰ms): انتظارِ قفل معمولاً **پیش از** مهلتِ کلاینت در سرور برمی‌گردد و بک‌اندِ زامبیِ بعد از مهلت نمی‌ماند. */
export const serverTimeoutMs = (timeoutMs: number): number => Math.max(500, Math.floor(timeoutMs / 2));

export function planStatements(schema: string, role: string, timeoutMs: number): readonly string[] {
  const s = q(schema);
  const t = serverTimeoutMs(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000);
  const r = q(role);
  const tables = CONTRACT_TABLES.map((t) => `${s}.${q(t)}`);
  const out: string[] = [
    `SET LOCAL lock_timeout = ${t}`,
    `SET LOCAL statement_timeout = ${t}`,
    // یک اجراکنندهٔ هم‌زمان: GRANT/REVOKEِ هم‌زمان روی یک شیء «tuple concurrently updated» می‌دهد.
    `SELECT pg_advisory_xact_lock(hashtextextended('tool-policy-grants:apply:${schema}', 0))`,
    `REVOKE ALL ON SCHEMA ${s} FROM ${r}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM ${r}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM ${r}`,
    `GRANT ${RUNTIME_CONTRACT.schema.join(", ")} ON SCHEMA ${s} TO ${r}`,
  ];
  for (const [i, t] of CONTRACT_TABLES.entries()) out.push(`GRANT ${RUNTIME_CONTRACT.tables[t].join(", ")} ON TABLE ${tables[i] as string} TO ${r}`);
  return Object.freeze(out);
}

/** پرس‌وجوی ۱: امتیازهای نقش‌محور. صفر ردیف = نقش نیست. (پیش از دو پرس‌وجوی دیگر، چون `has_*_privilege` برای نقشِ ناموجود می‌پرتابد.) */
export const ROLE_SQL = `SELECT r.rolsuper AS super, r.rolcreaterole AS createrole, r.rolcreatedb AS createdb, r.rolbypassrls AS bypassrls, r.rolreplication AS replication
FROM pg_catalog.pg_roles r WHERE r.rolname = $1::name`;

/** پرس‌وجوی ۲ (`$1` نقش، `$2` شِما): حقوقِ مؤثرِ شِما + «مالک/عضوِ مالک». صفر ردیف = شِما نیست. */
export const SCHEMA_SQL = `SELECT p.priv AS privilege, pg_catalog.has_schema_privilege($1::name, n.oid, p.priv) AS granted, pg_catalog.pg_has_role($1::name, n.nspowner, 'USAGE') AS owner
FROM pg_catalog.pg_namespace n CROSS JOIN unnest(ARRAY['USAGE','CREATE']::text[]) AS p(priv)
WHERE n.nspname = $2::name ORDER BY p.priv`;

/** پرس‌وجوی ۳ (`$1` نقش، `$2` شِما): حقوقِ مؤثر روی **همهٔ** رابطه‌های شِما (جدول، نما، دنباله…)، نه فقط جدول‌های شناخته‌شده. */
export const RELATIONS_SQL = `SELECT c.relname::text AS relation, c.relkind::text AS kind, p.priv AS privilege,
  pg_catalog.has_table_privilege($1::name, c.oid, p.priv) AS granted, pg_catalog.pg_has_role($1::name, c.relowner, 'USAGE') AS owner
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[]) AS p(priv)
WHERE n.nspname = $2::name AND c.relkind IN ('r','p','v','m','f','S')
ORDER BY c.relname, p.priv`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `{ rows: [...] }` ← پاسخِ ناشناختهٔ پورت؛ شکلِ دیگر ⇒ `null`. */
export function rowsOf(resp: unknown): readonly unknown[] | null {
  if (!isObj(resp)) return null;
  const rows = resp["rows"];
  return Array.isArray(rows) ? rows : null;
}

/** یافته‌های نقش‌محور؛ `[]` = نقشِ امن. `null` = پاسخِ بدشکل. */
export function assessRole(resp: unknown): readonly string[] | null {
  const rows = rowsOf(resp);
  if (rows === null || rows.length > 1) return null;
  if (rows.length === 0) return ["role_missing"];
  const row = rows[0];
  if (!isObj(row)) return null;
  const flags: readonly (readonly [string, string])[] = [
    ["super", "role_superuser"],
    ["createrole", "role_createrole"],
    ["createdb", "role_createdb"],
    ["bypassrls", "role_bypassrls"],
    ["replication", "role_replication"],
  ];
  const out: string[] = [];
  for (const [key, finding] of flags) {
    const v = row[key];
    if (typeof v !== "boolean") return null;
    if (v) out.push(finding);
  }
  return out;
}

export type ObjectAssessment = Readonly<{
  /** شِما/جدولِ ناموجود (مهاجرت اجرا نشده). */
  pending: readonly string[];
  /** مالک/عضوِ مالک (با GRANT درست‌شدنی نیست). */
  owner: readonly string[];
  /** کم/زیاد نسبت به قرارداد. */
  drift: readonly string[];
}>;

const SCHEMA_ONLY_PENDING: ObjectAssessment = Object.freeze({ pending: Object.freeze(["schema_missing"]), owner: Object.freeze([]), drift: Object.freeze([]) });

type Fact = { granted: boolean };
function factsOf(rows: readonly unknown[], valid: ReadonlySet<string>, keyOf: (row: Record<string, unknown>) => string | null): Map<string, { owner: boolean; kind: string; privs: Map<string, Fact> }> | null {
  const out = new Map<string, { owner: boolean; kind: string; privs: Map<string, Fact> }>();
  for (const row of rows) {
    if (!isObj(row)) return null;
    const key = keyOf(row);
    const priv = row["privilege"];
    const granted = row["granted"];
    const owner = row["owner"];
    if (key === null || typeof priv !== "string" || !valid.has(priv) || typeof granted !== "boolean" || typeof owner !== "boolean") return null;
    const kind = typeof row["kind"] === "string" ? (row["kind"] as string) : "";
    let entry = out.get(key);
    if (entry === undefined) {
      entry = { owner, kind, privs: new Map() };
      out.set(key, entry);
    }
    if (entry.owner !== owner || entry.kind !== kind || entry.privs.has(priv)) return null; // ردیفِ ناسازگار/تکراری
    entry.privs.set(priv, { granted });
  }
  return out;
}

/** سنجشِ شِما (پرس‌وجوی ۲) و رابطه‌ها (پرس‌وجوی ۳) در برابرِ قرارداد. `null` = بدشکل. */
export function assessObjects(schemaResp: unknown, relationsResp: unknown): ObjectAssessment | null {
  const schemaRows = rowsOf(schemaResp);
  const relRows = rowsOf(relationsResp);
  if (schemaRows === null || relRows === null) return null;
  if (schemaRows.length === 0) return relRows.length === 0 ? SCHEMA_ONLY_PENDING : null; // شِمای ناموجود با رابطه‌ی موجود ناممکن است

  const schemaFacts = factsOf(schemaRows, new Set<string>(SCHEMA_PRIVILEGES), () => "schema");
  const relFacts = factsOf(relRows, new Set<string>(TABLE_PRIVILEGES), (row) => (typeof row["relation"] === "string" && row["relation"] !== "" ? (row["relation"] as string) : null));
  if (schemaFacts === null || relFacts === null) return null;
  const sc = schemaFacts.get("schema");
  if (sc === undefined || sc.privs.size !== SCHEMA_PRIVILEGES.length) return null;
  for (const e of relFacts.values()) if (e.privs.size !== TABLE_PRIVILEGES.length) return null;

  const pending: string[] = [];
  const owner: string[] = [];
  const drift: string[] = [];
  if (sc.owner) owner.push("owner:schema");
  for (const p of SCHEMA_PRIVILEGES) {
    const want = RUNTIME_CONTRACT.schema.includes(p);
    const have = (sc.privs.get(p) as Fact).granted;
    if (want && !have) drift.push(`missing:schema:${p}`);
    if (!want && have) drift.push(`excess:schema:${p}`);
  }

  for (const t of CONTRACT_TABLES) {
    const e = relFacts.get(t);
    if (e === undefined || e.kind !== "r") {
      pending.push(`relation_missing:${t}`);
      continue;
    }
    if (e.owner) owner.push(`owner:${t}`);
    for (const p of TABLE_PRIVILEGES) {
      const want = (RUNTIME_CONTRACT.tables[t as TableName] as readonly string[]).includes(p);
      const have = (e.privs.get(p) as Fact).granted;
      if (want && !have) drift.push(`missing:${t}:${p}`);
      if (!want && have) drift.push(`excess:${t}:${p}`);
    }
  }

  const known = new Set<string>(CONTRACT_TABLES);
  for (const [name, e] of relFacts) {
    if (known.has(name)) continue;
    if (e.owner || [...e.privs.values()].some((f) => f.granted)) {
      drift.push("unexpected_relation_access");
      break;
    }
  }
  return Object.freeze({ pending: Object.freeze(pending), owner: Object.freeze(owner), drift: Object.freeze(drift) });
}
