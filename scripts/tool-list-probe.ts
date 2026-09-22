import { buildRegistry } from "@/server/kernel";

const registry = buildRegistry((undefined as never)).scopedToModules(new Set(["purchasing", "inventory", "signals"]));
const caps = registry.forActor({
  type: "agent",
  id: crypto.randomUUID(),
  orgId: crypto.randomUUID(),
  permissions: new Set(["purchasing.read", "purchasing.write", "purchasing.post", "inventory.read", "inventory.write", "signals.read"]),
});
console.log(caps.map((c) => c.id).join("\n"));
console.log("total:", caps.length);
