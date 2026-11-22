/** ابزار `late_payment`: پوششِ نازکِ calculateLatePayment (ماده ۵۲۲ ق.آ.د.م). هیچ شاخص/عددِ حقوقی اینجا نیست. */
import { calculateLatePayment, type LatePaymentInput } from "@/modules/legal-calc";
import { err } from "@/modules/shared-types";
import { dateSchema, MAX_RIALS } from "./common";
import { deepFreeze, type SchemaObject } from "./schema";
import { lift, type ToolDef } from "./tool-def";

const MANUAL_ONLY = ["baseIndex", "paymentIndex", "baseLabel", "paymentLabel"] as const;
const SERIES_ONLY = ["seriesId", "dueDate", "paymentDate"] as const;

const parameters: SchemaObject = deepFreeze({
  type: "object",
  description: "ورودیِ محاسبهٔ خسارت تأخیر تأدیه. اصل دین ریالِ عدد صحیح (لاتین) است.",
  properties: {
    principalRials: { type: "integer", minimum: 0, maximum: MAX_RIALS, description: "اصل دین به ریال." },
    index: {
      type: "object",
      description:
        "منبع شاخص. mode=manual: کاربر دو شاخصِ رسمی را داده (baseIndex و paymentIndex). mode=series: سریِ ثبت‌شده در سیستم با seriesId و دو تاریخ. شاخص را از حافظهٔ خود نسازید.",
      properties: {
        mode: { type: "string", enum: ["manual", "series"] },
        baseIndex: { type: "string", maxLength: 40, description: "شاخص زمان سررسید؛ رشتهٔ اعشاریِ لاتین مثل \"123.4\" (فقط manual)." },
        paymentIndex: { type: "string", maxLength: 40, description: "شاخص زمان تأدیه؛ رشتهٔ اعشاریِ لاتین (فقط manual)." },
        baseLabel: { type: "string", maxLength: 100, description: "برچسب اختیاری برای نمایش (فقط manual)." },
        paymentLabel: { type: "string", maxLength: 100, description: "برچسب اختیاری برای نمایش (فقط manual)." },
        seriesId: { type: "string", maxLength: 100, description: "شناسهٔ سریِ ثبت‌شده (فقط series)." },
        dueDate: dateSchema("تاریخ سررسید (فقط series)."),
        paymentDate: dateSchema("تاریخ تأدیه (فقط series)."),
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  required: ["principalRials", "index"],
  additionalProperties: false,
});

const has = (o: Record<string, unknown>, k: string): boolean => Object.hasOwn(o, k) && o[k] !== undefined;

export const latePaymentTool: ToolDef = {
  descriptor: deepFreeze({
    name: "late_payment",
    description:
      "خسارت تأخیر تأدیه (ماده ۵۲۲) را با شاخصِ رسمی محاسبه می‌کند. شرایطِ حقوقیِ ماده (دین پولی، مطالبه، تمکن، تغییر فاحش) را نمی‌سنجد و در یادداشت‌ها یادآوری می‌کند. هرگز عدد یا شاخص را از حافظهٔ خود نگویید؛ خروجی، وضعیت بازبینی و یادداشت‌ها را عیناً بیاورید.",
    parameters,
  }),
  run(args, deps) {
    const index = args.index as Record<string, unknown>;
    const forbidden = index.mode === "manual" ? SERIES_ONLY : MANUAL_ONLY;
    const required = index.mode === "manual" ? (["baseIndex", "paymentIndex"] as const) : SERIES_ONLY;
    const missing = required.filter((k) => !has(index, k));
    if (missing.length > 0) {
      return err("INVALID_INPUT", `برای index.mode=${String(index.mode)} این کلیدها الزامی‌اند: ${missing.map((k) => `«index.${k}»`).join("، ")}.`);
    }
    const extra = forbidden.filter((k) => has(index, k));
    if (extra.length > 0) {
      return err("INVALID_INPUT", `با index.mode=${String(index.mode)} این کلیدها مجاز نیستند: ${extra.map((k) => `«index.${k}»`).join("، ")}.`);
    }
    const d = (v: unknown) => {
      const x = v as { year: number; month: number; day: number };
      return { year: x.year, month: x.month, day: x.day };
    };
    const source: LatePaymentInput["index"] =
      index.mode === "manual"
        ? {
            mode: "manual",
            baseIndex: index.baseIndex as string,
            paymentIndex: index.paymentIndex as string,
            ...(has(index, "baseLabel") ? { baseLabel: index.baseLabel as string } : {}),
            ...(has(index, "paymentLabel") ? { paymentLabel: index.paymentLabel as string } : {}),
          }
        : { mode: "series", seriesId: index.seriesId as string, dueDate: d(index.dueDate), paymentDate: d(index.paymentDate) };
    const input: LatePaymentInput = { principalRials: args.principalRials as number, index: source };
    return lift(calculateLatePayment(input, deps.latePaymentSeries, deps.latePaymentRules));
  },
};
