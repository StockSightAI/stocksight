import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Sequence,
  Easing,
} from "remotion";

// ── timing (frames at 30fps) ──────────────────────────────────────────────
const T = {
  hookStart: 0,
  hookEnd: 90,
  painStart: 90,
  painEnd: 180,
  newsStart: 180,
  newsEnd: 330,
  revealStart: 330,
  revealEnd: 480,
  ctaStart: 480,
  ctaEnd: 630,
};

// ── palette ───────────────────────────────────────────────────────────────
const C = {
  bg: "#060606",
  accent: "#b8ff00",
  accent2: "#d4ff66",
  green: "#00c97a",
  red: "#ff3860",
  amber: "#f59e0b",
  white: "#ffffff",
  muted: "#666666",
  card: "#0f0f0f",
  border: "rgba(255,255,255,0.07)",
};

// ── helpers ───────────────────────────────────────────────────────────────
function fadeIn(frame: number, start: number, duration = 15) {
  return interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function slideUp(frame: number, start: number, distance = 40) {
  const p = interpolate(frame, [start, start + 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return `translateY(${(1 - p) * distance}px)`;
}

// Wraps a scene with a smooth fade-in and fade-out crossfade
const FADE_FRAMES = 18;
function SceneFade({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fadeInOp = interpolate(frame, [0, FADE_FRAMES], [0, 1], { extrapolateRight: "clamp" });
  const fadeOutOp = interpolate(frame, [durationInFrames - FADE_FRAMES, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const opacity = Math.min(fadeInOp, fadeOutOp);
  return (
    <AbsoluteFill style={{ opacity }}>
      {children}
    </AbsoluteFill>
  );
}

// ── HookScene ─────────────────────────────────────────────────────────────
function HookScene() {
  const frame = useCurrentFrame();

  const line1Op = fadeIn(frame, 0);
  const line1Tr = slideUp(frame, 0);
  const line2Op = fadeIn(frame, 20);
  const line2Tr = slideUp(frame, 20);
  const line3Op = fadeIn(frame, 40);
  const line3Tr = slideUp(frame, 40);
  const subOp = fadeIn(frame, 60);
  const subTr = slideUp(frame, 60);

  return (
    <AbsoluteFill
      style={{
        background: C.bg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        padding: "80px 64px",
      }}
    >
      <div style={{
        position: "absolute",
        width: 600,
        height: 600,
        borderRadius: "50%",
        background: `radial-gradient(circle, ${C.accent}22 0%, transparent 70%)`,
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -60%)",
        pointerEvents: "none",
      }} />

      <div style={{ opacity: line1Op, transform: line1Tr, marginBottom: 8 }}>
        <span style={{
          fontSize: 52,
          fontWeight: 900,
          color: C.muted,
          fontFamily: "Arial Black, Arial, sans-serif",
          letterSpacing: -1,
          lineHeight: 1.15,
        }}>
          Why are you still
        </span>
      </div>
      <div style={{ opacity: line2Op, transform: line2Tr, marginBottom: 8 }}>
        <span style={{
          fontSize: 52,
          fontWeight: 900,
          color: C.white,
          fontFamily: "Arial Black, Arial, sans-serif",
          letterSpacing: -1,
          lineHeight: 1.15,
        }}>
          researching stocks
        </span>
      </div>
      <div style={{ opacity: line3Op, transform: line3Tr, marginBottom: 48 }}>
        <span style={{
          fontSize: 52,
          fontWeight: 900,
          fontFamily: "Arial Black, Arial, sans-serif",
          letterSpacing: -1,
          lineHeight: 1.15,
          background: `linear-gradient(90deg, ${C.accent}, ${C.accent2})`,
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}>
          the hard way?
        </span>
      </div>

      <div style={{ opacity: subOp, transform: subTr }}>
        <span style={{
          fontSize: 26,
          color: C.muted,
          fontFamily: "Arial, sans-serif",
          letterSpacing: 0.5,
        }}>
          There&#39;s a smarter way now 👇
        </span>
      </div>
    </AbsoluteFill>
  );
}

// ── PainScene ─────────────────────────────────────────────────────────────
const PAIN_ITEMS = [
  { emoji: "📰", label: "MarketWatch", sub: "NVDA dips 3%..." },
  { emoji: "🧵", label: "Reddit WSB", sub: "trust me bro its gonna moon" },
  { emoji: "📊", label: "Spreadsheet", sub: "=VLOOKUP(A2,Sheet3!..." },
  { emoji: "🤔", label: "Your brain", sub: "still no idea what to do" },
  { emoji: "📺", label: "CNBC", sub: "experts disagree again" },
  { emoji: "😩", label: "3 hours later", sub: "you're more confused" },
];

function PainScene() {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        background: "#050510",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        padding: "80px 40px",
        gap: 20,
      }}
    >
      <div style={{
        opacity: fadeIn(frame, 0),
        transform: slideUp(frame, 0),
        marginBottom: 24,
        textAlign: "center",
      }}>
        <span style={{
          fontSize: 36,
          fontWeight: 900,
          color: C.white,
          fontFamily: "Arial Black, Arial, sans-serif",
        }}>
          The old way:
        </span>
      </div>

      {PAIN_ITEMS.map((item, i) => {
        const startFrame = i * 12;
        return (
          <div
            key={i}
            style={{
              opacity: fadeIn(frame, startFrame, 10),
              transform: slideUp(frame, startFrame, 30),
              display: "flex",
              alignItems: "center",
              gap: 20,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 16,
              padding: "18px 28px",
              width: "100%",
              maxWidth: 800,
            }}
          >
            <span style={{ fontSize: 36 }}>{item.emoji}</span>
            <div>
              <div style={{ color: C.white, fontWeight: 700, fontSize: 22, fontFamily: "Arial, sans-serif" }}>
                {item.label}
              </div>
              <div style={{ color: C.muted, fontSize: 18, fontFamily: "Arial, sans-serif", marginTop: 2 }}>
                {item.sub}
              </div>
            </div>
          </div>
        );
      })}

      <div style={{ opacity: fadeIn(frame, 75), transform: slideUp(frame, 75), marginTop: 8 }}>
        <span style={{ fontSize: 28, fontWeight: 700, color: C.red, fontFamily: "Arial, sans-serif" }}>
          Hours wasted. Still guessing. 😤
        </span>
      </div>
    </AbsoluteFill>
  );
}

// ── NewspaperScene ────────────────────────────────────────────────────────
// Grid: 3 cols × 8 rows = 24 tiles that together cover 1080×1920 fully.
// Each tile falls in from above with a staggered delay.
// Slight random-looking rotation and size variation per tile.
const HEADLINES = [
  "MARKETS PLUNGE AS INVESTORS PANIC",
  "FED RAISES RATES AGAIN",
  "TECH STOCKS IN FREEFALL",
  "INFLATION DATA SHOCKS WALL ST",
  "RECESSION FEARS MOUNT",
  "OIL PRICES SURGE 12%",
  "HOUSING MARKET COOLS SHARPLY",
  "CRYPTO WINTER DEEPENS",
  "EARNINGS DISAPPOINT ACROSS BOARD",
  "TRADE WAR ESCALATES",
  "BANK SECTOR UNDER PRESSURE",
  "JOBS REPORT MISSES ESTIMATES",
  "DOLLAR HITS 20-YEAR HIGH",
  "SUPPLY CHAIN CRISIS DEEPENS",
  "RATE HIKE SHOCKS MARKETS",
  "NASDAQ DROPS 4% IN ONE DAY",
  "YIELD CURVE INVERTS AGAIN",
  "CONSUMER CONFIDENCE AT ALL-TIME LOW",
  "HEDGE FUNDS FLEE EQUITIES",
  "GLOBAL SELL-OFF CONTINUES",
  "ANALYSTS CUT PRICE TARGETS",
  "IPO MARKET FREEZES UP",
  "PENSION FUNDS UNDER STRAIN",
  "VOLATILITY INDEX SPIKES TO 40",
];
const SUBS = [
  "Dow drops 800 points in volatile session",
  "Analysts divided on what happens next",
  "NASDAQ sees worst week since 2020",
  "Consumer prices rise more than expected",
  "Economists warn of turbulent Q3 ahead",
  "Energy sector rattles global markets",
  "Mortgage rates hit 20-year high",
  "Bitcoin falls below key support levels",
  "Q2 results miss analyst forecasts widely",
  "New tariffs threaten supply chains globally",
  "Regional banks see heavy outflows",
  "Unemployment ticks up for second month",
];

// Deterministic rotation & size offsets per tile index
const TILE_ROTS  = [-6, 3, -2, 8, -4, 5, -9, 2, -3, 7, -5, 4, -7, 3, -1, 6, -4, 2, -8, 5, -2, 7, -5, 3];
const TILE_SCALE = [1.02, 0.97, 1.04, 0.99, 1.01, 0.96, 1.03, 1.0, 0.98, 1.02, 0.97, 1.04, 1.0, 0.99, 1.03, 0.97, 1.01, 1.05, 0.98, 1.02, 0.96, 1.0, 1.03, 0.99];

const COLS = 3;
const ROWS = 8;
const TILE_W = Math.ceil(1080 / COLS) + 20;  // slight overlap
const TILE_H = Math.ceil(1920 / ROWS) + 20;

function NewspaperScene() {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // label appears late so it's visible before the scene fades out
  const labelOp = fadeIn(frame, durationInFrames - 40, 12);

  return (
    <AbsoluteFill style={{ background: "#0a0a0a", overflow: "hidden" }}>
      {Array.from({ length: COLS * ROWS }).map((_, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);

        // final resting position (fills the screen)
        const destX = col * (1080 / COLS);
        const destY = row * (1920 / ROWS);

        // stagger: top rows land first, left-to-right within each row
        const delay = row * 9 + col * 3;

        const sp = spring({ frame: frame - delay, fps, config: { stiffness: 35, damping: 18 } });
        const startY = destY - 1920 - 200; // start well above screen
        const currentY = interpolate(sp, [0, 1], [startY, destY]);
        const opacity = interpolate(sp, [0, 0.15], [0, 1], { extrapolateRight: "clamp" });

        const rot = TILE_ROTS[i % TILE_ROTS.length];
        const sc = TILE_SCALE[i % TILE_SCALE.length];
        const headline = HEADLINES[i % HEADLINES.length];
        const sub = SUBS[i % SUBS.length];

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: destX,
              top: currentY,
              width: TILE_W,
              height: TILE_H,
              opacity,
              transform: `rotate(${rot}deg) scale(${sc})`,
              transformOrigin: "center center",
              background: i % 5 === 0 ? "#ede8d8" : i % 3 === 0 ? "#f0ebe0" : "#f5f0e8",
              boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
              overflow: "hidden",
              padding: "14px 16px",
              boxSizing: "border-box" as const,
            }}
          >
            {/* masthead */}
            <div style={{
              borderBottom: "2px double #333",
              paddingBottom: 5,
              marginBottom: 8,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
            }}>
              <span style={{ fontSize: 9, fontWeight: 900, color: "#111", fontFamily: "Georgia, serif", letterSpacing: 2, textTransform: "uppercase" }}>
                The Daily Market
              </span>
              <span style={{ fontSize: 8, color: "#888", fontFamily: "Georgia, serif" }}>Est. 1887</span>
            </div>

            {/* big headline */}
            <div style={{
              fontSize: row < 2 ? 17 : 15,
              fontWeight: 900,
              color: "#0a0a0a",
              fontFamily: "Georgia, 'Times New Roman', serif",
              lineHeight: 1.2,
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: 0.2,
            }}>
              {headline}
            </div>

            {/* subheadline */}
            <div style={{
              fontSize: 10,
              color: "#444",
              fontFamily: "Georgia, serif",
              lineHeight: 1.45,
              marginBottom: 7,
              fontStyle: "italic",
            }}>
              {sub}
            </div>

            {/* simulated body-text rules */}
            {[100, 95, 88, 100, 72, 90, 80, 100, 65].map((w, j) => (
              <div key={j} style={{
                height: 5,
                background: "#bbb",
                borderRadius: 1,
                marginBottom: 4,
                width: `${w}%`,
                opacity: 0.55,
              }} />
            ))}

            {/* divider + second column stub */}
            <div style={{ borderTop: "1px solid #aaa", marginTop: 8, paddingTop: 6 }}>
              {[85, 100, 60].map((w, j) => (
                <div key={j} style={{ height: 4, background: "#ccc", borderRadius: 1, marginBottom: 4, width: `${w}%`, opacity: 0.4 }} />
              ))}
            </div>
          </div>
        );
      })}

      {/* "The noise never stops" overlay — appears near end */}
      <div style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: labelOp,
      }}>
        <div style={{
          background: "rgba(0,0,0,0.82)",
          border: `3px solid ${C.red}`,
          borderRadius: 18,
          padding: "22px 52px",
          fontSize: 34,
          fontWeight: 900,
          color: C.red,
          fontFamily: "Arial Black, Arial, sans-serif",
          letterSpacing: 1,
          textAlign: "center",
          boxShadow: `0 0 60px ${C.red}66`,
        }}>
          😵 The noise never stops
        </div>
      </div>
    </AbsoluteFill>
  );
}

