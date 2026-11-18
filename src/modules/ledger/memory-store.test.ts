import { createMemoryStore } from "./index";
import { describeStoreContract } from "./store-contract";

describeStoreContract("ذخیرهٔ حافظه‌ای", async () => ({ store: createMemoryStore() }));
