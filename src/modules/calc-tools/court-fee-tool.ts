/** ابزار `court_fee`: پوششِ نازکِ calculateCourtFee. هیچ نرخ/عددِ حقوقی اینجا نیست. */
import { COURT_FEE_STAGE_ORDER, calculateCourtFee, type CourtFeeInput } from "@/modules/legal-calc";
import { err } from "@/modules/shared-types";
import { lift, type ToolDef } from "./tool-def";
import { dateSchema, MAX_RIALS } from "./common";
import { deepFreeze, type SchemaObject } from "./schema";

const TIER_METHODS = ["progressive", "whole-amount"] as const;

const parameters: SchemaObject = deepFreeze({
  type: "object",
  description: "ورودیِ محاسبهٔ هزینهٔ دادرسی دعاوی مالی. مبلغ‌ها همیشه ریالِ عدد صحیح (لاتین) هستند.",
  properties: {
    date: dateSchema("تاریخ مبنا (جلالی)؛ فقط برای انتخاب جدولِ همان سال. سالِ بدون جدول خطا می‌دهد و جدولِ سال دیگر جایگزین نمی‌شود."),
    stage: {
      type: "string",
      description: "مرحلهٔ رسیدگی (بدوی، واخواهی، تجدیدنظر، فرجام، اعادهٔ دادرسی، اعتراض شخص ثالث).",
      enum: [...COURT_FEE_STAGE_ORDER],
    },
    claim: {
      type: "object",
      description: "بهای خواسته. kind=known همراه amountRials؛ kind=unknown وقتی بهای خواسته نامعلوم است (بدون amountRials).",
      properties: {
        kind: { type: "string", enum: ["known", "unknown"] },
        amountRials: { type: "integer", minimum: 0, maximum: MAX_RIALS, description: "بهای خواسته به ریال؛ فقط برای kind=known." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    tierMethod: {
      type: "string",
      enum: [...TIER_METHODS],
      description:
        "فقط وقتی لازم است که مبلغ از آستانهٔ نخست بگذرد؛ قانون ساکت است و حدس زده نمی‌شود. اگر کاربر روشن نکرده، از او بپرسید و خودتان انتخاب نکنید.",
    },
  },
  required: ["date", "stage", "claim"],
  additionalProperties: false,
});

export const courtFeeTool: ToolDef = {
  descriptor: deepFreeze({
    name: "court_fee",
    description:
      "هزینهٔ دادرسی دعاوی مالی را از جدولِ نسخه‌دارِ سیستم محاسبه می‌کند. هرگز مبلغ را از حافظهٔ خود نگویید؛ فقط خروجیِ این ابزار را بازگو کنید و حتماً وضعیت بازبینی (reviewPending) و یادداشت‌ها را همراه بیاورید.",
    parameters,
  }),
  run(args, deps) {
    const claim = args.claim as { kind: string; amountRials?: number };
    if (claim.kind === "known" && claim.amountRials === undefined) {
      return err("INVALID_INPUT", "«claim.amountRials» برای claim.kind=known الزامی است.");
    }
    if (claim.kind === "unknown" && claim.amountRials !== undefined) {
      return err("INVALID_INPUT", "«claim.amountRials» با claim.kind=unknown هم‌زمان مجاز نیست.");
    }
    const date = args.date as { year: number; month: number; day: number };
    const input: CourtFeeInput = {
      date: { year: date.year, month: date.month, day: date.day },
      stage: args.stage as CourtFeeInput["stage"],
      claim: claim.kind === "known" ? { kind: "known", amountRials: claim.amountRials as number } : { kind: "unknown" },
      ...(args.tierMethod === undefined ? {} : { tierMethod: args.tierMethod as NonNullable<CourtFeeInput["tierMethod"]> }),
    };
    return lift(calculateCourtFee(input, deps.courtFeeTariffs));
  },
};
