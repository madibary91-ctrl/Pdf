/** ردیف ← رکورد (داخلی). ردیفِ خوانده‌شده یک مرزِ ورودی است: هر ردیف با `parsePolicyRecord` بازسازی می‌شود و شکلِ خراب بسته می‌شکند. */
import { parsePolicyRecord, type PolicyVersionRecord } from "@/modules/tool-policy-admin";
import { corrupt } from "./errors";

/** ستون‌ها؛ bigint به `text` تبدیل می‌شود تا تفسیرِ آن در دستِ ما باشد نه درایور. */
export const RECORD_COLUMNS = "version::text AS version, overrides, policy, changes, source_kind, source_to_version::text AS source_to_version, actor, reason, created_at_ms::text AS created_at_ms";

const DIGITS = /^[0-9]{1,16}$/;

function intOf(v: unknown): number {
  if (typeof v !== "string" || !DIGITS.test(v)) throw corrupt("ستونِ عددیِ ردیفِ نسخه شکل نادرستی دارد.");
  return Number(v); // ≤ ۱۶ رقم؛ خارج از بازهٔ صحیحِ ایمن را `parsePolicyRecord` (isSafeInt) رد می‌کند
}

export function rowToRecord(row: Record<string, unknown> | undefined): PolicyVersionRecord {
  if (row === undefined || row === null || typeof row !== "object") throw corrupt("ردیفِ نسخه شکل نادرستی دارد.");
  const kind = row["source_kind"];
  const toVersion = row["source_to_version"];
  let source: unknown;
  if (kind === "set" && toVersion === null) source = { kind: "set" };
  else if (kind === "rollback" && toVersion !== null) source = { kind: "rollback", toVersion: intOf(toVersion) };
  else throw corrupt("منبعِ ردیفِ نسخه ناسازگار است.");
  const parsed = parsePolicyRecord({
    version: intOf(row["version"]),
    overrides: row["overrides"],
    policy: row["policy"],
    changes: row["changes"],
    source,
    actor: row["actor"],
    reason: row["reason"],
    createdAtMs: intOf(row["created_at_ms"]),
  });
  if (parsed === null) throw corrupt("ردیفِ نسخه با مرزِ رکورد نمی‌خواند.");
  return parsed;
}
