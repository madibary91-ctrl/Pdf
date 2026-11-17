/**
 * نوع‌های محاسبهٔ سهم‌الارث (قانون مدنی، مواد ۸۶۱ تا ۹۴۹) — **فقط طبقهٔ اول + زوج/زوجه**.
 * این فایل فقط «شکل» داده را تعریف می‌کند؛ هیچ کسر، سهم یا شمارهٔ مادهٔ حقوقی اینجا نیست.
 * کسرها، شرط حجب و ارجاع‌ها در `inheritance-shares.ts` هستند.
 */
import type { ReviewInfo } from "./late-payment-types";

/** کسر ثابت قانونی به‌صورت [صورت، مخرج] (عدد صحیح مثبت). */
export type FractionPair = readonly [number, number];

/** شرط حجب مادر با وجود برادر/خواهر: «حداقل» این تعداد از هر جنس (هر یک از ردیف‌ها کافی است). */
export type SiblingThreshold = Readonly<{ brothers: number; sisters: number }>;

/** قاعده‌های سهم‌الارث؛ همه در فایل داده. */
export type InheritanceRules = Readonly<{
  review: ReviewInfo;
  sources: readonly string[];
  /** مواردی که موتور عمداً مدل نمی‌کند (برای نمایش به کاربر و حقوقدان) */
  notModeled: readonly string[];
  fractions: Readonly<{
    husbandWithoutDescendants: FractionPair;
    husbandWithDescendants: FractionPair;
    wifeWithoutDescendants: FractionPair;
    wifeWithDescendants: FractionPair;
    /** فرض هر یک از پدر و مادر وقتی میت فرزند (یا نوه) دارد */
    parentWithDescendants: FractionPair;
    /** فرض دختر منحصربه‌فرد (فرزند یگانه) */
    onlyDaughter: FractionPair;
    /** فرض مجموع دو دختر و بیشتر (در نبود پسر) */
    severalDaughters: FractionPair;
    /** سهم مادر در نبود فرزند و بدون حاجب (از «مابقی پس از زوج/زوجه») */
    motherWithoutDescendantsNoHajib: FractionPair;
    /** سهم مادر در نبود فرزند، با حاجب (از «مابقی پس از زوج/زوجه») */
    motherWithoutDescendantsWithHajib: FractionPair;
  }>;
  /** وزن سهم پسر و دختر در یک نسل (پسر دو برابر دختر) */
  maleFemaleWeights: Readonly<{ male: number; female: number }>;
  /** شرط حجب مادر (زنده‌بودن پدر هم لازم است؛ آن در کد است نه داده) */
  motherHajib: readonly SiblingThreshold[];
  /** حد فنی ورودی برای هر شمارنده (جلوگیری از ورودی‌های عظیم)؛ حقوقی نیست */
  maxCount: number;
  /** ارجاع مواد برای هر گام توضیح */
  refs: Readonly<{
    classOne: string;
    spouseShare: string;
    parentsOnly: string;
    childrenOnly: string;
    parentsWithDaughters: string;
    grandchildren: string;
    grandchildrenExcluded: string;
    deficiency: string;
    radd: string;
    hajib: string;
    wivesEqual: string;
  }>;
}>;

export type Sex = "male" | "female";

/**
 * خطِ نوه‌ها: فرزندی از میت که پیش از او فوت کرده و فرزندان (بی‌واسطهٔ او) زنده‌اند.
 * فقط یک سطح پشتیبانی می‌شود (نوه)؛ سطح عمیق‌تر خارج از دامنه است.
 */
export type GrandchildLine = Readonly<{
  /** جنسِ فرزندِ فوت‌شده (او که نوه‌ها «قائم‌مقامش»اند) */
  rootSex: Sex;
  grandsons: number;
  granddaughters: number;
}>;

/**
 * ورودیِ سهم‌الارث. همهٔ وارث‌ها باید «واجد شرایط ارث» باشند — موتور موانع ارث (قتل، کفر، لعان، ولدالزنا و…)،
 * زوجیت دائم و مواد ۹۴۳ تا ۹۴۵ را نمی‌سنجد؛ تشخیصشان با حقوقدان/کاربر است.
 */
