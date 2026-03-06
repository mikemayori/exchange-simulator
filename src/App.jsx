import { useState, useEffect, useRef, useCallback } from "react";

/* ─── constants ─── */
const PAIRS = [
    { symbol: "BTC/USD", base: 67250, vol: 180, type: "crypto" },
    { symbol: "ETH/USD", base: 3385, vol: 55, type: "crypto" },
    { symbol: "EUR/USD", base: 1.0852, vol: 0.0018, type: "fiat" },
    { symbol: "GBP/USD", base: 1.2641, vol: 0.0025, type: "fiat" },
    { symbol: "SOL/USD", base: 148.6, vol: 3.2, type: "crypto" },
    { symbol: "JPY/USD", base: 0.0067, vol: 0.00008, type: "fiat" },
];

const PODS = ["pod-7f2a", "pod-3b9c", "pod-e1d5"];

const fmt = (sym, v) => {
    if (sym.startsWith("BTC")) return v.toFixed(2);
    if (sym.startsWith("ETH") || sym.startsWith("SOL")) return v.toFixed(2);
    if (sym.startsWith("JPY")) return v.toFixed(5);
    return v.toFixed(4);
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ─── market simulator: brownian motion ─── */
function nextMarketPrice(prev, pair, t) {
    const drift = Math.sin(t * 0.13) * pair.vol * 0.3;
    const shock = (Math.random() - 0.5) * pair.vol * 0.7;
    const mean = pair.base + Math.sin(t * 0.02) * pair.vol * 2;
    const revert = (mean - prev) * 0.02;
    return prev + drift + shock + revert;
}

/* ─── color helpers ─── */
const staleColor = (ms) => {
    if (ms < 2000) return "#00e87b";
    if (ms < 8000) return "#a8e000";
    if (ms < 15000) return "#ffc400";
    if (ms < 25000) return "#ff7a2f";
    return "#ff2e4c";
};
const staleTag = (ms) => {
    if (ms < 2000) return "LIVE";
    if (ms < 8000) return "FRESH";
    if (ms < 15000) return "AGING";
    if (ms < 25000) return "STALE";
    return "CRITICAL";
};

/* ─── tiny components ─── */
const Pill = ({ children, color = "#888" }) => (
    <span style={{
        fontSize: 9, fontWeight: 700, letterSpacing: 1.2,
        color, background: color + "14",
        padding: "2px 7px", borderRadius: 3, lineHeight: 1,
    }}>{children}</span>
);

const Led = ({ on, color = "#00e87b" }) => (
    <span style={{
        display: "inline-block", width: 6, height: 6, borderRadius: "50%",
        background: on ? color : "#2a2a3a",
        boxShadow: on ? `0 0 6px ${color}88` : "none",
        transition: "all .3s",
    }} />
);

/* ─── main ─── */
export default function Simulator() {
    const [running, setRunning] = useState(false);
    const [phase, setPhase] = useState(1);
    const [speed, setSpeed] = useState(1);
    const interval = phase === 1 ? 60 : 10;

    const [tick, setTick] = useState(0);

    const marketRef = useRef(PAIRS.map(p => p.base));
    const [market, setMarket] = useState(PAIRS.map(p => p.base));

    const curDbRef = useRef(PAIRS.map(p => ({ price: p.base, at: 0 })));
    const curAppRef = useRef(PAIRS.map(p => ({ price: p.base, at: 0 })));
    const [curApp, setCurApp] = useState(PAIRS.map(p => ({ price: p.base, at: 0 })));
    const [curLogs, setCurLogs] = useState([]);
    const [curActivePod, setCurActivePod] = useState(null);
    const [curDbWriteT, setCurDbWriteT] = useState(0);
    const [curPropT, setCurPropT] = useState(0);

    const proAppRef = useRef(PAIRS.map(p => ({ price: p.base, at: 0 })));
    const [proApp, setProApp] = useState(PAIRS.map(p => ({ price: p.base, at: 0 })));
    const [proLogs, setProLogs] = useState([]);
    const proLeader = "pod-7f2a";
    const [proDbWriteT, setProDbWriteT] = useState(0);
    const [proPubT, setProPubT] = useState(0);

    const [history, setHistory] = useState([]);
    const [stats, setStats] = useState({ curFetches: 0, curFails: 0, proFetches: 0, proRetries: 0 });

    const curStaleness = tick > 0 ? (tick - (curAppRef.current[0]?.at || 0)) * 1000 : 0;
    const proStaleness = tick > 0 ? (tick - (proAppRef.current[0]?.at || 0)) * 1000 : 0;

    const pushLog = useCallback((side, entry) => {
        const setter = side === "cur" ? setCurLogs : setProLogs;
        setter(prev => [entry, ...prev].slice(0, 40));
    }, []);

    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => {
            setTick(prev => {
                const t = prev + 1;

                const newMarket = marketRef.current.map((p, i) => nextMarketPrice(p, PAIRS[i], t));
                marketRef.current = newMarket;
                setMarket([...newMarket]);

                /* ════ CURRENT APPROACH ════ */
                if (t % interval === 0) {
                    const winner = PODS[Math.floor(Math.random() * PODS.length)];
                    PODS.forEach(p => {
                        if (p !== winner) pushLog("cur", { type: "lock-fail", msg: `${p} lost lock race`, t });
                    });
                    pushLog("cur", { type: "lock-ok", msg: `${winner} acquired lock`, t });
                    setCurActivePod(winner);

                    const fail = Math.random() < 0.08;
                    if (fail) {
                        pushLog("cur", { type: "fail", msg: `API call failed — no retry`, t });
                        setStats(s => ({ ...s, curFetches: s.curFetches + 1, curFails: s.curFails + 1 }));
                        setTimeout(() => setCurActivePod(null), 400 / speed);
                    } else {
                        pushLog("cur", { type: "fetch", msg: `Fetched ${PAIRS.length} rates from provider`, t });
                        setStats(s => ({ ...s, curFetches: s.curFetches + 1 }));
                        const snap = newMarket.map(p => ({ price: p, at: t }));
                        curDbRef.current = snap;
                        setCurDbWriteT(t);
                        pushLog("cur", { type: "write", msg: `Wrote rates to DB`, t });
                        setTimeout(() => setCurActivePod(null), 300 / speed);
                    }
                }

                const pollGap = Math.max(Math.floor(interval * 0.6), 3);
                if (t % pollGap === 0 && t > 0) {
                    const dbData = curDbRef.current;
                    curAppRef.current = dbData;
                    setCurApp([...dbData]);
                    setCurPropT(t);
                    if (t % (pollGap * 3) === 0) {
                        pushLog("cur", { type: "poll", msg: `App polled DB for rates`, t });
                    }
                }

                /* ════ PROPOSED APPROACH ════ */
                if (t % interval === 0) {
                    pushLog("pro", { type: "leader", msg: `${proLeader} is active leader`, t });

                    const fail = Math.random() < 0.08;
                    if (fail) {
                        pushLog("pro", { type: "fail", msg: `API failed — retrying...`, t });
                        setStats(s => ({ ...s, proRetries: s.proRetries + 1 }));
                        pushLog("pro", { type: "retry-ok", msg: `Retry #1 succeeded`, t });
                    }

                    pushLog("pro", { type: "fetch", msg: `Fetched ${PAIRS.length} rates`, t });
                    setStats(s => ({ ...s, proFetches: s.proFetches + 1 }));

                    const snap = newMarket.map(p => ({ price: p, at: t }));
                    setProDbWriteT(t);
                    pushLog("pro", { type: "write", msg: `Wrote rates to DB`, t });

                    proAppRef.current = snap;
                    setProApp([...snap]);
                    setProPubT(t);
                    pushLog("pro", { type: "pubsub", msg: `Pub/Sub → all ${PODS.length} pods updated`, t });
                }

                if (t % 2 === 0) {
                    const cs = t - (curAppRef.current[0]?.at || 0);
                    const ps = t - (proAppRef.current[0]?.at || 0);
                    setHistory(h => [...h, { t, cur: cs, pro: ps }].slice(-80));
                }

                return t;
            });
        }, 1000 / speed);
        return () => clearInterval(timer);
    }, [running, speed, interval, pushLog]);

    const reset = () => {
        setRunning(false);
        setTick(0);
        const prices = PAIRS.map(p => p.base);
        const recs = PAIRS.map(p => ({ price: p.base, at: 0 }));
        marketRef.current = prices;
        setMarket(prices);
        curDbRef.current = recs.map(r => ({ ...r }));
        curAppRef.current = recs.map(r => ({ ...r }));
        proAppRef.current = recs.map(r => ({ ...r }));
        setCurApp(recs.map(r => ({ ...r })));
        setProApp(recs.map(r => ({ ...r })));
        setCurLogs([]); setProLogs([]);
        setHistory([]);
        setCurActivePod(null);
        setStats({ curFetches: 0, curFails: 0, proFetches: 0, proRetries: 0 });
        setCurDbWriteT(0); setCurPropT(0); setProDbWriteT(0); setProPubT(0);
    };

    const CW = 500, CH = 90;
    const maxY = Math.max(interval * 2.5, 30);
    const makePath = (key) => {
        if (history.length < 2) return "";
        return history.map((d, i) => {
            const x = (i / (history.length - 1)) * CW;
            const y = CH - (clamp(d[key], 0, maxY) / maxY) * (CH - 4);
            return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");
    };
    const makeArea = (key) => {
        if (history.length < 2) return "";
        const pts = history.map((d, i) => {
            const x = (i / (history.length - 1)) * CW;
            const y = CH - (clamp(d[key], 0, maxY) / maxY) * (CH - 4);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        });
        return `M${pts.join(" L")} L${CW},${CH} L0,${CH} Z`;
    };

    const logColors = {
        "lock-ok": "#ffc400", "lock-fail": "#333", fetch: "#00b4ff",
        write: "#ff7a2f", poll: "#776633", fail: "#ff2e4c",
        leader: "#b46eff", "retry-ok": "#a8e000", pubsub: "#00e87b",
    };

    const LogLine = ({ e }) => (
        <div style={{
            fontFamily: "var(--mono)", fontSize: 10, padding: "1.5px 0",
            color: logColors[e.type] || "#555",
            opacity: e.type === "lock-fail" ? 0.4 : 0.9,
        }}>
            <span style={{ color: "#2a2a3a" }}>T+{e.t}s</span>{" "}
            <span style={{ fontWeight: 600 }}>[{e.type.toUpperCase()}]</span>{" "}
            {e.msg}
        </div>
    );

    const RateRow = ({ pair, appRec, mktPrice }) => {
        const diff = Math.abs(mktPrice - appRec.price);
        const pct = (diff / Math.abs(mktPrice)) * 100;
        const col = pct > 1 ? "#ff2e4c" : pct > 0.3 ? "#ffc400" : pct > 0.05 ? "#a8e000" : "#00e87b";
        return (
            <div style={{
                display: "grid", gridTemplateColumns: "68px 1fr 1fr 72px",
                padding: "4px 0", borderBottom: "1px solid #12122a", fontSize: 11, alignItems: "center",
            }}>
                <span style={{ color: pair.type === "crypto" ? "#6a6aaa" : "#6a8a6a", fontWeight: 500 }}>{pair.symbol}</span>
                <span style={{ color: "#ccc", fontVariantNumeric: "tabular-nums" }}>{fmt(pair.symbol, appRec.price)}</span>
                <span style={{ color: "#444", fontVariantNumeric: "tabular-nums", fontSize: 10 }}>{fmt(pair.symbol, mktPrice)}</span>
                <span style={{ color: col, fontWeight: 600, textAlign: "right", fontSize: 10 }}>
          {pct < 0.01 ? "≈ exact" : `${pct.toFixed(2)}% off`}
        </span>
            </div>
        );
    };

    const PipeStep = ({ label, active, color }) => (
        <div style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "3px 8px", borderRadius: 4,
            background: active ? color + "15" : "#0a0a18",
            border: `1px solid ${active ? color + "44" : "#16162a"}`,
            transition: "all .4s",
        }}>
            <Led on={active} color={color} />
            <span style={{ fontSize: 8, color: active ? color : "#333", fontWeight: 700, letterSpacing: 0.8 }}>
        {label}
      </span>
        </div>
    );

    const Arrow = () => <span style={{ color: "#1a1a2e", fontSize: 10 }}>→</span>;

    return (
        <div style={{
            "--mono": "'JetBrains Mono', 'Fira Code', monospace",
            "--sans": "'Instrument Sans', 'DM Sans', sans-serif",
            fontFamily: "var(--mono)",
            background: "#08081a",
            color: "#d0d0e0",
            minHeight: "100vh",
            padding: "14px 18px",
        }}>
            <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Instrument+Sans:wght@400;600;700&display=swap" rel="stylesheet" />
            <style>{`
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:#2a2a3a;border-radius:4px}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      `}</style>

            {/* HEADER */}
            <header style={{
                display: "flex", justifyContent: "space-between", alignItems: "flex-start",
                marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #16162a",
            }}>
                <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <h1 style={{ fontFamily: "var(--sans)", fontSize: 19, fontWeight: 700, color: "#fff", margin: 0 }}>
                            Exchange Rate Pipeline
                        </h1>
                        <Pill color="#b46eff">SIMULATOR</Pill>
                        {running && <span style={{ fontSize: 9, color: "#00e87b", animation: "pulse 1.5s infinite", fontWeight: 600 }}>● LIVE</span>}
                    </div>
                    <p style={{ fontSize: 10, color: "#3a3a5a", margin: "3px 0 0" }}>
                        Side-by-side: lock-per-tick + DB poll vs leader election + Pub/Sub push
                    </p>
                </div>
                <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                        T+{tick}s
                    </div>
                    <div style={{ fontSize: 9, color: "#3a3a5a", marginTop: 3 }}>
                        Phase {phase} · {interval}s · {speed}x
                    </div>
                </div>
            </header>

            {/* CONTROLS */}
            <div style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
                <button onClick={() => setRunning(!running)} style={{
                    padding: "7px 22px", borderRadius: 4, border: "none", cursor: "pointer",
                    background: running ? "#ff2e4c" : "#00e87b", color: "#08081a",
                    fontWeight: 700, fontSize: 11, fontFamily: "var(--mono)", letterSpacing: 1,
                    transition: "background .2s",
                }}>
                    {running ? "■ STOP" : "▶ RUN"}
                </button>
                <button onClick={reset} style={{
                    padding: "7px 14px", borderRadius: 4, border: "1px solid #2a2a3a",
                    background: "transparent", color: "#5a5a7a", fontSize: 11,
                    fontFamily: "var(--mono)", cursor: "pointer",
                }}>RESET</button>

                <div style={{ width: 1, height: 18, background: "#1a1a2e", margin: "0 6px" }} />
                <span style={{ fontSize: 8, color: "#3a3a5a", fontWeight: 700, letterSpacing: 1 }}>PHASE</span>
                {[1, 2].map(p => (
                    <button key={p} onClick={() => setPhase(p)} style={{
                        padding: "5px 12px", borderRadius: 4, cursor: "pointer",
                        border: `1px solid ${phase === p ? "#ffc400" : "#16162a"}`,
                        background: phase === p ? "#ffc40010" : "transparent",
                        color: phase === p ? "#ffc400" : "#3a3a5a",
                        fontSize: 10, fontFamily: "var(--mono)", fontWeight: phase === p ? 700 : 400,
                    }}>
                        {p === 1 ? "60s" : "10s"}
                    </button>
                ))}

                <div style={{ width: 1, height: 18, background: "#1a1a2e", margin: "0 6px" }} />
                <span style={{ fontSize: 8, color: "#3a3a5a", fontWeight: 700, letterSpacing: 1 }}>SPEED</span>
                {[1, 5, 10, 30].map(s => (
                    <button key={s} onClick={() => setSpeed(s)} style={{
                        padding: "4px 10px", borderRadius: 3, cursor: "pointer",
                        border: `1px solid ${speed === s ? "#00b4ff" : "#16162a"}`,
                        background: speed === s ? "#00b4ff10" : "transparent",
                        color: speed === s ? "#00b4ff" : "#2a2a4a",
                        fontSize: 10, fontFamily: "var(--mono)",
                    }}>
                        {s}x
                    </button>
                ))}

                {/* summary pills */}
                <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
                    <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 8, color: "#4a4a6a", letterSpacing: 1 }}>CURRENT</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: staleColor(curStaleness), fontVariantNumeric: "tabular-nums" }}>
                            {(curStaleness / 1000).toFixed(1)}s
                        </div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 8, color: "#4a4a6a", letterSpacing: 1 }}>PROPOSED</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: staleColor(proStaleness), fontVariantNumeric: "tabular-nums" }}>
                            {(proStaleness / 1000).toFixed(1)}s
                        </div>
                    </div>
                </div>
            </div>

            {/* STALENESS CHART */}
            <div style={{
                background: "#0b0b1c", border: "1px solid #16162a", borderRadius: 6,
                padding: "10px 14px", marginBottom: 14,
            }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: "#4a4a6a", letterSpacing: 1.2 }}>
            APP-LEVEL STALENESS OVER TIME
          </span>
                    <div style={{ display: "flex", gap: 16, fontSize: 9 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 14, height: 2, background: "#ff7a2f", display: "inline-block", borderRadius: 1 }} />
              <span style={{ color: "#666" }}>Current</span>
            </span>
                        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 14, height: 2, background: "#00e87b", display: "inline-block", borderRadius: 1 }} />
              <span style={{ color: "#666" }}>Proposed</span>
            </span>
                    </div>
                </div>
                <svg width="100%" viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" style={{ display: "block" }}>
                    {[0, 0.25, 0.5, 0.75, 1].map(p => (
                        <line key={p} x1={0} y1={p * CH} x2={CW} y2={p * CH} stroke="#13132a" strokeWidth={0.5} />
                    ))}
                    <text x={3} y={10} fill="#2a2a3a" fontSize={7} fontFamily="monospace">{maxY.toFixed(0)}s</text>
                    <text x={3} y={CH - 2} fill="#2a2a3a" fontSize={7} fontFamily="monospace">0s</text>
                    <path d={makeArea("cur")} fill="#ff7a2f06" />
                    <path d={makeArea("pro")} fill="#00e87b06" />
                    <path d={makePath("cur")} fill="none" stroke="#ff7a2f" strokeWidth={1.6} strokeLinejoin="round" />
                    <path d={makePath("pro")} fill="none" stroke="#00e87b" strokeWidth={1.6} strokeLinejoin="round" />
                </svg>
            </div>

            {/* SIDE BY SIDE */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>

                {/* ── CURRENT ── */}
                <div style={{ background: "#0b0b1c", border: "1px solid #2a1a16", borderRadius: 6, padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                        <div>
                            <div style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 700, color: "#ff7a2f" }}>Current Proposal</div>
                            <div style={{ fontSize: 8, color: "#4a3020", marginTop: 1, letterSpacing: 0.5 }}>
                                LOCK-PER-TICK · DB POLL · NO PUSH
                            </div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color: staleColor(curStaleness), fontVariantNumeric: "tabular-nums" }}>
                                {(curStaleness / 1000).toFixed(1)}s
                            </div>
                            <Pill color={staleColor(curStaleness)}>{staleTag(curStaleness)}</Pill>
                        </div>
                    </div>

                    <div style={{ display: "flex", gap: 3, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <PipeStep label="LOCK" active={curActivePod !== null} color="#ffc400" />
                        <Arrow />
                        <PipeStep label="FETCH API" active={curActivePod !== null} color="#00b4ff" />
                        <Arrow />
                        <PipeStep label="DB WRITE" active={tick - curDbWriteT < 3} color="#ff7a2f" />
                        <Arrow />
                        <PipeStep label="APP POLLS" active={tick - curPropT < 3} color="#776633" />
                    </div>

                    <div style={{ display: "flex", gap: 5, marginBottom: 8, flexWrap: "wrap" }}>
                        {PODS.map(p => (
                            <div key={p} style={{
                                display: "inline-flex", alignItems: "center", gap: 4,
                                padding: "2px 7px", borderRadius: 3,
                                border: `1px solid ${curActivePod === p ? "#ffc40044" : "#16162a"}`,
                                background: curActivePod === p ? "#ffc40008" : "transparent",
                            }}>
                                <Led on={curActivePod === p} color="#ffc400" />
                                <span style={{ fontSize: 9, color: curActivePod === p ? "#bbb" : "#2a2a3a" }}>{p}</span>
                            </div>
                        ))}
                    </div>

                    <div style={{ marginBottom: 8 }}>
                        <div style={{
                            display: "grid", gridTemplateColumns: "68px 1fr 1fr 72px",
                            fontSize: 7, color: "#3a3a5a", fontWeight: 700, letterSpacing: 1.2,
                            padding: "0 0 3px", borderBottom: "1px solid #12122a",
                        }}>
                            <span>PAIR</span><span>APP RATE</span><span>MARKET</span><span style={{ textAlign: "right" }}>DRIFT</span>
                        </div>
                        {PAIRS.map((p, i) => <RateRow key={p.symbol} pair={p} appRec={curApp[i]} mktPrice={market[i]} />)}
                    </div>

                    <div style={{ height: 4, background: "#10102a", borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
                        <div style={{
                            height: "100%", borderRadius: 2, transition: "width .5s, background .5s",
                            width: `${clamp((curStaleness / (interval * 2.5 * 1000)) * 100, 0, 100)}%`,
                            background: staleColor(curStaleness),
                        }} />
                    </div>

                    <div style={{ height: 140, overflowY: "auto", background: "#07071a", borderRadius: 4, padding: "3px 6px" }}>
                        {curLogs.length === 0
                            ? <div style={{ fontSize: 10, color: "#1a1a2e", padding: 8 }}>Press RUN to start...</div>
                            : curLogs.map((e, i) => <LogLine key={i} e={e} />)
                        }
                    </div>

                    <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 9, color: "#3a3a5a" }}>
                        <span>Fetches: <b style={{ color: "#666" }}>{stats.curFetches}</b></span>
                        <span>Fails: <b style={{ color: stats.curFails > 0 ? "#ff2e4c" : "#666" }}>{stats.curFails}</b></span>
                        <span>Lock races: <b style={{ color: "#666" }}>{stats.curFetches * 2}</b></span>
                    </div>
                </div>

                {/* ── PROPOSED ── */}
                <div style={{ background: "#0b0b1c", border: "1px solid #162a1a", borderRadius: 6, padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                        <div>
                            <div style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 700, color: "#00e87b" }}>Proposed Improvement</div>
                            <div style={{ fontSize: 8, color: "#204a2a", marginTop: 1, letterSpacing: 0.5 }}>
                                LEADER ELECTION · RETRY · PUB/SUB PUSH
                            </div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color: staleColor(proStaleness), fontVariantNumeric: "tabular-nums" }}>
                                {(proStaleness / 1000).toFixed(1)}s
                            </div>
                            <Pill color={staleColor(proStaleness)}>{staleTag(proStaleness)}</Pill>
                        </div>
                    </div>

                    <div style={{ display: "flex", gap: 3, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <PipeStep label="LEADER" active={tick % interval < 3} color="#b46eff" />
                        <Arrow />
                        <PipeStep label="FETCH API" active={tick % interval < 2} color="#00b4ff" />
                        <Arrow />
                        <PipeStep label="DB WRITE" active={tick - proDbWriteT < 3} color="#ff7a2f" />
                        <Arrow />
                        <PipeStep label="PUB/SUB" active={tick - proPubT < 3} color="#00e87b" />
                    </div>

                    <div style={{ display: "flex", gap: 5, marginBottom: 8, flexWrap: "wrap" }}>
                        {PODS.map(p => (
                            <div key={p} style={{
                                display: "inline-flex", alignItems: "center", gap: 4,
                                padding: "2px 7px", borderRadius: 3,
                                border: `1px solid ${p === proLeader ? "#b46eff44" : "#16162a"}`,
                                background: p === proLeader ? "#b46eff08" : "transparent",
                            }}>
                                <Led on={true} color={p === proLeader ? "#b46eff" : "#00e87b"} />
                                <span style={{ fontSize: 9, color: "#999" }}>{p}</span>
                                <Pill color={p === proLeader ? "#b46eff" : "#00e87b"}>
                                    {p === proLeader ? "LEADER" : "SUB"}
                                </Pill>
                            </div>
                        ))}
                    </div>

                    <div style={{ marginBottom: 8 }}>
                        <div style={{
                            display: "grid", gridTemplateColumns: "68px 1fr 1fr 72px",
                            fontSize: 7, color: "#3a3a5a", fontWeight: 700, letterSpacing: 1.2,
                            padding: "0 0 3px", borderBottom: "1px solid #12122a",
                        }}>
                            <span>PAIR</span><span>APP RATE</span><span>MARKET</span><span style={{ textAlign: "right" }}>DRIFT</span>
                        </div>
                        {PAIRS.map((p, i) => <RateRow key={p.symbol} pair={p} appRec={proApp[i]} mktPrice={market[i]} />)}
                    </div>

                    <div style={{ height: 4, background: "#10102a", borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
                        <div style={{
                            height: "100%", borderRadius: 2, transition: "width .5s, background .5s",
                            width: `${clamp((proStaleness / (interval * 2.5 * 1000)) * 100, 0, 100)}%`,
                            background: staleColor(proStaleness),
                        }} />
                    </div>

                    <div style={{ height: 140, overflowY: "auto", background: "#07071a", borderRadius: 4, padding: "3px 6px" }}>
                        {proLogs.length === 0
                            ? <div style={{ fontSize: 10, color: "#1a1a2e", padding: 8 }}>Press RUN to start...</div>
                            : proLogs.map((e, i) => <LogLine key={i} e={e} />)
                        }
                    </div>

                    <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 9, color: "#3a3a5a" }}>
                        <span>Fetches: <b style={{ color: "#666" }}>{stats.proFetches}</b></span>
                        <span>Retries: <b style={{ color: stats.proRetries > 0 ? "#ffc400" : "#666" }}>{stats.proRetries}</b></span>
                        <span>Lock races: <b style={{ color: "#00e87b" }}>0</b></span>
                    </div>
                </div>
            </div>

            {/* MARKET TRUTH BAR */}
            <div style={{
                marginTop: 12, background: "#0b0b1c", border: "1px solid #16162a",
                borderRadius: 6, padding: "8px 14px",
                display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6,
            }}>
                <span style={{ fontSize: 8, color: "#2a2a4a", fontWeight: 700, letterSpacing: 1.2 }}>REAL MARKET (GROUND TRUTH)</span>
                <div style={{ display: "flex", gap: 16 }}>
                    {PAIRS.map((p, i) => (
                        <span key={p.symbol} style={{ fontSize: 10 }}>
              <span style={{ color: "#3a3a5a" }}>{p.symbol} </span>
              <span style={{ color: "#ddd", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
                {fmt(p.symbol, market[i])}
              </span>
            </span>
                    ))}
                </div>
            </div>

            {/* INSIGHT BOX */}
            <div style={{
                marginTop: 12, padding: "10px 14px",
                background: "linear-gradient(135deg, #0c0c1e 0%, #10102a 100%)",
                border: "1px solid #22204a", borderRadius: 6,
            }}>
                <div style={{ fontSize: 9, color: "#b46eff", fontWeight: 700, letterSpacing: 1.2, marginBottom: 4 }}>
                    WHY THIS MATTERS
                </div>
                <div style={{ fontSize: 10, color: "#7a7a9a", lineHeight: 1.7 }}>
                    The goal is accuracy at the <strong style={{ color: "#ccc" }}>point of use</strong> — not just fetch frequency.
                    In Phase 2 (<span style={{ color: "#ffc400" }}>10s</span>), the current proposal's app-level staleness reaches
                    <span style={{ color: "#ff7a2f" }}> ~{interval}–{interval * 2}s</span> because the app polls the DB on a delay.
                    The proposed approach uses <span style={{ color: "#00e87b" }}>Pub/Sub to push</span> rates instantly to all pods,
                    keeping app staleness near <span style={{ color: "#00e87b" }}>0–{interval}s</span>. Same API cost, dramatically better accuracy.
                </div>
            </div>

            {/* GUIDE */}
            <div style={{
                marginTop: 12, padding: "8px 14px", background: "#0b0b1c",
                border: "1px solid #16162a", borderRadius: 6,
                display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10,
                fontSize: 9, color: "#3a3a5a", lineHeight: 1.5,
            }}>
                <div><span style={{ color: "#00e87b", fontWeight: 700 }}>▶ RUN</span><br />Start both pipelines</div>
                <div><span style={{ color: "#ffc400", fontWeight: 700 }}>PHASE</span><br />60s (safe) vs 10s (target)</div>
                <div><span style={{ color: "#00b4ff", fontWeight: 700 }}>SPEED</span><br />30x for instant results</div>
                <div><span style={{ color: "#ff7a2f", fontWeight: 700 }}>DRIFT</span><br />Gap from real market price</div>
            </div>
        </div>
    );
}
