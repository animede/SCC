/* SCC orbit — 軌道計算ユーティリティ (フェーズ2: SGP4/TLE 実装)
   伝播は satellite.js (js/vendor/satellite.min.js, MIT) の SGP4 に委譲する。
   公開APIはフェーズ1(円軌道版)と完全互換 + setTLE/getTLE を追加。
   ブラウザでは window.satellite、Node サーバでは globalThis.satellite が事前ロードされている前提。

   フェーズ3(観測ベースOD対応): 内部実装を createOrbit() ファクトリへ包み、
   SCC.createOrbit() で「真の軌道」「地上予測軌道」「OD作業用インスタンス」を
   それぞれ独立に生成できるようにする(mockdata.js の trueOrbit / SCC.orbit の分離、
   orbitdet.js の候補評価用インスタンスに使用)。SCC.orbit は既定インスタンス
   (createOrbit() を1つ生成したもの)で、既存パネル互換のため従来どおりシングルトンとして残す。 */
(function () {
  "use strict";

  const sat = (typeof satellite !== "undefined") ? satellite : null;
  if (!sat) throw new Error("satellite.js が未ロード (js/vendor/satellite.min.js を先に読み込むこと)");

  const RE = 6378.137;              // 地球半径 [km]
  const MU = 398600.4418;           // 地心重力定数 [km^3/s^2]
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
  const MIN_EL = 5;                 // 運用最低仰角 [deg]

  /* ---- 既定TLE (ISS準拠の軌道要素: i=51.64° / 高度≈418km / 15.50 rev/day) ----
     エポックは架空 (2026-07-01)。実運用では --tle で最新TLEを与えること。 */
  const DEFAULT_TLE = [
    "1 25544U 98067A   26182.50000000  .00016717  00000-0  10270-3 0  9001",
    "2 25544  51.6400 208.9163 0006317  69.9862 290.2553 15.50000000100002",
  ];

  function createOrbit() {
    let satrec = null;
    let tle = { line1: "", line2: "" };
    let period = 5700;      // [s] TLEから導出
    let meanAlt = 550;      // [km] TLEから導出
    let epochMs = 0;        // TLE元期 [ms]
    let rev0 = 0;           // 元期での周回番号

    function setTLE(line1, line2) {
      if (typeof line1 !== "string" || typeof line2 !== "string" ||
          line1.length < 69 || line2.length < 69) return false;
      const rec = sat.twoline2satrec(line1, line2);
      if (!rec || rec.error !== 0 || !isFinite(rec.no_kozai || rec.no)) return false;
      // 試し伝播で妥当性確認 (パースは通っても NaN を返すケースを弾く)
      const test = sat.propagate(rec, new Date());
      if (!test || !test.position || !isFinite(test.position.x)) return false;

      satrec = rec;
      tle = { line1, line2 };
      const noRadMin = rec.no_kozai || rec.no;            // 平均運動 [rad/min]
      period = (2 * Math.PI / noRadMin) * 60;             // [s]
      const nRadS = noRadMin / 60;
      meanAlt = Math.cbrt(MU / (nRadS * nRadS)) - RE;     // 平均高度 [km]
      epochMs = (rec.jdsatepoch - 2440587.5) * 86400000;  // JD → epoch ms
      rev0 = parseInt(line2.slice(63, 68), 10) || 0;
      return true;
    }
    if (!setTLE(DEFAULT_TLE[0], DEFAULT_TLE[1])) throw new Error("既定TLEの初期化に失敗");

    /* ---- 伝播 ---- */
    let lastGood = { lat: 0, lon: 0, alt: meanAlt, eci: { x: RE + 550, y: 0, z: 0 }, vel: 7.6 };

    function propagate(date) {
      const pv = sat.propagate(satrec, date);
      if (!pv || !pv.position) return lastGood;           // SGP4減衰等の異常時は直前値
      const gmst = sat.gstime(date);
      const geo = sat.eciToGeodetic(pv.position, gmst);
      const v = pv.velocity;
      lastGood = {
        lat: sat.degreesLat(geo.latitude),
        lon: sat.degreesLong(geo.longitude),
        alt: geo.height,
        eci: { x: pv.position.x, y: pv.position.y, z: pv.position.z },
        vel: Math.hypot(v.x, v.y, v.z),
      };
      return lastGood;
    }

    /* 生の状態ベクトル(位置・速度)。ODの初期推定値取得等に使用。異常時は null。 */
    function stateAt(date) {
      const pv = sat.propagate(satrec, date);
      if (!pv || !pv.position || !pv.velocity || !isFinite(pv.position.x)) return null;
      return {
        r: { x: pv.position.x, y: pv.position.y, z: pv.position.z },
        v: { x: pv.velocity.x, y: pv.velocity.y, z: pv.velocity.z },
      };
    }

    /* 地上局からの視線 (az/el/range) */
    function lookAngles(station, date) {
      const pv = sat.propagate(satrec, date);
      if (!pv || !pv.position) return { az: 0, el: -90, range: 1e6 };
      const gmst = sat.gstime(date);
      const ecf = sat.eciToEcf(pv.position, gmst);
      const obs = {
        latitude: station.lat * D2R,
        longitude: station.lon * D2R,
        height: (station.altKm || 0.1),
      };
      const la = sat.ecfToLookAngles(obs, ecf);
      let az = la.azimuth * R2D;
      if (az < 0) az += 360;
      return { az, el: la.elevation * R2D, range: la.rangeSat };
    }

    /* 地上軌跡: date から minutes 分 (負なら過去方向)。日付変更線分割は描画側で行う。 */
    function groundTrack(date, minutes, stepSec = 30) {
      const pts = [];
      const n = Math.abs(minutes * 60 / stepSec);
      const dir = minutes >= 0 ? 1 : -1;
      for (let i = 0; i <= n; i++) {
        const p = propagate(new Date(date.getTime() + dir * i * stepSec * 1000));
        pts.push([p.lat, p.lon]);
      }
      return pts;
    }

    /* ---- パス予測 (粗スキャン30s + 二分法1s) ---- */
    function elAt(station, ms) { return lookAngles(station, new Date(ms)).el; }

    function refineCrossing(station, msLo, msHi, rising) {
      for (let i = 0; i < 24 && msHi - msLo > 1000; i++) {
        const mid = (msLo + msHi) / 2;
        const above = elAt(station, mid) > MIN_EL;
        if (above === rising) msHi = mid; else msLo = mid;
      }
      return (msLo + msHi) / 2;
    }

    function predictPasses(station, fromDate, hours = 24) {
      const passes = [];
      const step = 30 * 1000;
      const end = fromDate.getTime() + hours * 3600 * 1000;
      let t = fromDate.getTime();
      let above = elAt(station, t) > MIN_EL;
      let aosMs = above ? t : null;
      while (t < end) {
        const tn = t + step;
        const aboveN = elAt(station, tn) > MIN_EL;
        if (!above && aboveN) aosMs = refineCrossing(station, t, tn, true);
        if (above && !aboveN && aosMs !== null) {
          passes.push(buildPass(station, aosMs, refineCrossing(station, t, tn, false)));
          aosMs = null;
        }
        above = aboveN; t = tn;
      }
      if (aosMs !== null && above) passes.push(buildPass(station, aosMs, end));
      return passes;
    }

    function buildPass(station, aosMs, losMs) {
      let maxEl = -90, maxElMs = aosMs;
      const n = 60;
      for (let i = 0; i <= n; i++) {
        const ms = aosMs + (losMs - aosMs) * i / n;
        const el = elAt(station, ms);
        if (el > maxEl) { maxEl = el; maxElMs = ms; }
      }
      return {
        station: station.id,
        aos: new Date(aosMs), los: new Date(losMs),
        aosAz: lookAngles(station, new Date(aosMs)).az,
        losAz: lookAngles(station, new Date(losMs)).az,
        maxEl, maxElT: new Date(maxElMs),
        status: "upcoming",
      };
    }

    /* 可視円 (footprint) の中心角半径 [deg] */
    function footprintRadiusDeg(altKm) {
      return Math.acos(RE / (RE + (altKm || meanAlt))) * R2D;
    }

    /* ---- 太陽 (低精度) ---- */
    function sunEciDir(date) {
      const d = (date.getTime() - J2000) / 86400000;
      const L = (280.460 + 0.9856474 * d) % 360;
      const g = ((357.528 + 0.9856003 * d) % 360) * D2R;
      const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
      const eps = 23.439 * D2R;
      return { x: Math.cos(lam), y: Math.cos(eps) * Math.sin(lam), z: Math.sin(eps) * Math.sin(lam) };
    }

    /* 太陽直下点 (昼夜ターミネータ描画用) */
    function sunSubpoint(date) {
      const s = sunEciDir(date);
      const geo = sat.eciToGeodetic({ x: s.x * RE, y: s.y * RE, z: s.z * RE }, sat.gstime(date));
      return { lat: sat.degreesLat(geo.latitude), lon: sat.degreesLong(geo.longitude) };
    }

    /* 衛星が地球の影に入っているか (円筒影モデル) */
    function eclipsed(eci, date) {
      const s = sunEciDir(date);
      const dot = eci.x * s.x + eci.y * s.y + eci.z * s.z;
      if (dot > 0) return false;
      const px = eci.x - dot * s.x, py = eci.y - dot * s.y, pz = eci.z - dot * s.z;
      return Math.hypot(px, py, pz) < RE;
    }

    /* ---- スラスタ噴射(インパルスΔv)の軌道反映 ----
       状態ベクトル(ECI) → 古典軌道要素(rv2coe) → TLE再エンコード → setTLE()。
       オスキュレーティング要素をそのまま新epochの平均要素とみなす簡易近似(SPEC.md §4.3)。 */
    function vSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
    function vScale(a, k) { return { x: a.x * k, y: a.y * k, z: a.z * k }; }
    function vDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
    function vCross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
    function vMag(a) { return Math.hypot(a.x, a.y, a.z); }
    function vUnit(a) { const m = vMag(a); return { x: a.x / m, y: a.y / m, z: a.z / m }; }
    function acosClamp(x) { return Math.acos(Math.max(-1, Math.min(1, x))); }

    /* ---- SGP4 Kozai平均運動 逆変換 ----
       satellite.js (sgp4init の initl 相当) は TLEの生の平均運動 no を J2 摂動で
       「unkozai」補正した上で軌道長半径 ao を計算する。rv2coe で求めた osculating な
       半長径 a (2体近似) をそのまま TLE の平均運動へ変換すると、この補正が欠落し、
       周期にわずかなズレが生じて時間経過で位置誤差が蓄積する(往復変換だけで
       9時間先で100km超の誤差になり得る)。ここでは同じ unkozai 変換を模倣し、
       「補正後の ao が rv2coe の a に一致するような no(Kozai平均運動)」を二分法で
       逆算することで、SGP4伝播との整合性を大きく改善する(OD/applyBurn 共通)。
       SGP4内部の定数系(ER・分単位、J2/xke)をそのまま用いる。 */
    const SGP4_XKE = 60 / Math.sqrt(650942.9922085947); // [(ER)^1.5 / min]
    const SGP4_J2 = 0.001082616;
    const SGP4_RE = 6378.135; // [km] SGP4内部の地球半径(ERの定義)

    /* no(Kozai平均運動, rad/min) → unkozai補正後の ao [ER] (initl のロジック) */
    function unkozaiAo(no, ecco, inclo) {
      const cosio = Math.cos(inclo), theta2 = cosio * cosio;
      const eosq = ecco * ecco, betao2 = 1 - eosq, betao = Math.sqrt(betao2);
      const a1 = Math.pow(SGP4_XKE / no, 2 / 3);
      const del1 = 0.75 * SGP4_J2 * (3 * theta2 - 1) / (betao * betao2);
      const ao = a1 * (1 - del1 * del1 - del1 * (1 / 3 + 134 * del1 * del1 / 81));
      return ao;
    }

    /* 目標の半長径 aTargetKm (osculating, km) に対応する Kozai平均運動 no [rad/min] を
       二分法で逆算 → rev/day を返す。失敗時(非有限等)は null。 */
    function kozaiMeanMotionRevDay(aTargetKm, ecco, inclo) {
      const aTargetEr = aTargetKm / SGP4_RE;
      if (!isFinite(aTargetEr) || aTargetEr <= 0) return null;
      let lo = 1e-5, hi = 0.5; // rad/min: 妥当なLEO~静止軌道の範囲を十分広くカバー
      let loAo = unkozaiAo(lo, ecco, inclo), hiAo = unkozaiAo(hi, ecco, inclo);
      // unkozaiAo は no の減少関数(ao 増加) → lo(小さいno)でao大、hi(大きいno)でao小
      if (!(loAo >= aTargetEr && hiAo <= aTargetEr)) return null;
      for (let iter = 0; iter < 80; iter++) {
        const mid = (lo + hi) / 2;
        const aoMid = unkozaiAo(mid, ecco, inclo);
        if (aoMid > aTargetEr) lo = mid; else hi = mid;
      }
      const noFinal = (lo + hi) / 2; // rad/min
      if (!isFinite(noFinal)) return null;
      return noFinal * 1440 / (2 * Math.PI); // rad/min → rev/day
    }

    /* 状態ベクトル(ECI, km / km/s) → 古典軌道要素(角度はdeg、平均運動はrev/day) */
    function rv2coe(r, v) {
      const rMag = vMag(r), vMagn = vMag(v);
      const h = vCross(r, v), hMag = vMag(h);
      const nvec = { x: -h.y, y: h.x, z: 0 }, nMag = Math.hypot(nvec.x, nvec.y);
      const rdotv = vDot(r, v);
      const eVec = vScale(vSub(vScale(r, vMagn * vMagn - MU / rMag), vScale(v, rdotv)), 1 / MU);
      const e = vMag(eVec);
      const a = -MU / (2 * (vMagn * vMagn / 2 - MU / rMag));
      const i = acosClamp(h.z / hMag);
      let raan = nMag > 1e-9 ? acosClamp(nvec.x / nMag) : 0;
      if (nvec.y < 0) raan = 2 * Math.PI - raan;
      let argp = (nMag > 1e-9 && e > 1e-9) ? acosClamp(vDot(nvec, eVec) / (nMag * e)) : 0;
      if (eVec.z < 0) argp = 2 * Math.PI - argp;
      let nu = e > 1e-9 ? acosClamp(vDot(eVec, r) / (e * rMag)) : 0;
      if (rdotv < 0) nu = 2 * Math.PI - nu;
      let E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
      if (E < 0) E += 2 * Math.PI;
      let M = E - e * Math.sin(E);
      if (M < 0) M += 2 * Math.PI;
      // Kozai平均運動への逆変換(SGP4整合)を優先し、失敗時のみ2体近似にフォールバック
      const nRevDayKozai = kozaiMeanMotionRevDay(a, e, i);
      const nRevDay = (nRevDayKozai !== null && isFinite(nRevDayKozai))
        ? nRevDayKozai
        : Math.sqrt(MU / (a * a * a)) * 86400 / (2 * Math.PI);
      return { a, e, iDeg: i * R2D, raanDeg: (raan * R2D) % 360, argpDeg: (argp * R2D) % 360, mDeg: (M * R2D) % 360, nRevDay };
    }

    /* TLEチェックサム: 数字を合計('-'は1として加算) mod 10 (列1-68が対象) */
    function tleChecksum(s68) {
      let sum = 0;
      for (const ch of s68) {
        if (ch >= "0" && ch <= "9") sum += ch.charCodeAt(0) - 48;
        else if (ch === "-") sum += 1;
      }
      return sum % 10;
    }
    const fmtDeg = (v) => v.toFixed(4).padStart(8, " ");
    const fmtMM = (v) => v.toFixed(8).padStart(11, " ");
    const fmtEcc = (e) => String(Math.round(e * 1e7)).padStart(7, "0");

    /* 古典軌道要素 → TLE行対。epoch以外(NORADID/分類/国際符号/ndot/nddot/bstar/elset番号)は
       既存TLEの値をそのまま継承する(post-burnの抗力係数再フィットは行わない近似)。
       tle(現在のTLE)を元に組み立てるため、そのインスタンスの setTLE 済み状態に依存する。 */
    function coe2tle(coe, epochDate) {
      const year = epochDate.getUTCFullYear();
      const dayFrac = (epochDate.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1;
      const intPart = Math.floor(dayFrac);
      const dayStr = String(intPart).padStart(3, "0") + (dayFrac - intPart).toFixed(8).slice(1);
      const yearStr = String(year % 100).padStart(2, "0");

      let l1 = tle.line1.substring(0, 18) + yearStr + dayStr + tle.line1.substring(32);
      l1 = l1.substring(0, 68) + tleChecksum(l1.substring(0, 68));

      const satnum = tle.line2.substring(2, 7);
      let l2 = "2 " + satnum + " " + fmtDeg(coe.iDeg) + " " + fmtDeg(coe.raanDeg) + " " +
        fmtEcc(coe.e) + " " + fmtDeg(coe.argpDeg) + " " + fmtDeg(coe.mDeg) + " " +
        fmtMM(coe.nRevDay) + tle.line2.substring(63, 68);
      l2 = l2.substring(0, 68) + tleChecksum(l2.substring(0, 68));
      return [l1, l2];
    }

    /* 状態ベクトル(ECI km, km/s) → TLE行対。satrecには適用しない(候補評価専用)。
       e>=1 や非有限値になる場合は null。OD(orbitdet.js)の候補→観測予測に使用。 */
    function tleFromState(r, v, epochDate) {
      if (!r || !v || !isFinite(r.x) || !isFinite(r.y) || !isFinite(r.z) ||
          !isFinite(v.x) || !isFinite(v.y) || !isFinite(v.z)) return null;
      const coe = rv2coe(r, v);
      if (!isFinite(coe.a) || !(coe.e >= 0) || coe.e >= 1 || !isFinite(coe.nRevDay)) return null;
      return coe2tle(coe, epochDate);
    }

    /* スラスタ噴射(インパルスΔv)を軌道に反映する。dvRsw = {radial, along, cross} [km/s]、
       RSW系: radial=地心方向 / along=進行方向 / cross=軌道面法線。 */
    function applyBurn(dvRsw, atDate) {
      const pv = sat.propagate(satrec, atDate);
      if (!pv || !pv.position || !pv.velocity || !isFinite(pv.position.x)) return false;
      const r = pv.position, v = pv.velocity;
      const rHat = vUnit(r);
      const wHat = vUnit(vCross(r, v));
      const sHat = vCross(wHat, rHat);
      const rad = dvRsw.radial || 0, alg = dvRsw.along || 0, crs = dvRsw.cross || 0;
      const v2 = {
        x: v.x + rad * rHat.x + alg * sHat.x + crs * wHat.x,
        y: v.y + rad * rHat.y + alg * sHat.y + crs * wHat.y,
        z: v.z + rad * rHat.z + alg * sHat.z + crs * wHat.z,
      };
      const [l1, l2] = tleFromState(r, v2, atDate) || [];
      if (!l1 || !l2) return false;
      return setTLE(l1, l2);
    }

    return {
      RE, MIN_EL,
      get PERIOD() { return period; },
      get ALT() { return meanAlt; },
      propagate, stateAt, lookAngles, groundTrack, predictPasses,
      footprintRadiusDeg, sunSubpoint, eclipsed,
      orbitNumber: (date) => Math.max(0, rev0 + Math.floor((date.getTime() - epochMs) / 1000 / period)),
      setTLE, getTLE: () => ({ ...tle }),
      tleFromState,
      applyBurn,
    };
  }

  const root = (typeof window !== "undefined") ? window : globalThis;
  root.SCC = root.SCC || {};
  root.SCC.createOrbit = createOrbit;
  root.SCC.orbit = createOrbit();
})();
