import type { InputProcessor, OutputProcessor } from "@mastra/core/processors";
import type { AutonomyLevel } from "@chaste/kernel";

const INJECTION_PATTERNS = [
  /ignore\s+(?:previous|all|above)\s+instructions/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /disregard\s+(?:your|the|all)\s+(?:rules|instructions|guidelines)/i,
  /system\s*:\s*/i,
  /jailbreak/i,
  /\bDAN\b/,
  /act\s+as\s+if\s+you\s+have\s+no\s+(?:rules|restrictions)/i,
];

function createInjectionDetector(): InputProcessor {
  return {
    id: "prompt-injection-detector",
    processInputStep: async (args) => {
      const { messages } = args;
      for (const msg of messages ?? []) {
        const text = typeof msg.content === "string" ? msg.content : "";
        for (const pattern of INJECTION_PATTERNS) {
          if (pattern.test(text)) {
            throw new Error(
              `Guardrail blocked potential prompt injection in message: ${msg.id ?? "unknown"}`,
            );
          }
        }
      }
    },
  };
}

function createModerationGuard(): InputProcessor {
  return {
    id: "moderation-guard",
    processInputStep: async () => {
      // Pass-through: moderation is checked at the API/agent level.
      // This processor exists as a hook point for future content policies.
    },
  };
}

function createOutputScrubber(): OutputProcessor {
  return {
    id: "system-prompt-scrubber",
    processOutputStream: async (args) => {
      // Pass-through: this processor is a hook point for future content policies.
      return args.part;
    },
  };
}

export async function getInputProcessors(autonomy: AutonomyLevel): Promise<InputProcessor[]> {
  const processors: InputProcessor[] = [];

  if (autonomy === "confirm" || autonomy === "guarded_auto" || autonomy === "full_autonomous") {
    processors.push(createInjectionDetector());
  }

  if (autonomy === "guarded_auto" || autonomy === "full_autonomous") {
    processors.push(createModerationGuard());
  }

  return processors;
}

export async function getOutputProcessors(autonomy: AutonomyLevel): Promise<OutputProcessor[]> {
  const processors: OutputProcessor[] = [];

  if (autonomy === "guarded_auto" || autonomy === "full_autonomous") {
    processors.push(createOutputScrubber());
  }

  return processors;
}