// ── RevealScene ───────────────────────────────────────────────────────────
const STOCKS = [
  { ticker: "NVDA", name: "NVIDIA Corp", verdict: "BUY", color: C.green, change: "+4.2%", price: "$875.40" },
  { ticker: "TSLA", name: "Tesla Inc", verdict: "HOLD", color: C.amber, change: "-1.1%", price: "$248.60" },
  { ticker: "AAPL", name: "Apple Inc", verdict: "BUY", color: C.green, change: "+0.8%", price: "$213.90" },
];

const FEATURE_PILLS = [
  { icon: "⚡", text: "Instant AI verdicts" },
  { icon: "📊", text: "Live price charts" },
  { icon: "🔔", text: "Price alerts" },
  { icon: "📰", text: "News sentiment" },
  { icon: "💼", text: "Portfolio tracker" },
  { icon: "🌍", text: "Global markets" },
];

function RevealScene() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headerSp = spring({ frame, fps, config: { stiffness: 100, damping: 20 } });
  const headerY = interpolate(headerSp, [0, 1], [-80, 0]);
  const headerOp = interpolate(headerSp, [0, 1], [0, 1]);

  return (
    <AbsoluteFill style={{ background: C.bg, flexDirection: "column", justifyContent: "center", padding: "40px 36px" }}>
      {/* top glow */}
      <div style={{
        position: "absolute", width: 700, height: 400, borderRadius: "50%",
        background: `radial-gradient(circle, ${C.accent}30 0%, transparent 70%)`,
        top: -100, left: "50%", transform: "translateX(-50%)", pointerEvents: "none",
      }} />

      {/* ── header ── */}
      <div style={{
        opacity: headerOp, transform: `translateY(${headerY}px)`,
        display: "flex", alignItems: "center", gap: 16, marginBottom: 10,
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: 14,
          background: `linear-gradient(135deg, ${C.accent}, ${C.accent2})`,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26,
        }}>📈</div>
        <div>
          <div style={{ fontSize: 36, fontWeight: 900, color: C.white, fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -1, lineHeight: 1 }}>
            StockSight
          </div>
          <div style={{ fontSize: 16, color: C.muted, fontFamily: "Arial, sans-serif" }}>AI Stock Research — Free</div>
        </div>
      </div>

      {/* ── tagline ── */}
      <div style={{ opacity: fadeIn(frame, 18), transform: slideUp(frame, 18), marginBottom: 22 }}>
        <span style={{ fontSize: 26, fontWeight: 700, color: C.accent2, fontFamily: "Arial, sans-serif", lineHeight: 1.3 }}>
          Research any stock in seconds ⚡
        </span>
      </div>

      {/* ── stock cards ── */}
      {STOCKS.map((s, i) => {
        const delay = 28 + i * 16;
        const sp = spring({ frame: frame - delay, fps, config: { stiffness: 120, damping: 18 } });
        const cardOp = Math.max(0, Math.min(1, interpolate(sp, [0, 0.3], [0, 1])));
        const cardX = interpolate(sp, [0, 1], [100, 0]);

        return (
          <div key={s.ticker} style={{
            opacity: cardOp, transform: `translateX(${cardX}px)`,
            background: C.card, border: `1px solid ${C.border}`,
            borderLeft: `4px solid ${s.color}`, borderRadius: 18,
            padding: "18px 22px", marginBottom: 14,
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <div>
              <div style={{ fontSize: 27, fontWeight: 900, color: C.white, fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -0.5 }}>
                {s.ticker}
              </div>
              <div style={{ fontSize: 16, color: C.muted, fontFamily: "Arial, sans-serif" }}>{s.name}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: C.white, fontFamily: "Arial, sans-serif" }}>{s.price}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: s.change.startsWith("+") ? C.green : C.red, fontFamily: "Arial, sans-serif" }}>
                {s.change}
              </div>
            </div>
            <div style={{
              background: `${s.color}22`, border: `1px solid ${s.color}66`,
              borderRadius: 30, padding: "7px 20px",
              fontSize: 18, fontWeight: 900, color: s.color,
              fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: 1,
            }}>
              {s.verdict}
            </div>
          </div>
        );
      })}

      {/* ── feature pills grid ── */}
      <div style={{ opacity: fadeIn(frame, 88), transform: slideUp(frame, 88), marginBottom: 18 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {FEATURE_PILLS.map((pill, i) => (
            <div key={i} style={{
              background: `${C.accent}18`, border: `1px solid ${C.accent}44`,
              borderRadius: 50, padding: "10px 20px",
              fontSize: 18, color: C.accent2, fontFamily: "Arial, sans-serif",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <span>{pill.icon}</span>
              <span style={{ fontWeight: 600 }}>{pill.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── AI banner ── */}
      <div style={{
        opacity: fadeIn(frame, 108),
        transform: `scale(${interpolate(spring({ frame: frame - 108, fps, config: { stiffness: 200, damping: 14 } }), [0, 1], [0.85, 1])})`,
        marginBottom: 18,
        background: `linear-gradient(135deg, ${C.accent}28, ${C.accent2}14)`,
        border: `1px solid ${C.accent}55`, borderRadius: 16,
        padding: "18px 28px", textAlign: "center",
      }}>
        <span style={{ fontSize: 21, fontWeight: 700, color: C.accent2, fontFamily: "Arial, sans-serif" }}>
          ✨ Powered by AI · Updated in real time · Always free
        </span>
      </div>

      {/* ── stats row ── */}
      <div style={{ opacity: fadeIn(frame, 124), transform: slideUp(frame, 124) }}>
        <div style={{ display: "flex", gap: 14 }}>
          {[
            { val: "10,000+", label: "Stocks covered" },
            { val: "Real-time", label: "Price data" },
            { val: "AI-powered", label: "Buy/Hold/Sell" },
          ].map((stat, i) => (
            <div key={i} style={{
              flex: 1, background: C.card, border: `1px solid ${C.border}`,
              borderRadius: 16, padding: "16px 14px", textAlign: "center",
            }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: C.white, fontFamily: "Arial Black, Arial, sans-serif", letterSpacing: -0.5 }}>
                {stat.val}
              </div>
              <div style={{ fontSize: 14, color: C.muted, fontFamily: "Arial, sans-serif", marginTop: 3 }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
}

// ── CtaScene ──────────────────────────────────────────────────────────────
function CtaScene() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoSp = spring({ frame, fps, config: { stiffness: 140, damping: 16 } });
  const logoScale = interpolate(logoSp, [0, 1], [0.5, 1]);
  const logoOp = interpolate(logoSp, [0, 0.3], [0, 1], { extrapolateRight: "clamp" });

  const btnSp = spring({ frame: frame - 55, fps, config: { stiffness: 160, damping: 14 } });
  const btnScale = interpolate(btnSp, [0, 1], [0.7, 1]);
  const btnOp = interpolate(btnSp, [0, 0.3], [0, 1], { extrapolateRight: "clamp" });

  const pulseScale = interpolate(Math.sin((frame / 12) * Math.PI), [-1, 1], [0.97, 1.03]);

  return (
    <AbsoluteFill
      style={{
        background: C.bg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        padding: "80px 60px",
      }}
    >
      <div style={{
        position: "absolute",
        width: 800,
        height: 800,
        borderRadius: "50%",
        background: `radial-gradient(circle, ${C.accent}28 0%, transparent 65%)`,
        pointerEvents: "none",
      }} />

      <div style={{
        opacity: logoOp,
        transform: `scale(${logoScale})`,
        marginBottom: 36,
        width: 110,
        height: 110,
        borderRadius: 30,
        background: `linear-gradient(135deg, ${C.accent}, ${C.accent2})`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 56,
        boxShadow: `0 0 60px ${C.accent}55`,
      }}>
        📈
      </div>

      <div style={{ opacity: fadeIn(frame, 20), transform: slideUp(frame, 20), textAlign: "center", marginBottom: 12 }}>
        <span style={{
          fontSize: 56,
          fontWeight: 900,
          color: C.white,
          fontFamily: "Arial Black, Arial, sans-serif",
          letterSpacing: -1.5,
        }}>
          StockSight
        </span>
      </div>

      <div style={{ opacity: fadeIn(frame, 38), transform: slideUp(frame, 38), textAlign: "center", marginBottom: 52 }}>
        <span style={{ fontSize: 26, color: C.muted, fontFamily: "Arial, sans-serif" }}>
          AI stock research for everyone
        </span>
      </div>

      <div style={{ opacity: btnOp, transform: `scale(${btnScale * pulseScale})`, marginBottom: 44 }}>
        <div style={{
          background: `linear-gradient(135deg, ${C.accent}, ${C.accent2})`,
          borderRadius: 24,
          padding: "26px 72px",
          fontSize: 30,
          fontWeight: 900,
          color: C.white,
          fontFamily: "Arial Black, Arial, sans-serif",
          letterSpacing: -0.5,
          boxShadow: `0 8px 40px ${C.accent}66`,
          textAlign: "center",
        }}>
          stocksightai.com
        </div>
      </div>

      <div style={{ opacity: fadeIn(frame, 90), display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center" }}>
        {["✅ Free to use", "⚡ Instant AI verdicts", "📊 Live charts"].map((tag, i) => (
          <div
            key={i}
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 50,
              padding: "12px 28px",
              fontSize: 22,
              color: C.white,
              fontFamily: "Arial, sans-serif",
            }}
          >
            {tag}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
}

// ── main export ───────────────────────────────────────────────────────────
export const StockSightAd: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Sequence from={T.hookStart} durationInFrames={T.hookEnd - T.hookStart}>
        <SceneFade><HookScene /></SceneFade>
      </Sequence>
      <Sequence from={T.painStart} durationInFrames={T.painEnd - T.painStart}>
        <SceneFade><PainScene /></SceneFade>
      </Sequence>
      <Sequence from={T.newsStart} durationInFrames={T.newsEnd - T.newsStart}>
        <SceneFade><NewspaperScene /></SceneFade>
      </Sequence>
      <Sequence from={T.revealStart} durationInFrames={T.revealEnd - T.revealStart}>
        <SceneFade><RevealScene /></SceneFade>
      </Sequence>
      <Sequence from={T.ctaStart} durationInFrames={T.ctaEnd - T.ctaStart}>
        <SceneFade><CtaScene /></SceneFade>
      </Sequence>
    </AbsoluteFill>
  );
};
