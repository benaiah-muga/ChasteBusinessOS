import type { CSSProperties, ReactNode, SVGProps } from "react";

/**
 * Shared chrome for the setup wizard: header, progress rail, choice cards,
 * failure blocks, the icon set, and the style tokens the wizard and the CSV
 * panel share.
 *
 * The wizard renders outside the authenticated shell and outside any page
 * stylesheet, so its visual language lives here as typed style objects rather
 * than a class sheet: the palette is the same ink, paper and gold the rest of
 * the app uses, but nothing depends on a stylesheet this route cannot load.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      width="1em"
      height="1em"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconSparkle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l1.9 5.6a1 1 0 0 0 .6.6L20 11l-5.5 1.8a1 1 0 0 0-.6.6L12 19l-1.9-5.6a1 1 0 0 0-.6-.6L4 11l5.5-1.8a1 1 0 0 0 .6-.6L12 3z" />
    </Icon>
  );
}

export function IconLandmark(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 22h18" />
      <path d="M6 18v-7" />
      <path d="M10 18v-7" />
      <path d="M14 18v-7" />
      <path d="M18 18v-7" />
      <path d="m12 2 8 5H4z" />
    </Icon>
  );
}

export function IconFileText(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
      <path d="M10 9H8" />
    </Icon>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  );
}

export function IconShieldCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  );
}

export function IconX(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m15 18-6-6 6-6" />
    </Icon>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Icon>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

export function IconAlertTriangle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  );
}

export function IconBuilding(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M9 22v-4h6v4" />
      <path d="M8 6h.01" />
      <path d="M16 6h.01" />
      <path d="M12 6h.01" />
      <path d="M12 10h.01" />
      <path d="M12 14h.01" />
      <path d="M16 10h.01" />
      <path d="M16 14h.01" />
      <path d="M8 10h.01" />
      <path d="M8 14h.01" />
    </Icon>
  );
}

export function IconUpload(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </Icon>
  );
}

export function IconCash(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 12h.01" />
      <path d="M18 12h.01" />
    </Icon>
  );
}

export function IconLink(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Icon>
  );
}

export function IconBox(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </Icon>
  );
}

export function IconBookOpen(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" />
      <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
    </Icon>
  );
}

export function IconStore(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m2 7 1.5-4h17L22 7" />
      <path d="M2 7a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
      <path d="M4 10v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V10" />
      <path d="M9 21v-6h6v6" />
    </Icon>
  );
}

const serif = 'Georgia, "Times New Roman", serif';

/** Shared palette, exported so the wizard and the CSV panel stay on one set. */
export const ink = "#202922";
export const muted = "#6f726a";
export const gold = "#a9863f";
export const hairline = "#e2dfd6";
const surface = "#fffefa";
const sand = "#efece3";

