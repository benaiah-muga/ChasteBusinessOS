import { describe, expect, it } from "vitest";
import { ALL_MODULE_IDS, MODULE_CATALOG, resolveEnabledModules } from "@/app/(app)/_shell/modules";
import { APPS, appByHref, appsForOrg, resolveApp, tileStyle } from "@/app/(app)/_shell/apps";
import {
  ONBOARDING_STEPS as CLIENT_STEPS,
  PATH_META,
  PATH_ORDER,
  STEP_META,
} from "@/lib/onboarding-plan";
import { ONBOARDING_STEPS as SERVER_STEPS } from "@/server/onboarding";

/**
 * The catalogs are data, which is exactly why they rot quietly: a new app or
 * module lands with a typo in its `moduleId`, and the tile simply never appears
 * for anyone. Nothing fails, nothing logs, and the feature is invisible.
 *
 * These tests hold the catalogs to the shape the shell, the command palette and
 * the module switchboard all assume. They are cheap, and they are the only
 * thing standing between a one-character mistake and a missing feature.
 */

describe("module catalog", () => {
  it("has unique module ids", () => {
    expect(new Set(ALL_MODULE_IDS).size).toBe(ALL_MODULE_IDS.length);
  });

  it("gives every module a label and a description", () => {
    for (const m of MODULE_CATALOG) {
      expect(m.label.length, m.id).toBeGreaterThan(0);
      expect(m.description.length, m.id).toBeGreaterThan(0);
    }
  });

  it("points every routable module at an absolute in-app path", () => {
    for (const m of MODULE_CATALOG) {
      if (m.href === null) continue;
      expect(m.href.startsWith("/"), m.id).toBe(true);
    }
  });

  it("leaves headless modules explicitly null rather than guessing a route", () => {
    expect(MODULE_CATALOG.find((m) => m.id === "skills")?.href).toBeNull();
  });
});

describe("app catalog", () => {
  it("has unique ids", () => {
    expect(new Set(APPS.map((a) => a.id)).size).toBe(APPS.length);
  });

  it("has unique hrefs, so the rail never highlights two tiles for one route", () => {
    expect(new Set(APPS.map((a) => a.href)).size).toBe(APPS.length);
  });

  it("points every app at an absolute in-app path", () => {
    for (const a of APPS) expect(a.href.startsWith("/"), a.id).toBe(true);
  });

  it("gives every app a name and a tagline", () => {
    for (const a of APPS) {
      expect(a.name.length, a.id).toBeGreaterThan(0);
      expect(a.tagline.length, a.id).toBeGreaterThan(0);
    }
  });

  /* A moduleId the switchboard has never heard of means the app is filtered
     out for every org — shipped, but permanently invisible. */
  it("gates every app on a module the catalog actually knows", () => {
    for (const a of APPS) {
      if (!a.moduleId) continue;
      expect(ALL_MODULE_IDS, `${a.id} gates on unknown module ${a.moduleId}`).toContain(a.moduleId);
    }
  });

  it("never gates a system app on a module", () => {
    for (const a of APPS.filter((x) => x.system)) expect(a.moduleId).toBeUndefined();
  });

  it("gives every launchable module a tile in the catalog", () => {
    const appHrefs = new Set(APPS.map((a) => a.href));
    for (const m of MODULE_CATALOG) {
      if (m.href === null) continue;
      expect(appHrefs, `module ${m.id} has no app tile at ${m.href}`).toContain(m.href);
    }
  });
});

describe("app lookup helpers", () => {
  it("finds an app by href", () => {
    expect(appByHref("/accounting")?.id).toBe("accounting");
    expect(appByHref("/nope")).toBeUndefined();
  });

  it("resolves an app by id or by route", () => {
    expect(resolveApp("crm")?.id).toBe("crm");
    expect(resolveApp("/crm")?.id).toBe("crm");
    expect(resolveApp("nope")).toBeUndefined();
  });
});

