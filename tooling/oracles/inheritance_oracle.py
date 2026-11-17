#!/usr/bin/env python3
"""
oracle مستقل برای تست‌های سهم‌الارث (legal-calc، طبقهٔ اول + زوج/زوجه).

⚠️ مرز اعتبار: این oracle را «عامل» از روی متن مواد ۸۶۱–۹۴۹ قانون مدنی نوشته است، نه حقوقدان. هدفش فقط این است که
موتور TypeScript را با «پیاده‌سازی دیگری، در زبان دیگری، با ساختار دیگری» (حساب کسر دقیق Python، جدول مورد‌به‌مورد و
بدون کد مشترک) مقایسه کند تا خطای برنامه‌نویسی پیدا شود. درستیِ خودِ قاعده‌ها را فقط حقوقدان تضمین می‌کند.

اجرا (از ریشهٔ مخزن):
    python3 tooling/oracles/inheritance_oracle.py > src/modules/legal-calc/fixtures/inheritance-oracle.json

خروجی: فهرست نمونه‌ها {input, expected} که expected نگاشت «کلید وارث → سهم کل گروه (رشتهٔ کسر)» است،
یا {"error": "OUT_OF_RANGE"} وقتی طبقهٔ اول وجود ندارد. همه چیز قطعی و بدون تصادف است.
"""
import itertools
import json
from fractions import Fraction as F

HALF, QUARTER, EIGHTH = F(1, 2), F(1, 4), F(1, 8)
SIXTH, THIRD, TWO_THIRDS = F(1, 6), F(1, 3), F(2, 3)


def mother_blocked(father, mother, brothers, sisters):
    """حاجب مادر: پدر زنده + (۲ برادر | ۱ برادر و ۲ خواهر | ۴ خواهر)"""
    if not (father and mother):
        return False
    return brothers >= 2 or (brothers >= 1 and sisters >= 2) or sisters >= 4


def oracle(c):
    husband, wives = c["husband"], c["wives"]
    father, mother = c["father"], c["mother"]
    sons, daughters, lines = c["sons"], c["daughters"], c.get("grandchildLines", [])
    brothers, sisters = c["siblings"]["brothers"], c["siblings"]["sisters"]

    # «فرزند» یعنی فرزند بی‌واسطهٔ زنده؛ خط‌های نوه فقط در نبود فرزند اثر دارند (ماده ۹۱۰ و ۹۱۱)
    direct = sons + daughters
    active_lines = [] if direct else lines
    desc = direct > 0 or len(active_lines) > 0
    if not desc and not (father or mother):
        return {"error": "OUT_OF_RANGE"}

    out = {}
    if husband:
        out["husband"] = QUARTER if desc else HALF
    if wives:
        out["wife"] = EIGHTH if desc else QUARTER
    spouse_total = sum(out.values(), F(0))

    blocked = mother_blocked(father, mother, brothers, sisters)

    if not desc:
        rest = 1 - spouse_total
        if father and mother:
            m = rest * (SIXTH if blocked else THIRD)
            out["mother"] = m
            out["father"] = rest - m
        elif father:
            out["father"] = rest
        else:
            out["mother"] = rest
    else:
        # «جایگاه»های فرزندی: هر فرزند یک جایگاه؛ در نبود فرزند، هر خط یک جایگاه با جنس فرزند فوت‌شده
        if direct:
            slots = ["m"] * sons + ["f"] * daughters
        else:
            slots = ["m" if ln["rootSex"] == "male" else "f" for ln in active_lines]
        n_m, n_f = slots.count("m"), slots.count("f")
        pf = {"father": SIXTH if father else F(0), "mother": SIXTH if mother else F(0)}
        fixed = spouse_total + pf["father"] + pf["mother"]
        if n_m:
            rest = 1 - fixed
            unit = rest / (2 * n_m + n_f)
            share = {"m": 2 * unit, "f": unit}
        else:
            dg = HALF if n_f == 1 else TWO_THIRDS
            total = fixed + dg
            if total > 1:  # نقص فقط بر دخترها
                dg_final = 1 - fixed
                pf_final = dict(pf)
            elif total == 1:
                dg_final = dg
                pf_final = dict(pf)
            else:  # رد: به نسبت فرض میان دخترها و پدر و مادرِ بدون حاجب؛ نه زوج/زوجه
                surplus = 1 - total
                pool = {"d": dg}
                if father:
                    pool["father"] = pf["father"]
                if mother and not blocked:
                    pool["mother"] = pf["mother"]
                den = sum(pool.values(), F(0))
                dg_final = dg + surplus * pool["d"] / den
                pf_final = dict(pf)
                for k in ("father", "mother"):
                    if k in pool:
                        pf_final[k] = pf[k] + surplus * pool[k] / den
            pf = pf_final
            share = {"m": F(0), "f": dg_final / n_f}
        if father:
            out["father"] = pf["father"]
        if mother:
            out["mother"] = pf["mother"]
        if direct:
            if sons:
                out["son"] = share["m"] * sons
            if daughters:
                out["daughter"] = share["f"] * daughters
        else:
            for i, ln in enumerate(active_lines, start=1):
                line_total = share["m" if ln["rootSex"] == "male" else "f"]
                w = 2 * ln["grandsons"] + ln["granddaughters"]
                if ln["grandsons"]:
                    out[f"line-{i}:grandson"] = line_total * 2 * ln["grandsons"] / w
                if ln["granddaughters"]:
                    out[f"line-{i}:granddaughter"] = line_total * ln["granddaughters"] / w
    # نوه‌های محروم از ارث (وجود فرزند بی‌واسطه): سهم صفر
    if direct:
        for i, ln in enumerate(lines, start=1):
            if ln["grandsons"]:
                out[f"line-{i}:grandson"] = F(0)
            if ln["granddaughters"]:
                out[f"line-{i}:granddaughter"] = F(0)
    return {k: f"{v.numerator}/{v.denominator}" for k, v in out.items()}