export const styles = {
  page: { minHeight: "100vh", background: "#f4f3ee", color: ink } satisfies CSSProperties,
  header: { background: "#111416", color: "#f7f1e8", borderBottom: "1px solid #23262a" } satisfies CSSProperties,
  headerInner: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    width: "min(100% - 40px, 1180px)",
    margin: "0 auto",
    padding: "16px 0",
  } satisfies CSSProperties,
  brand: { display: "flex", alignItems: "center", gap: 10 } satisfies CSSProperties,
  brandMark: {
    display: "grid",
    width: 34,
    height: 34,
    placeItems: "center",
    borderRadius: 10,
    background: "#2a3a31",
    color: "#e2be82",
    fontFamily: serif,
    fontSize: 19,
    fontWeight: 700,
  } satisfies CSSProperties,
  brandName: { display: "block", fontSize: 13, fontWeight: 650, letterSpacing: "-.02em" } satisfies CSSProperties,
  brandTag: {
    display: "block",
    marginTop: 3,
    color: "#a9a39b",
    fontSize: 9,
    letterSpacing: ".13em",
    textTransform: "uppercase",
  } satisfies CSSProperties,
  secure: { display: "flex", alignItems: "center", gap: 10, color: "#a9a39b", fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase" } satisfies CSSProperties,
  avatar: {
    display: "grid",
    width: 32,
    height: 32,
    placeItems: "center",
    border: "1px solid rgb(201 160 95 / 45%)",
    borderRadius: "50%",
    background: "rgb(201 160 95 / 15%)",
    fontSize: 13,
    fontWeight: 650,
  } satisfies CSSProperties,
  main: {
    display: "grid",
    gap: 18,
    width: "min(100% - 40px, 1180px)",
    margin: "0 auto",
    padding: "24px 0 64px",
  } satisfies CSSProperties,
  topRow: { display: "flex", flexWrap: "wrap", gap: 14, justifyContent: "space-between", alignItems: "stretch" } satisfies CSSProperties,
  columns: { display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(310px, 1fr))", alignItems: "start" } satisfies CSSProperties,
  card: {
    padding: "clamp(20px, 3vw, 32px)",
    border: `1px solid ${hairline}`,
    borderRadius: 18,
    background: surface,
    boxShadow: "0 20px 60px rgb(48 45 36 / 6%)",
  } satisfies CSSProperties,
  aside: {
    padding: 22,
    border: `1px solid ${hairline}`,
    borderRadius: 18,
    background: sand,
  } satisfies CSSProperties,
  title: { margin: "0 0 6px", fontFamily: serif, fontSize: 27, fontWeight: 500, letterSpacing: "-.03em", lineHeight: 1.2 } satisfies CSSProperties,
  lede: { margin: 0, color: muted, fontSize: 13, lineHeight: 1.7 } satisfies CSSProperties,
  note: { margin: 0, color: muted, fontSize: 11, lineHeight: 1.6 } satisfies CSSProperties,
  eyebrow: { margin: 0, color: gold, fontSize: 9, fontWeight: 750, letterSpacing: ".16em", textTransform: "uppercase" } satisfies CSSProperties,
  stack: { display: "grid", gap: 16 } satisfies CSSProperties,
  stackTight: { display: "grid", gap: 8 } satisfies CSSProperties,
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 } satisfies CSSProperties,
  field: { display: "grid", gap: 7 } satisfies CSSProperties,
  label: { color: "#443f37", fontSize: 11, fontWeight: 650 } satisfies CSSProperties,
  divider: { margin: "24px 0 0", paddingTop: 20, borderTop: `1px solid #eceae4` } satisfies CSSProperties,
  list: { display: "grid", gap: 9, margin: 0, padding: 0, listStyle: "none" } satisfies CSSProperties,
  pointChip: {
    display: "grid",
    width: 26,
    height: 26,
    flex: "0 0 auto",
    placeItems: "center",
    borderRadius: 8,
    border: "1px solid #e4e0d4",
    background: surface,
    color: gold,
    fontSize: 13,
  } satisfies CSSProperties,
  link: { color: gold, fontWeight: 600, textUnderlineOffset: 3 } satisfies CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 } satisfies CSSProperties,
  tableHead: { background: "#f1efe7", color: muted, fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase" } satisfies CSSProperties,
  tableCell: { padding: "8px 10px", borderTop: "1px solid #eceae4", textAlign: "left", verticalAlign: "top" } satisfies CSSProperties,
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 9px",
    border: "1px solid #e0dcd0",
    borderRadius: 999,
    background: "#f7f6f0",
    color: "#4a4d45",
    fontSize: 11,
    fontWeight: 600,
  } satisfies CSSProperties,
  dropzone: {
    display: "grid",
    justifyItems: "center",
    gap: 8,
    padding: "30px 22px",
    border: "2px dashed #d9d5c8",
    borderRadius: 14,
    background: "#faf9f4",
    textAlign: "center",
  } satisfies CSSProperties,
} as const;

export const primaryButton: CSSProperties = {
  display: "inline-flex",
  minHeight: 44,
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  border: "1px solid transparent",
  borderRadius: 11,
  padding: "0 18px",
  background: "#211f1b",
  boxShadow: "0 12px 26px rgb(23 26 27 / 16%)",
  color: "#f8f2e8",
  cursor: "pointer",
  font: "inherit",
  fontSize: 12.5,
  fontWeight: 650,
};

