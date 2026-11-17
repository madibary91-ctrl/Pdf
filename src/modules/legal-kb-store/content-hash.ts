/**
 * هش محتوای یک نسخه (داخلی؛ `versionContentHash` از index صادر می‌شود).
 *
 * چرا؟ «تأیید حقوقدان» یعنی «این متنِ مشخص را دیدم و درست است». اگر بین دیدن و ثبت تأیید، متن عوض شود (اصلاح هم‌زمان)،
 * تأیید نباید روی متن جدید بنشیند. پس هر کنش تغییردهنده هشِ متنی را می‌گیرد که بازبین دیده و با هش فعلی مقایسه می‌کند
 * (compare-and-set). هش فقط **متن و تبصره/بندها** (به ترتیب ذخیره) را می‌پوشاند؛ بازه و منبع و وضعیت بازبینی را نه.
 * قالب با برچسب نسخه (`v1`) قفل است: تغییر قالب = هش‌های قدیمیِ ثبت‌شده در ممیزی دیگر قابل مقایسه نیستند (تست قفل دارد).
 */
import { createHash } from "node:crypto";
import type { Subpart } from "@/modules/legal-kb-schema";

const HASH_RE = /^[0-9a-f]{64}$/;

export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

export function versionContentHash(content: Readonly<{ text: string; subparts: readonly Pick<Subpart, "kind" | "label" | "text">[] }>): string {
  const canonical = JSON.stringify(["kb-version-content/v1", content.text, content.subparts.map((s) => [s.kind, s.label, s.text])]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
