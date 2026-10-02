// Rainplan: learns how weather and weekday move your sales, then forecasts the week and suggests staff numbers.
import { useMemo, useState } from "react";
import { csvObjects, num } from "./lib/csv";
import { moneyFmt } from "./lib/money";
import { useStored } from "./lib/store";
import { addDays, prettyDate, todayISO } from "./lib/time";
import { ImportBox, Section, Stat, Stats } from "./ui/kit";

const T = "rainplan";
type Day = { date: string; sales: number; temp: number; rain: boolean };
type Fc = { date: string; temp: number; rain: boolean };
const dow = (d: string) => new Date(d + "T12:00:00Z").getUTCDay();
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sampleHistory(): Day[] {
  const out: Day[] = []; let seed = 7;
  const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 56; i >= 1; i--) {
    const date = addDays(todayISO(), -i), wd = dow(date);
    const temp = Math.round(22 + 6 * Math.sin(i / 9) + (r() - 0.5) * 6), rain = r() < 0.2;
    const base = [900, 520, 480, 500, 560, 760, 1050][wd];
    out.push({ date, temp, rain, sales: Math.round(base * (1 + (temp - 22) * 0.035) * (rain ? 0.62 : 1) * (0.9 + r() * 0.2)) });
  }
  return out;
}

/** Weekday baseline, then a linear temperature effect and a rain multiplier fitted on the ratios. */
function fit(h: Day[]) {
  const byDow = Array.from({ length: 7 }, (_, d) => h.filter(x => dow(x.date) === d && !x.rain));
  const all = h.reduce((a, x) => a + x.sales, 0) / Math.max(1, h.length);
  const base = byDow.map(list => (list.length ? list.reduce((a, x) => a + x.sales, 0) / list.length : all));
  const pts = h.filter(x => !x.rain).map(x => ({ t: x.temp, y: x.sales / base[dow(x.date)] }));
  const mt = pts.reduce((a, p) => a + p.t, 0) / Math.max(1, pts.length), my = pts.reduce((a, p) => a + p.y, 0) / Math.max(1, pts.length);
  const slope = pts.reduce((a, p) => a + (p.t - mt) * (p.y - my), 0) / Math.max(1e-9, pts.reduce((a, p) => a + (p.t - mt) ** 2, 0));
  const rainy = h.filter(x => x.rain);
  const tempAdj = (x: Day | Fc) => Math.max(0.3, my + slope * (x.temp - mt));
  const rainF = rainy.length ? rainy.reduce((a, x) => a + x.sales / (base[dow(x.date)] * tempAdj(x)), 0) / rainy.length : 0.75;
  const predict = (x: Day | Fc) => base[dow(x.date)] * tempAdj(x) * (x.rain ? rainF : 1);
  const err = h.length ? h.reduce((a, x) => a + Math.abs(predict(x) - x.sales) / Math.max(1, x.sales), 0) / h.length : 0;
  return { base, slope, mt, rainF, predict, err, perDegree: slope / Math.max(1e-9, my) };
}