export const secondaryButton: CSSProperties = {
  ...primaryButton,
  borderColor: "#d9d7cd",
  background: "#f7f6f0",
  boxShadow: "none",
  color: "#354238",
};

export const ghostButton: CSSProperties = {
  display: "inline-flex",
  minHeight: 34,
  alignItems: "center",
  gap: 6,
  border: 0,
  borderRadius: 8,
  padding: "0 8px",
  background: "transparent",
  color: muted,
  cursor: "pointer",
  font: "inherit",
  fontSize: 11.5,
  fontWeight: 600,
};

export const disabledButton: CSSProperties = { opacity: 0.55, cursor: "not-allowed" };

export const textInput: CSSProperties = {
  width: "100%",
  minHeight: 42,
  border: "1px solid #d9d2c7",
  borderRadius: 10,
  padding: "0 12px",
  background: "#fff",
  color: ink,
  font: "inherit",
  fontSize: 13,
  outline: "none",
};

export const areaInput: CSSProperties = {
  ...textInput,
  minHeight: 118,
  padding: "10px 12px",
  lineHeight: 1.6,
  resize: "vertical",
};

/** Buttons and fields compose, so callers add their own overrides. */
export function withStyle(base: CSSProperties, ...overrides: Array<CSSProperties | false | undefined>): CSSProperties {
  return overrides.reduce<CSSProperties>((merged, override) => (override ? { ...merged, ...override } : merged), base);
}

export function Spinner({ size = 16, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ width: size, height: size, color }}>
      <circle cx="12" cy="12" r="9" stroke={color} strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The same app chrome as the sign-in page. The avatar carries the user's real
 * initial: during setup there is nothing else on screen telling them they are
 * already signed in as the right person.
 */
export function OnboardingHeader({ email }: { email: string }) {
  const initial = (email.trim()[0] ?? "N").toUpperCase();
  return (
    <header style={styles.header}>
      <div style={styles.headerInner}>
        <span style={styles.brand}>
          <span style={styles.brandMark} aria-hidden="true">C</span>
          <span>
            <span style={styles.brandName}>Chaste Business OS</span>
            <span style={styles.brandTag}>Open source, built for everyone</span>
          </span>
        </span>
        <span style={styles.secure}>
          Secure setup
          <span style={styles.avatar} title={email}>{initial}</span>
        </span>
      </div>
    </header>
  );
}

export interface RailStep {
  key: string;
  label: string;
}

/** Progress rail. Completed steps show a check, the current one is inked. */
export function StepRail({ steps, current }: { steps: RailStep[]; current: number }) {
  return (
    <ol style={{ ...styles.list, gridAutoFlow: "column", justifyContent: "start", fontSize: 12 }}>
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={step.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              aria-current={active ? "step" : undefined}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                borderRadius: 999,
                padding: "5px 10px",
                background: active ? "#111416" : "transparent",
                color: active ? "#f7f1e8" : done ? ink : muted,
                fontWeight: 600,
              }}
            >
              <span
                style={{
                  display: "grid",
                  width: 19,
                  height: 19,
                  placeItems: "center",
                  borderRadius: "50%",
                  background: active ? "#c8a866" : done ? "rgb(200 168 102 / 22%)" : "#e4e1d7",
                  color: active ? "#211f1b" : done ? "#7d6428" : muted,
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                {done ? <IconCheck style={{ width: 12, height: 12 }} /> : index + 1}
              </span>
              {step.label}
            </span>
            {index < steps.length - 1 && <span aria-hidden="true" style={{ width: 14, height: 1, background: "#ddd9cc" }} />}
          </li>
        );
      })}
    </ol>
  );
}

