import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Sequence,
  Easing,
} from "remotion";

// ── timing ────────────────────────────────────────────────────────────────
const T = {
  hook:    { from: 0,   to: 90  },  // "What kind of investor are you?" hook
  quiz:    { from: 90,  to: 240 },  // quiz result + cards animate in
  smart:   { from: 240, to: 390 },  // "now the app gets smarter" benefits
  cta:     { from: 390, to: 510 },  // drop announcement CTA
};

// ── palette ───────────────────────────────────────────────────────────────
const C = {
  bg:      "#060606",
  card:    "#0f0f0f",
  accent:  "#b8ff00",
  accent2: "#d4ff66",
  purple:  "#6c5ce7",
  purple2: "#a29bfe",
  green:   "#00c97a",
  amber:   "#f59e0b",
  red:     "#ff3860",
  blue:    "#4d8fff",
  white:   "#ffffff",
  muted:   "#666666",
  border:  "rgba(255,255,255,0.07)",
};

// ── helpers ───────────────────────────────────────────────────────────────
function fi(frame: number, start: number, dur = 15) {
  return interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}
function su(frame: number, start: number, dist = 40) {
  const p = interpolate(frame, [start, start + 22], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return `translateY(${(1 - p) * dist}px)`;
}

const FADE = 18;
function SceneFade({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const inOp  = interpolate(frame, [0, FADE], [0, 1], { extrapolateRight: "clamp" });
  const outOp = interpolate(frame, [durationInFrames - FADE, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  return <AbsoluteFill style={{ opacity: Math.min(inOp, outOp) }}>{children}</AbsoluteFill>;
}

// ── HookScene ─────────────────────────────────────────────────────────────
function HookScene() {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{
      background: C.bg,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "column",
      padding: "80px 64px",
    }}>
      {/* glow */}
      <div style={{
        position: "absolute",
        width: 700, height: 700, borderRadius: "50%",
        background: `radial-gradient(circle, ${C.purple}33 0%, transparent 68%)`,
        top: "50%", left: "50%",
        transform: "translate(-50%, -55%)",
        pointerEvents: "none",
      }} />

      <div style={{ opacity: fi(frame, 0), transform: su(frame, 0), marginBottom: 10 }}>
        <span style={{ fontSize: 48, fontWeight: 900, color: C.muted, fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -1 }}>
          Do you know
        </span>
      </div>
      <div style={{ opacity: fi(frame, 18), transform: su(frame, 18), marginBottom: 10 }}>
        <span style={{ fontSize: 48, fontWeight: 900, color: C.white, fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -1 }}>
          what kind of
        </span>
      </div>
      <div style={{ opacity: fi(frame, 36), transform: su(frame, 36), marginBottom: 48 }}>
        <span style={{
          fontSize: 56, fontWeight: 900,
          fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -1.5,
          background: `linear-gradient(90deg, ${C.purple2}, ${C.accent2})`,
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}>
          investor you are?
        </span>
      </div>
      <div style={{ opacity: fi(frame, 55), transform: su(frame, 55) }}>
        <span style={{ fontSize: 24, color: C.muted, fontFamily: "Arial, sans-serif", letterSpacing: 0.5 }}>
          Because your app should. 👇
        </span>
      </div>
    </AbsoluteFill>
  );
}

// ── QuizRevealScene ───────────────────────────────────────────────────────
const PROFILE_TYPES = [
  { emoji: "🛡️", label: "Conservative", color: C.blue,   desc: "Bonds, stable assets, low volatility" },
  { emoji: "⚖️", label: "Moderate",     color: C.amber,  desc: "Mix of growth and stability" },
  { emoji: "🚀", label: "Aggressive",   color: C.green,  desc: "High growth, high risk, max upside" },
];

const RISK_CARDS = [
  { icon: "🔵", label: "Low",      color: C.blue  },
  { icon: "⚖️", label: "Medium",   color: C.amber },
  { icon: "🔥", label: "Very High",color: C.red   },
];

const STYLE_CARDS = [
  { icon: "💰", label: "Income Focus",  color: C.green  },
  { icon: "⚖️", label: "Balanced",      color: C.purple2 },
  { icon: "🚀", label: "Growth Focus",  color: C.red    },
];

const SECTORS = ["Technology", "Healthcare", "Finance", "Energy", "Crypto", "Defense"];

function QuizRevealScene() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // header
  const hSp = spring({ frame, fps, config: { stiffness: 90, damping: 18 } });

  return (
    <AbsoluteFill style={{ background: C.bg, flexDirection: "column", justifyContent: "flex-start", padding: "56px 40px 40px", overflowY: "hidden" }}>
      {/* purple top glow */}
      <div style={{
        position: "absolute", width: 600, height: 300, borderRadius: "50%",
        background: `radial-gradient(circle, ${C.purple}33 0%, transparent 70%)`,
        top: -80, left: "50%", transform: "translateX(-50%)", pointerEvents: "none",
      }} />

      {/* ── heading ── */}
      <div style={{
        opacity: interpolate(hSp, [0, 1], [0, 1]),
        transform: `translateY(${interpolate(hSp, [0, 1], [-50, 0])}px)`,
        marginBottom: 28,
      }}>
        <div style={{ fontSize: 18, color: C.purple2, fontFamily: "Arial, sans-serif", letterSpacing: 2, fontWeight: 700, marginBottom: 8, textTransform: "uppercase" }}>
          ✨ New Feature Drop
        </div>
        <div style={{ fontSize: 42, fontWeight: 900, color: C.white, fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -1, lineHeight: 1.1 }}>
          Investor Profile
        </div>
        <div style={{ fontSize: 20, color: C.muted, fontFamily: "Arial, sans-serif", marginTop: 6 }}>
          5 questions. Fully personalised experience.
        </div>
      </div>

      {/* ── investor type cards ── */}
      <div style={{ opacity: fi(frame, 22), marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: C.muted, letterSpacing: 2, fontFamily: "Arial, sans-serif", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>
          Your Investor Type
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          {PROFILE_TYPES.map((p, i) => {
            const sp = spring({ frame: frame - 22 - i * 14, fps, config: { stiffness: 130, damping: 16 } });
            const active = i === 1; // highlight "Moderate" as selected
            return (
              <div key={i} style={{
                flex: 1,
                opacity: interpolate(sp, [0, 0.4], [0, 1], { extrapolateRight: "clamp" }),
                transform: `translateY(${interpolate(sp, [0, 1], [40, 0])}px)`,
                background: active ? p.color + "22" : C.card,
                border: `2px solid ${active ? p.color : "rgba(255,255,255,0.07)"}`,
                borderRadius: 16,
                padding: "18px 14px",
                textAlign: "center",
                boxShadow: active ? `0 0 30px ${p.color}44` : "none",
              }}>
                <div style={{ fontSize: 28, marginBottom: 6 }}>{p.emoji}</div>
                <div style={{ fontSize: 16, fontWeight: 900, color: active ? p.color : C.white, fontFamily: "Arial Black, Arial, sans-serif" }}>{p.label}</div>
                <div style={{ fontSize: 12, color: C.muted, fontFamily: "Arial, sans-serif", marginTop: 4, lineHeight: 1.4 }}>{p.desc}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── risk tolerance ── */}
      <div style={{ opacity: fi(frame, 55), transform: su(frame, 55, 30), marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: C.muted, letterSpacing: 2, fontFamily: "Arial, sans-serif", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>
          Risk Tolerance
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {RISK_CARDS.map((r, i) => (
            <div key={i} style={{
              flex: 1, display: "flex", alignItems: "center", gap: 10,
              background: i === 0 ? r.color + "22" : C.card,
              border: `1.5px solid ${i === 0 ? r.color : "rgba(255,255,255,0.07)"}`,
              borderRadius: 12, padding: "12px 14px",
            }}>
              <span style={{ fontSize: 20 }}>{r.icon}</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: i === 0 ? r.color : C.muted, fontFamily: "Arial, sans-serif" }}>{r.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── investment style ── */}
      <div style={{ opacity: fi(frame, 75), transform: su(frame, 75, 30), marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: C.muted, letterSpacing: 2, fontFamily: "Arial, sans-serif", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>
          Investment Style
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {STYLE_CARDS.map((s, i) => (
            <div key={i} style={{
              flex: 1, display: "flex", alignItems: "center", gap: 10,
              background: i === 1 ? s.color + "22" : C.card,
              border: `1.5px solid ${i === 1 ? s.color : "rgba(255,255,255,0.07)"}`,
              borderRadius: 12, padding: "12px 14px",
            }}>
              <span style={{ fontSize: 20 }}>{s.icon}</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: i === 1 ? s.color : C.muted, fontFamily: "Arial, sans-serif" }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── preferred sectors ── */}
      <div style={{ opacity: fi(frame, 95), transform: su(frame, 95, 30) }}>
        <div style={{ fontSize: 13, color: C.muted, letterSpacing: 2, fontFamily: "Arial, sans-serif", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>
          Preferred Sectors
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {SECTORS.map((s, i) => {
            const picked = i < 3;
            return (
              <div key={i} style={{
                background: picked ? C.purple + "28" : C.card,
                border: `1.5px solid ${picked ? C.purple2 : "rgba(255,255,255,0.07)"}`,
                borderRadius: 50,
                padding: "8px 18px",
                fontSize: 15,
                color: picked ? C.purple2 : C.muted,
                fontFamily: "Arial, sans-serif",
                fontWeight: picked ? 700 : 400,
              }}>{s}</div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
}

// ── SmartScene ────────────────────────────────────────────────────────────
const BENEFITS = [
  { icon: "🎯", title: "Tailored AI Verdicts",       desc: "Buy/Hold/Sell analysis tuned to your risk level",  color: C.green  },
  { icon: "📋", title: "Stocks For You",             desc: "Curated picks from your preferred sectors",         color: C.accent2},
  { icon: "⚡", title: "Personalised Dashboard",      desc: "Markets feed matched to your investor profile",     color: C.purple2},
  { icon: "🎓", title: "Investment Goals Tracker",    desc: "Retirement, wealth building, passive income & more",color: C.amber  },
];

function SmartScene() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{
      background: "#06060e",
      flexDirection: "column",
      justifyContent: "center",
      padding: "72px 44px",
    }}>
      {/* accent glow */}
      <div style={{
        position: "absolute", width: 600, height: 400, borderRadius: "50%",
        background: `radial-gradient(circle, ${C.accent}1a 0%, transparent 70%)`,
        bottom: -100, right: -100, pointerEvents: "none",
      }} />

      <div style={{ opacity: fi(frame, 0), transform: su(frame, 0), marginBottom: 36 }}>
        <div style={{ fontSize: 16, color: C.accent2, letterSpacing: 2, fontFamily: "Arial, sans-serif", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>
          Now the app knows you
        </div>
        <div style={{ fontSize: 44, fontWeight: 900, color: C.white, fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -1.5, lineHeight: 1.1 }}>
          StockSight gets
        </div>
        <div style={{ fontSize: 44, fontWeight: 900, fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -1.5, lineHeight: 1.1,
          background: `linear-gradient(90deg, ${C.accent}, ${C.accent2})`,
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>
          smarter for you.
        </div>
      </div>

      {BENEFITS.map((b, i) => {
        const delay = 22 + i * 18;
        const sp = spring({ frame: frame - delay, fps, config: { stiffness: 110, damping: 18 } });
        return (
          <div key={i} style={{
            opacity: interpolate(sp, [0, 0.4], [0, 1], { extrapolateRight: "clamp" }),
            transform: `translateX(${interpolate(sp, [0, 1], [80, 0])}px)`,
            display: "flex", alignItems: "center", gap: 22,
            background: C.card,
            border: `1px solid ${C.border}`,
            borderLeft: `4px solid ${b.color}`,
            borderRadius: 18,
            padding: "20px 24px",
            marginBottom: 16,
          }}>
            <span style={{ fontSize: 36, flexShrink: 0 }}>{b.icon}</span>
            <div>
              <div style={{ fontSize: 22, fontWeight: 900, color: C.white, fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -0.3, marginBottom: 4 }}>
                {b.title}
              </div>
              <div style={{ fontSize: 16, color: C.muted, fontFamily: "Arial, sans-serif" }}>
                {b.desc}
              </div>
            </div>
            <div style={{ marginLeft: "auto", color: b.color, fontSize: 22 }}>→</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

// ── CtaScene ──────────────────────────────────────────────────────────────
function CtaScene() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoSp = spring({ frame, fps, config: { stiffness: 130, damping: 16 } });
  const btnSp  = spring({ frame: frame - 50, fps, config: { stiffness: 160, damping: 14 } });
  const pulse  = interpolate(Math.sin((frame / 12) * Math.PI), [-1, 1], [0.97, 1.03]);

  return (
    <AbsoluteFill style={{
      background: C.bg,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "column",
      padding: "80px 60px",
    }}>
      {/* dual glow */}
      <div style={{
        position: "absolute", width: 700, height: 700, borderRadius: "50%",
        background: `radial-gradient(circle, ${C.purple}2a 0%, transparent 65%)`,
        top: -150, left: -150, pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", width: 600, height: 600, borderRadius: "50%",
        background: `radial-gradient(circle, ${C.accent}1e 0%, transparent 65%)`,
        bottom: -120, right: -120, pointerEvents: "none",
      }} />

      {/* logo */}
      <div style={{
        opacity: interpolate(logoSp, [0, 1], [0, 1]),
        transform: `scale(${interpolate(logoSp, [0, 1], [0.5, 1])})`,
        marginBottom: 32,
        width: 110, height: 110, borderRadius: 30,
        background: `linear-gradient(135deg, ${C.purple}, ${C.purple2})`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 56,
        boxShadow: `0 0 60px ${C.purple}66`,
      }}>📈</div>

      {/* drop badge */}
      <div style={{ opacity: fi(frame, 14), transform: su(frame, 14), marginBottom: 16 }}>
        <div style={{
          background: `${C.purple}33`,
          border: `1.5px solid ${C.purple2}`,
          borderRadius: 50, padding: "8px 24px",
          fontSize: 16, color: C.purple2, fontFamily: "Arial, sans-serif", fontWeight: 700, letterSpacing: 1,
        }}>🎉 NOW LIVE — INVESTOR PROFILE</div>
      </div>

      <div style={{ opacity: fi(frame, 26), transform: su(frame, 26), textAlign: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 54, fontWeight: 900, color: C.white, fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -1.5 }}>
          StockSight
        </span>
      </div>

      <div style={{ opacity: fi(frame, 40), transform: su(frame, 40), textAlign: "center", marginBottom: 52 }}>
        <span style={{ fontSize: 22, color: C.muted, fontFamily: "Arial, sans-serif" }}>
          Your personalised AI stock research platform
        </span>
      </div>

      {/* CTA button */}
      <div style={{
        opacity: interpolate(btnSp, [0, 0.4], [0, 1], { extrapolateRight: "clamp" }),
        transform: `scale(${interpolate(btnSp, [0, 1], [0.7, 1]) * pulse})`,
        marginBottom: 44,
      }}>
        <div style={{
          background: `linear-gradient(135deg, ${C.purple}, ${C.purple2})`,
          borderRadius: 24, padding: "26px 72px",
          fontSize: 30, fontWeight: 900, color: C.white,
          fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -0.5,
          boxShadow: `0 8px 40px ${C.purple}88`,
          textAlign: "center",
        }}>
          stocksightai.com
        </div>
      </div>

      <div style={{ opacity: fi(frame, 86), display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
        {["🆓 Always free", "🎯 Know your investor type", "⚡ AI that knows you"].map((tag, i) => (
          <div key={i} style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 50, padding: "12px 24px",
            fontSize: 18, color: C.white, fontFamily: "Arial, sans-serif",
          }}>{tag}</div>
        ))}
      </div>
    </AbsoluteFill>
  );
}

// ── main export ───────────────────────────────────────────────────────────
export const InvestorProfileAd: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    <Sequence from={T.hook.from} durationInFrames={T.hook.to - T.hook.from}>
      <SceneFade><HookScene /></SceneFade>
    </Sequence>
    <Sequence from={T.quiz.from} durationInFrames={T.quiz.to - T.quiz.from}>
      <SceneFade><QuizRevealScene /></SceneFade>
    </Sequence>
    <Sequence from={T.smart.from} durationInFrames={T.smart.to - T.smart.from}>
      <SceneFade><SmartScene /></SceneFade>
    </Sequence>
    <Sequence from={T.cta.from} durationInFrames={T.cta.to - T.cta.from}>
      <SceneFade><CtaScene /></SceneFade>
    </Sequence>
  </AbsoluteFill>
);
