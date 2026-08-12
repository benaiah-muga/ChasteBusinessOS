import type { AutonomyLevel } from "./autonomy.js";

export type ActorKind = "user" | "system" | "ai_assisted" | "api_key";

export interface Actor {
  kind: ActorKind;
  userId: string;
  organizationId: string;
  /** Present when AI is assisting a user — does not elevate permissions. */
  aiRunId?: string;
  /**
   * Identifier of the API-key principal when `kind === "api_key"`. Lets audit
   * attribute a request to a machine credential, not just its creator.
   */
  clientId?: string;
  displayName?: string;
  permissions: ReadonlySet<string>;
}

export interface RequestContext {
  actor: Actor;
  requestId: string;
  autonomy: AutonomyLevel;
  /** Wall clock injectable for tests */
  now: () => Date;
}

export function createRequestContext(partial: {
  actor: Actor;
  requestId?: string;
  autonomy?: AutonomyLevel;
  now?: () => Date;
}): RequestContext {
  return {
    actor: partial.actor,
    requestId: partial.requestId ?? crypto.randomUUID(),
    autonomy: partial.autonomy ?? "confirm",
    now: partial.now ?? (() => new Date()),
  };
}

export function actorHasPermission(actor: Actor, permission: string): boolean {
  if (actor.permissions.has("*")) return true;
  return actor.permissions.has(permission);
}