export function ProgressBar({ value, label, status }: { value: number; label: string; status: string }) {
  const safeValue = Math.max(0, Math.min(100, value));
  return (
    <div style={{ ...styles.card, padding: "14px 18px", minWidth: 260, flex: "1 1 300px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <span style={{ minWidth: 0 }}>
          <span style={styles.eyebrow}>{status}</span>
          <span style={{ display: "block", marginTop: 5, fontSize: 13, fontWeight: 650 }}>{label}</span>
        </span>
        <output aria-live="polite" style={{ fontFamily: serif, fontSize: 24, letterSpacing: "-.04em" }}>
          {Math.round(safeValue)}%
        </output>
      </div>
      <div
        role="progressbar"
        aria-label={status}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(safeValue)}
        style={{ marginTop: 11, height: 5, borderRadius: 999, background: "#e8e4d8", overflow: "hidden" }}
      >
        <span style={{ display: "block", width: `${safeValue}%`, height: "100%", borderRadius: 999, background: gold }} />
      </div>
    </div>
  );
}

/** A selectable path card: big target, states explained, keyboard reachable. */
export function ChoiceCard({
  selected,
  onSelect,
  icon,
  title,
  blurb,
  bullets,
  meta,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  blurb: string;
  bullets: string[];
  meta: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        display: "grid",
        gap: 12,
        width: "100%",
        border: `1px solid ${selected ? "#c8a866" : "#e6e2d7"}`,
        borderRadius: 14,
        padding: 18,
        background: selected ? "#fdfaf1" : surface,
        boxShadow: selected ? "0 14px 34px rgb(48 45 36 / 10%)" : "none",
        color: "inherit",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span
          style={{
            display: "grid",
            width: 38,
            height: 38,
            flex: "0 0 auto",
            placeItems: "center",
            borderRadius: 10,
            background: selected ? "#c8a866" : "rgb(200 168 102 / 14%)",
            color: selected ? "#fff" : gold,
            fontSize: 18,
          }}
        >
          {icon}
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontSize: 14.5, fontWeight: 650 }}>{title}</span>
          <span style={{ display: "block", marginTop: 4, color: muted, fontSize: 12.5, lineHeight: 1.6 }}>{blurb}</span>
        </span>
        <span
          aria-hidden="true"
          style={{
            display: "grid",
            width: 20,
            height: 20,
            flex: "0 0 auto",
            placeItems: "center",
            border: `1px solid ${selected ? "#c8a866" : "#ddd9cc"}`,
            borderRadius: "50%",
            background: selected ? "#c8a866" : surface,
            color: "#fff",
            fontSize: 11,
          }}
        >
          {selected ? <IconCheck style={{ width: 12, height: 12 }} /> : null}
        </span>
      </span>
      <span style={styles.list}>
        {bullets.map((bullet) => (
          <span key={bullet} style={{ display: "flex", gap: 8, color: muted, fontSize: 12.5 }}>
            <IconCheck style={{ width: 13, height: 13, flex: "0 0 auto", marginTop: 3, color: gold }} />
            <span>{bullet}</span>
          </span>
        ))}
      </span>
      <span style={{ color: gold, fontSize: 10, fontWeight: 750, letterSpacing: ".1em", textTransform: "uppercase" }}>{meta}</span>
    </button>
  );
}

/**
 * One failure, explained. Every error in the wizard gets a reason and a way
 * out; a bare red string is how a new user ends up stuck and blaming the tool.
 */
export function RecoverBlock({
  title,
  children,
  actions,
  tone = "error",
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  tone?: "error" | "warn";
}) {
  const warn = tone === "warn";
  return (
    <div
      role={warn ? "status" : "alert"}
      style={{
        border: `1px solid ${warn ? "rgb(169 133 78 / 34%)" : "rgb(180 72 61 / 24%)"}`,
        borderRadius: 12,
        padding: "13px 15px",
        background: warn ? "rgb(203 162 105 / 9%)" : "rgb(180 72 61 / 7%)",
        color: warn ? "#49433a" : "#8f302a",
        fontSize: 12.5,
        lineHeight: 1.6,
      }}
    >
      <p style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>{title}</p>
      <div style={{ marginTop: 4 }}>{children}</div>
      {actions ? <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>{actions}</div> : null}
    </div>
  );
}
