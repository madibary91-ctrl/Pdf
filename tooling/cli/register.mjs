/** `node --import ./tooling/cli/register.mjs <فایل.ts>` — نصبِ حلقهٔ resolve (alias-loader.mjs) پیش از اجرای ورودی. */
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);
