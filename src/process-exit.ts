/**
 * هماهنگیِ خروجِ فرایند میان میزبان‌های فرایندی (ADR-0076 تصمیم ۷). وقتی ما صاحبِ سیگنالیم (`NEXT_MANUAL_SIG_HANDLE`)، هر میزبان (تسویه، سیاستِ ابزار)
 * پس از خاموشیِ خودش `exit` می‌زند؛ اولی که تمام شود فرایند را می‌کُشد و خاموشیِ دومی (و بستنِ استخر) را نیمه‌کاره می‌گذارد.
 *  - هر فراخوانی کدِ خودش را ثبت می‌کند؛ اگر هم‌تایی هنوز «در حالِ خاموشی» است فقط برمی‌گردد (هم‌تا خودش بعداً exit را صدا می‌زند).
 *  - آخرین نفر `exit(بیشینهٔ کدها)` می‌زند: شکستِ یکی (۱) هرگز با موفقیتِ دیگری (۰) پنهان نمی‌شود.
 *  - ایمنی از رقابت: `state="stopped"` و `exit` در یک بلوکِ همگامِ هر میزبان‌اند؛ پس دو میزبان نمی‌توانند هم‌زمان همدیگر را «در حالِ خاموشی» ببینند و هیچ‌کدام exit نزند.
 *  - هم‌تای گیرکرده نداریم: هر میزبان مهلتِ کلیِ خاموشی دارد؛ هم‌تایی که `stopping` نیست (idle/failed/running) منتظرش نمی‌مانیم.
 */
export function createCoordinatedExit(realExit: (code: number) => unknown, anyPeerStopping: () => boolean): (code: number) => void {
  const codes: number[] = [];
  return (code: number): void => {
    codes.push(Number.isInteger(code) ? code : 1);
    let waiting = false;
    try {
      waiting = anyPeerStopping();
    } catch {
      waiting = false; // پرسشِ خراب منتظرِ همیشگی نمی‌کند؛ خروج مهم‌تر است.
    }
    if (waiting) return;
    realExit(Math.max(...codes));
  };
}