describe("resolveEnabledModules", () => {
  it("treats a missing value as every module", () => {
    expect(resolveEnabledModules(null)).toEqual(new Set(ALL_MODULE_IDS));
    expect(resolveEnabledModules(undefined)).toEqual(new Set(ALL_MODULE_IDS));
  });

  it("keeps known ids and drops unknown ones", () => {
    expect(resolveEnabledModules(["crm", "not-a-module"])).toEqual(new Set(["crm"]));
  });

  it("returns an empty set rather than throwing on an empty list", () => {
    expect(resolveEnabledModules([])).toEqual(new Set());
  });
});

describe("appsForOrg", () => {
  it("shows everything when the org has no module list yet", () => {
    expect(appsForOrg(null)).toHaveLength(APPS.length);
  });

  it("hides apps whose module is switched off", () => {
    const ids = appsForOrg(new Set(["accounting"])).map((a) => a.id);
    expect(ids).toContain("accounting");
    expect(ids).not.toContain("pos");
    expect(ids).not.toContain("marketing");
  });

  /* Team, approvals and the ledger are part of the OS, not of a business
     module — switching every module off must still leave them reachable. */
  it("always keeps system apps, even with every module switched off", () => {
    const ids = appsForOrg(new Set()).map((a) => a.id);
    expect(ids).toContain("team");
    expect(ids).toContain("approvals");
    expect(ids).toContain("settings");
  });

  it("keeps the marketing and projects tiles added in M13", () => {
    const ids = appsForOrg(new Set(ALL_MODULE_IDS)).map((a) => a.id);
    expect(ids).toContain("marketing");
    expect(ids).toContain("projects");
  });
});

describe("tileStyle", () => {
  it("keeps system tiles neutral instead of claiming a hue", () => {
    expect(tileStyle(0).background).toBe("var(--color-stone-100)");
  });

  it("tints a business app from its hue", () => {
    const style = tileStyle(145);
    expect(style.background).toContain("oklch");
    expect(style.background).toContain("145");
  });
});

describe("onboarding plan content", () => {
  it("has no duplicate steps", () => {
    expect(new Set(CLIENT_STEPS).size).toBe(CLIENT_STEPS.length);
  });

  /* The wizard's copy and the server's persisted list are written out twice on
     purpose — the client cannot import the server module without dragging the
     database and the embedding client into the bundle. That makes this the only
     guard on them drifting apart, and a drift means a step the user completed
     is silently dropped from the checklist. */
  it("mirrors the server's step list exactly", () => {
    expect([...CLIENT_STEPS]).toEqual([...SERVER_STEPS]);
  });

  it("explains every step, with a real way to finish it", () => {
    for (const step of CLIENT_STEPS) {
      const meta = STEP_META[step];
      expect(meta, step).toBeTruthy();
      expect(meta.title.length, step).toBeGreaterThan(0);
      expect(meta.why.length, step).toBeGreaterThan(0);
      expect(meta.fix.label.length, step).toBeGreaterThan(0);
      expect(meta.fix.href.startsWith("/"), step).toBe(true);
    }
  });

  it("offers every path exactly once, in a stable order", () => {
    expect(PATH_ORDER).toHaveLength(3);
    expect(new Set(PATH_ORDER).size).toBe(3);
    expect(PATH_ORDER[0]).toBe("fresh");
  });

  it("keeps each path's own id in sync with its key", () => {
    for (const [id, meta] of Object.entries(PATH_META)) expect(meta.id).toBe(id);
  });

  it("only ever defers steps that exist", () => {
    for (const path of PATH_ORDER) {
      for (const step of PATH_META[path].steps) {
        expect(CLIENT_STEPS as readonly string[], `${path} defers unknown step ${step}`).toContain(step);
      }
    }
  });

  it("quotes an estimate for every path, including the one that varies", () => {
    for (const path of PATH_ORDER) expect(PATH_META[path].estimate.length).toBeGreaterThan(0);
  });
});