def sibling_states(father, mother, states):
    """برادر/خواهر فقط وقتی پدر و مادر هر دو زنده‌اند اثر دارند؛ در بقیه یک حالت کافی است."""
    return states if (father and mother) else [(0, 0)]


def cases():
    sib_states = [(0, 0), (1, 0), (2, 0), (1, 1), (1, 2), (0, 3), (0, 4), (3, 3)]
    spouse_states = [(False, 0), (True, 0), (False, 1), (False, 2)]
    for (h, w), fa, mo, sons, dau in itertools.product(
        spouse_states, [False, True], [False, True], range(3), range(4)
    ):
        for br, si in sibling_states(fa, mo, sib_states):
            yield {
                "husband": h, "wives": w, "father": fa, "mother": mo, "sons": sons, "daughters": dau,
                "siblings": {"brothers": br, "sisters": si},
            }
    # خط‌های نوه (بدون فرزند بی‌واسطه) و حالت‌های «نوه همراه فرزند» (محروم)
    line_sets = [
        [{"rootSex": "male", "grandsons": 1, "granddaughters": 0}],
        [{"rootSex": "female", "grandsons": 0, "granddaughters": 1}],
        [{"rootSex": "male", "grandsons": 1, "granddaughters": 1}],
        [{"rootSex": "female", "grandsons": 2, "granddaughters": 1}],
        [{"rootSex": "male", "grandsons": 1, "granddaughters": 2}, {"rootSex": "female", "grandsons": 1, "granddaughters": 1}],
        [{"rootSex": "female", "grandsons": 0, "granddaughters": 2}, {"rootSex": "female", "grandsons": 1, "granddaughters": 0}],
        [{"rootSex": "male", "grandsons": 2, "granddaughters": 0}, {"rootSex": "male", "grandsons": 0, "granddaughters": 1}, {"rootSex": "female", "grandsons": 1, "granddaughters": 1}],
    ]
    for (h, w), fa, mo, ls, (sons, dau) in itertools.product(
        [(False, 0), (True, 0), (False, 1), (False, 3)],
        [False, True],
        [False, True],
        line_sets,
        [(0, 0), (1, 0), (0, 1)],
    ):
        for br, si in sibling_states(fa, mo, [(0, 0), (1, 2)]):
            yield {
                "husband": h, "wives": w, "father": fa, "mother": mo, "sons": sons, "daughters": dau,
                "grandchildLines": ls, "siblings": {"brothers": br, "sisters": si},
            }


def main():
    data = [{"input": c, "expected": oracle(c)} for c in cases()]
    print(json.dumps(data, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
