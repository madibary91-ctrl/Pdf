import { describeOutboxContract } from "./outbox-contract";
import { createMemoryOutbox } from "./memory-outbox";

describeOutboxContract("memory", async () => ({ outbox: createMemoryOutbox() }));