export default function Rainplan() {
  const [hist, setHist] = useStored<Day[]>(T, "hist", sampleHistory());
  const [perStaff, setPerStaff] = useStored(T, "perStaff", 250);
  const [minStaff, setMinStaff] = useStored(T, "minStaff", 2);
  const [cur, setCur] = useStored(T, "cur", "TND");
  const [fc, setFc] = useStored<Fc[]>(T, "fc", Array.from({ length: 7 }, (_, i) => ({ date: addDays(todayISO(), i + 1), temp: 24, rain: false })));
  const [loc, setLoc] = useStored(T, "loc", { lat: "36.80", lon: "10.18" });
  const [msg, setMsg] = useState("");
  const [today, setToday] = useState({ sales: "", temp: "24", rain: false });
  const money = moneyFmt(cur);
  const m = useMemo(() => fit(hist), [hist]);

  const rows = fc.map(f => { const p = m.predict(f); return { ...f, p, staff: Math.max(minStaff, Math.ceil(p / perStaff)) }; });
  const loadWeather = async () => {
    setMsg("Fetching forecast…");
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=temperature_2m_max,precipitation_probability_max&timezone=auto&forecast_days=8`);
      const j = await r.json();
      const days: Fc[] = j.daily.time.slice(1, 8).map((date: string, i: number) => ({ date, temp: Math.round(j.daily.temperature_2m_max[i + 1]), rain: (j.daily.precipitation_probability_max[i + 1] ?? 0) >= 50 }));
      setFc(days); setMsg("Forecast filled from Open-Meteo.");
    } catch { setMsg("Could not reach the weather service. Type the forecast in instead."); }
  };

  return (
    <div className="stack">
      <Section title="What moves your sales">
        <Stats>
          <Stat value={`${m.perDegree >= 0 ? "+" : ""}${(m.perDegree * 100).toFixed(1)}%`} label="Per extra degree" />
          <Stat value={`${Math.round((m.rainF - 1) * 100)}%`} label="On rainy days" tone={m.rainF < 1 ? "bad" : "good"} />
          <Stat value={DOW[m.base.indexOf(Math.max(...m.base))]} label="Busiest day" />
          <Stat value={`±${Math.round(m.err * 100)}%`} label="Typical forecast error" />
          <Stat value={hist.length} label="Days of history" />
        </Stats>
        <div className="rp-bars">{m.base.map((b, i) => <div key={i}><span style={{ height: `${(b / Math.max(...m.base)) * 100}%` }} /><em>{DOW[i]}</em></div>)}</div>
      </Section>

      <Section title="Next 7 days" aside={<button className="btn small" onClick={loadWeather}>Fill forecast</button>}>
        <div className="row" style={{ marginBottom: 12, alignItems: "flex-end" }}>
          <label className="field" style={{ flex: "0 0 110px" }}><span>Latitude</span><input id="rp-lat" className="input num" value={loc.lat} onChange={e => setLoc({ ...loc, lat: e.target.value })} /></label>
          <label className="field" style={{ flex: "0 0 110px" }}><span>Longitude</span><input id="rp-lon" className="input num" value={loc.lon} onChange={e => setLoc({ ...loc, lon: e.target.value })} /></label>
          <label className="field" style={{ flex: "0 0 150px" }}><span>Sales one person handles</span><input id="rp-ps" className="input num" value={perStaff} onChange={e => setPerStaff(Math.max(1, num(e.target.value)))} /></label>
          <label className="field" style={{ flex: "0 0 110px" }}><span>Minimum staff</span><input id="rp-min" type="number" min={1} className="input num" value={minStaff} onChange={e => setMinStaff(Math.max(1, +e.target.value || 1))} /></label>
          <label className="field" style={{ flex: "0 0 90px" }}><span>Currency</span><input id="rp-cur" className="input" value={cur} onChange={e => setCur(e.target.value.toUpperCase().slice(0, 3))} /></label>
        </div>
        {msg && <p className="note" style={{ marginBottom: 10 }}>{msg}</p>}
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Day</th><th>Max temp °C</th><th>Rain likely</th><th className="r">Expected sales</th><th className="r">Staff</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={r.date}>
              <td>{prettyDate(r.date)}</td>
              <td><input className="input num" style={{ width: 70 }} aria-label="Temperature" value={r.temp} onChange={e => setFc(fc.map((x, k) => k === i ? { ...x, temp: num(e.target.value) } : x))} /></td>
              <td><input type="checkbox" aria-label="Rain likely" checked={r.rain} onChange={e => setFc(fc.map((x, k) => k === i ? { ...x, rain: e.target.checked } : x))} /></td>
              <td className="r">{money(Math.round(r.p))}</td>
              <td className="r"><span className="rp-staff">{Array.from({ length: r.staff }, (_, k) => <i key={k} />)}</span> <strong>{r.staff}</strong></td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="note" style={{ marginTop: 10 }}>Forecast from Open-Meteo, free for non-commercial use. A business can type the forecast in instead.</p>
      </Section>

      <div className="grid2">
        <Section title="Log today">
          <form className="row" style={{ alignItems: "flex-end" }} onSubmit={e => { e.preventDefault(); const s = num(today.sales); if (!s) return; setHist([...hist.filter(h => h.date !== todayISO()), { date: todayISO(), sales: s, temp: num(today.temp), rain: today.rain }]); setToday({ ...today, sales: "" }); }}>
            <label className="field"><span>Sales today</span><input id="rp-s" className="input num" value={today.sales} onChange={e => setToday({ ...today, sales: e.target.value })} /></label>
            <label className="field"><span>Max temp</span><input id="rp-t" className="input num" value={today.temp} onChange={e => setToday({ ...today, temp: e.target.value })} /></label>
            <label className="check" style={{ paddingBottom: 10 }}><input type="checkbox" checked={today.rain} onChange={e => setToday({ ...today, rain: e.target.checked })} />It rained</label>
            <button className="btn primary" type="submit">Save</button>
          </form>
          <p className="note" style={{ marginTop: 10 }}>The forecast gets better with every day you log.</p>
        </Section>
        <Section title="Import history">
          <ImportBox label="CSV with date, sales, temp, rain (yes or no)" rows={3} placeholder={"date,sales,temp,rain\n2026-08-01,820,31,no"} onText={t => setHist(csvObjects(t).map(r => ({ date: r.date, sales: num(r.sales), temp: num(r.temp || r.temperature), rain: /^(y|yes|1|true|oui)/i.test(r.rain || "") })).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.sales > 0))} />
          <button className="btn ghost small danger" style={{ marginTop: 8 }} onClick={() => setHist([])}>Clear history</button>
        </Section>
      </div>
      <style>{`.rp-bars{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;height:110px;margin-top:18px}.rp-bars div{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px}.rp-bars span{width:100%;background:var(--accent);border-radius:4px 4px 0 0}.rp-bars em{font-style:normal;font-family:var(--mono);font-size:11px;color:var(--muted)}
      .rp-staff{display:inline-flex;gap:2px;vertical-align:middle}.rp-staff i{width:6px;height:14px;border-radius:3px;background:var(--accent)}`}</style>
    </div>
  );
}