export type InheritanceInput = Readonly<{
  /** شوهرِ زنده (متوفی زن است). با `wives > 0` هم‌زمان نامعتبر است. */
  husband: boolean;
  /** تعداد زوجه‌های زندهٔ دائمی (متوفی مرد است) */
  wives: number;
  father: boolean;
  mother: boolean;
  /** فرزندان بی‌واسطهٔ زنده (از هر ازدواج) */
  sons: number;
  daughters: number;
  /**
   * خط‌های نوه. فقط وقتی میت هیچ فرزند بی‌واسطهٔ زنده ندارد اثر دارد؛
   * وگرنه نوه‌ها ارث نمی‌برند و با سهم صفر گزارش می‌شوند.
   */
  grandchildLines?: readonly GrandchildLine[];
  /**
   * برادر/خواهرِ **ابوینی یا ابیِ** میت که (جز به سبب قتل) ممنوع از ارث نیستند.
   * فقط برای تشخیص «حاجب مادر» لازم است؛ در طبقهٔ اول خودشان ارث نمی‌برند. برادر/خواهر امی حساب نمی‌شود.
   */
  siblings?: Readonly<{ brothers: number; sisters: number }>;
  /** خالص ترکه به ریال (پس از کفن، دیون و وصیت نافذ؛ عدد صحیح امن). اختیاری. */
  estateRials?: number;
}>;

/** کسر دقیق و ساده‌شده؛ مقدارها رشتهٔ عدد صحیح (قابل‌سریال‌شدن). */
export type ExactFraction = Readonly<{ numerator: string; denominator: string }>;

export type ShareBasis =
  /** فرض (سهمِ معین) */
  | "fard"
  /** قرابت (باقی‌مانده) */
  | "qarabat"
  /** فرض به‌علاوهٔ رد (زیادی) */
  | "fard-and-radd"
  /** فرض با کاهش (نقص) */
  | "fard-reduced"
  /** ارث‌نبردن */
  | "excluded";

export type HeirRole = "husband" | "wife" | "father" | "mother" | "son" | "daughter" | "grandson" | "granddaughter";

export type HeirShare = Readonly<{
  /** کلید یکتا در همین نتیجه؛ مثل `wife`، `son`، `line-1:grandson` */
  key: string;
  role: HeirRole;
  /** برچسب فارسی گروه، مثل «پسر» یا «نوهٔ پسریِ خط ۱» */
  label: string;
  /** تعداد افراد این گروه */
  count: number;
  basis: ShareBasis;
  /** سهم کل گروه */
  groupFraction: ExactFraction;
  /** سهم هر نفر */
  perPersonFraction: ExactFraction;
  /** سهم هر نفر به ریال (کف؛ فقط اگر ترکه داده شده) */
  perPersonRials?: number;
  /** سهم کل گروه به ریال (کف؛ فقط اگر ترکه داده شده) */
  groupRials?: number;
  /** شمارهٔ خط نوه‌ها (از ۱) برای وارث‌های نوه */
  lineIndex?: number;
  note?: string;
}>;

export type InheritanceStep = Readonly<{ text: string; ref?: string }>;

export type InheritanceOutcome =
  | "no-descendants"
  | "with-sons"
  | "daughters-only-exact"
  | "daughters-only-radd"
  | "daughters-only-deficiency";

export type InheritanceResult = Readonly<{
  heirs: readonly HeirShare[];
  /** مجموع سهم‌ها همیشه «۱/۱» است (بررسی داخلی)؛ برای شفافیت در خروجی می‌آید. */
  total: ExactFraction;
  estateRials?: number;
  /** ریال‌های ته‌ماندهٔ تقسیم‌ناپذیر (ترکه − مجموع کف‌ها)؛ موتور آن را به هیچ‌کس نمی‌دهد. */
  unallocatedRials?: number;
  facts: Readonly<{
    hasDescendants: boolean;
    descendantsByRepresentation: boolean;
    motherHajib: boolean;
    outcome: InheritanceOutcome;
  }>;
  steps: readonly InheritanceStep[];
  review: ReviewInfo;
  rulesSources: readonly string[];
  notModeled: readonly string[];
}>;
